import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { NotificationChannel, NotificationTemplate } from '@wetriip/contracts';
import { Logger } from '@wetriip/observability';
import { LOGGER, PRISMA } from '@wetriip/service-kit';

/**
 * Notification outbox.
 *
 * A hotel that finds out about a group request when it has already lapsed has
 * been failed by the platform, so every state change enqueues a message. What
 * this deliberately does NOT do is pretend to deliver.
 *
 * Email needs SMTP credentials. WhatsApp needs a Meta Business account, a
 * registered sender and a template approved by Meta before a single message may
 * be sent outside a 24-hour customer-service window — an approval that takes
 * days and cannot be faked with an API key. Until those exist the row is stored
 * as NOT_CONFIGURED, carrying the exact requirement, and the console shows it.
 *
 * A stub that logs "sent" and returns 200 is how a hotel learns, three months
 * in, that nobody was ever receiving anything.
 */

export interface NotificationProvider {
  channel: NotificationChannel;
  name: string;
  /** False until real credentials and, for WhatsApp, an approved template exist. */
  configured(): boolean;
  /** What is missing, in the words of whoever has to go and get it. */
  requirement(): string;
  send(msg: { recipient: string; subject: string | null; body: string }): Promise<{ ref: string }>;
}

class SmtpEmailProvider implements NotificationProvider {
  channel: NotificationChannel = 'EMAIL';
  name = 'SMTP';
  configured(): boolean {
    return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
  }
  requirement(): string {
    return 'Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD and SMTP_FROM.';
  }
  async send(): Promise<{ ref: string }> {
    // Reached only when configured() is true; the transport lands with the
    // credentials, not before.
    throw new Error('SMTP transport not implemented — configure a mail relay first.');
  }
}

class WhatsAppCloudProvider implements NotificationProvider {
  channel: NotificationChannel = 'WHATSAPP';
  name = 'WhatsApp Cloud API';
  configured(): boolean {
    return Boolean(
      process.env.WHATSAPP_PHONE_NUMBER_ID &&
        process.env.WHATSAPP_TOKEN &&
        process.env.WHATSAPP_TEMPLATE_GROUP_REQUEST,
    );
  }
  requirement(): string {
    return (
      'Requires a Meta Business account with a verified sender ' +
      '(WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_TOKEN) and a Meta-approved message ' +
      'template name in WHATSAPP_TEMPLATE_GROUP_REQUEST. Business-initiated ' +
      'messages outside the 24-hour window are refused by Meta without one.'
    );
  }
  async send(): Promise<{ ref: string }> {
    throw new Error('WhatsApp transport not implemented — complete the Meta onboarding first.');
  }
}

@Injectable()
export class NotificationService {
  private readonly providers: NotificationProvider[] = [
    new SmtpEmailProvider(),
    new WhatsAppCloudProvider(),
  ];

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LOGGER) private readonly log: Logger,
  ) {}

  /** What each channel can and cannot do right now, stated plainly. */
  capabilities() {
    return this.providers.map((p) => ({
      channel: p.channel,
      provider: p.name,
      configured: p.configured(),
      requirement: p.configured() ? null : p.requirement(),
    }));
  }

  async enqueue(args: {
    tenantId: string;
    correlationId: string;
    requestId?: string;
    template: NotificationTemplate;
    recipients: { channel: NotificationChannel; to: string }[];
    subject: string;
    body: string;
    payload: Record<string, unknown>;
  }): Promise<{ queued: number; notConfigured: number }> {
    let queued = 0;
    let notConfigured = 0;

    for (const r of args.recipients) {
      const provider = this.providers.find((p) => p.channel === r.channel);
      const ready = provider?.configured() ?? false;

      await this.prisma.notification.create({
        data: {
          tenantId: args.tenantId,
          channel: r.channel,
          template: args.template,
          recipient: r.to,
          // WhatsApp has no subject line; carrying one would only mislead
          // whoever reads the queue.
          subject: r.channel === 'WHATSAPP' ? null : args.subject,
          body: args.body,
          payload: args.payload as any,
          status: ready ? 'PENDING' : 'NOT_CONFIGURED',
          provider: provider?.name ?? null,
          requirement: ready ? null : (provider?.requirement() ?? 'No provider registered.'),
          requestId: args.requestId ?? null,
          correlationId: args.correlationId,
        },
      });
      ready ? (queued += 1) : (notConfigured += 1);
    }

    if (notConfigured > 0) {
      this.log.warn('notifications recorded but undeliverable', {
        template: args.template,
        notConfigured,
        correlationId: args.correlationId,
      });
    }
    return { queued, notConfigured };
  }

  /**
   * Drain the PENDING queue. Only runs against configured providers, and a
   * failure is recorded on the row rather than thrown away.
   */
  async dispatch(limit = 50): Promise<{ sent: number; failed: number; skipped: number }> {
    const pending = await this.prisma.notification.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const n of pending) {
      const provider = this.providers.find((p) => p.channel === n.channel);
      if (!provider?.configured()) {
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { status: 'NOT_CONFIGURED', requirement: provider?.requirement() ?? null },
        });
        skipped += 1;
        continue;
      }
      try {
        const res = await provider.send({ recipient: n.recipient, subject: n.subject, body: n.body });
        await this.prisma.notification.update({
          where: { id: n.id },
          data: { status: 'SENT', providerRef: res.ref, sentAt: new Date(), attempts: n.attempts + 1 },
        });
        sent += 1;
      } catch (err) {
        await this.prisma.notification.update({
          where: { id: n.id },
          data: {
            status: n.attempts >= 4 ? 'FAILED' : 'PENDING',
            failureReason: String(err),
            attempts: n.attempts + 1,
          },
        });
        failed += 1;
      }
    }
    return { sent, failed, skipped };
  }

  /**
   * A message with no configured recipient.
   *
   * The sweeper still records that the hotel SHOULD have been told, because a
   * request that lapsed unseen is exactly what the hotel needs to discover.
   * Writing a fake address would make the row look deliverable; naming the gap
   * makes it actionable.
   */
  async recordUnaddressed(args: {
    tenantId: string;
    requestId: string;
    template: NotificationTemplate;
    subject: string;
    body: string;
  }): Promise<void> {
    const provider = this.providers.find((p) => p.channel === 'EMAIL');
    await this.prisma.notification
      .create({
        data: {
          tenantId: args.tenantId,
          channel: 'EMAIL',
          template: args.template,
          recipient: 'no recipient configured',
          subject: args.subject,
          body: args.body,
          payload: { requestId: args.requestId } as any,
          status: 'NOT_CONFIGURED',
          provider: provider?.name ?? null,
          requirement:
            'No notification address is configured for this property. Add one under Grupos → Política.' +
            (provider?.configured() ? '' : ` ${provider?.requirement() ?? ''}`),
          requestId: args.requestId,
          correlationId: `sweep-${args.requestId}`,
        },
      })
      .catch(() => undefined);
  }

  async list(tenantId: string, requestId?: string, limit = 100) {
    return this.prisma.notification.findMany({
      where: { tenantId, ...(requestId ? { requestId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
