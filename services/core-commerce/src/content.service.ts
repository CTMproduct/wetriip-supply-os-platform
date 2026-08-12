import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  ContentSourceKind,
  ContentSourceStatus,
  DomainError,
  EffectiveContent,
  EffectiveImage,
  ImageInput,
  ImageInputSchema,
  UpdateContentSchema,
} from '@wetriip/contracts';
import { ContentLayerInput, computeEffectiveContent, imagesSafeToPublish } from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext } from '@wetriip/service-kit';
import { CONTENT_SOURCES, contentSourceStatus } from './content-sources';

/**
 * Property content.
 *
 * The hotel writes into the MANAGED layer; imports land in EXTERNAL. Neither
 * touches the other, and Effective is computed from both. That is the whole
 * design, and it is the same one ARI uses.
 */
@Injectable()
export class ContentService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  async effective(
    ctx: RequestContext,
    propertyId: string,
    locale = 'es',
  ): Promise<EffectiveContent & { withheldImages: Array<{ id: string; reason: string }> }> {
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, tenantId: ctx.tenantId },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Catalog' });
    }

    const [rows, images] = await Promise.all([
      this.prisma.propertyContent.findMany({ where: { propertyId, locale } }),
      this.prisma.propertyImage.findMany({
        where: { propertyId, active: true },
        orderBy: [{ position: 'asc' }],
      }),
    ]);

    const layers: ContentLayerInput[] = rows.map((r) => ({
      layer: r.layer,
      source: r.source as ContentSourceKind,
      updatedAt: r.updatedAt,
      updatedBy: r.updatedBy,
      values: {
        descriptionShort: r.descriptionShort,
        descriptionLong: r.descriptionLong,
        highlights: r.highlights,
        addressLine1: r.addressLine1,
        addressLine2: r.addressLine2,
        postalCode: r.postalCode,
        latitude: r.latitude,
        longitude: r.longitude,
        phone: r.phone,
        email: r.email,
        website: r.website,
        checkInFrom: r.checkInFrom,
        checkInTo: r.checkInTo,
        checkOutBy: r.checkOutBy,
        amenities: r.amenities as any,
        policies: r.policies as any,
      },
    }));

    const mapped: EffectiveImage[] = images.map(toEffectiveImage);
    const { publishable, withheld } = imagesSafeToPublish(mapped);

    const effective = computeEffectiveContent({
      propertyId,
      locale,
      layers,
      images: publishable,
      now: new Date(),
    });

    if (withheld.length) {
      effective.explanation.notes.push(
        `${withheld.length} imported image(s) are held back because their credit or licence is unrecorded.`,
      );
    }

    return { ...effective, withheldImages: withheld };
  }

  /** The hotel writing about itself. Always MANAGED, always versioned. */
  async updateManaged(ctx: RequestContext, propertyId: string, input: unknown) {
    const parsed = UpdateContentSchema.parse(input);
    const property = await this.prisma.property.findFirst({
      where: { id: propertyId, tenantId: ctx.tenantId },
    });
    if (!property) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Property not found', owner: 'Catalog' });
    }

    const before = await this.prisma.propertyContent.findFirst({
      where: { propertyId, layer: 'MANAGED', locale: parsed.locale },
    });

    // A partial edit carries forward everything it did not mention. Sending
    // three fields must not blank the other twelve.
    const merged = { ...(before ? extractValues(before) : {}), ...stripUndefined(parsed.values) };

    const row = await this.prisma.propertyContent.upsert({
      where: {
        propertyId_layer_locale: { propertyId, layer: 'MANAGED', locale: parsed.locale },
      } as any,
      create: {
        tenantId: ctx.tenantId,
        propertyId,
        layer: 'MANAGED',
        source: 'MANUAL',
        locale: parsed.locale,
        ...toDbValues(merged),
        updatedBy: ctx.userId,
      },
      update: {
        ...toDbValues(merged),
        version: { increment: 1 },
        updatedBy: ctx.userId,
      },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'content.updated',
      resourceType: 'PropertyContent',
      resourceId: row.id,
      before: before ? extractValues(before) : null,
      after: merged,
      reason: parsed.reason ?? null,
      correlationId: ctx.correlationId,
    });

    return this.effective(ctx, propertyId, parsed.locale);
  }

  async addImages(ctx: RequestContext, propertyId: string, inputs: unknown[]) {
    const parsed = inputs.map((i) => ImageInputSchema.parse(i));
    const created = await this.prisma.$transaction(
      parsed.map((img: ImageInput) =>
        this.prisma.propertyImage.create({
          data: {
            tenantId: ctx.tenantId,
            propertyId,
            roomTypeId: img.roomTypeId ?? null,
            layer: 'MANAGED',
            source: 'MANUAL',
            url: img.url,
            thumbnailUrl: img.thumbnailUrl ?? null,
            caption: img.caption ?? null,
            category: img.category,
            width: img.width ?? null,
            height: img.height ?? null,
            position: img.position,
            isHero: img.isHero,
            credit: img.credit ?? null,
            licence: img.licence ?? null,
          },
        }),
      ),
    );

    // Exactly one hero, enforced here rather than hoped for.
    const hero = created.find((c) => c.isHero);
    if (hero) {
      await this.prisma.propertyImage.updateMany({
        where: { propertyId, id: { not: hero.id } },
        data: { isHero: false },
      });
    }

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'content.images_added',
      resourceType: 'Property',
      resourceId: propertyId,
      after: { count: created.length },
      correlationId: ctx.correlationId,
    });

    return created.map(toEffectiveImage);
  }

  async removeImage(ctx: RequestContext, propertyId: string, imageId: string) {
    // Deactivated, not deleted — an image referenced by a cached listing should
    // stop being served, not 404.
    const row = await this.prisma.propertyImage.updateMany({
      where: { id: imageId, propertyId, tenantId: ctx.tenantId },
      data: { active: false },
    });
    if (row.count === 0) {
      throw new DomainError({ code: 'NOT_FOUND', message: 'Image not found', owner: 'Catalog' });
    }
    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'content.image_removed',
      resourceType: 'PropertyImage',
      resourceId: imageId,
      correlationId: ctx.correlationId,
    });
    return { removed: true };
  }

  // ── Sources ──────────────────────────────────────────────

  async listSources(ctx: RequestContext, propertyId: string): Promise<ContentSourceStatus[]> {
    const configured = await this.prisma.contentSource.findMany({ where: { propertyId } });
    return CONTENT_SOURCES.map((source) =>
      contentSourceStatus(
        propertyId,
        source,
        configured.find((c) => c.kind === source.kind) ?? null,
      ),
    );
  }

  /**
   * Import content from a source into the EXTERNAL layer.
   *
   * Refuses outright for any source that is not certified. That is not caution
   * for its own sake: Booking and Expedia do not publish a content API a third
   * party may call on a hotel's behalf, and the legitimate routes all require
   * the hotel's own credentials under a partner agreement. Shipping a scraper
   * would put both us and the hotel in breach.
   */
  async importFrom(ctx: RequestContext, propertyId: string, kind: ContentSourceKind) {
    const source = CONTENT_SOURCES.find((s) => s.kind === kind);
    if (!source) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: `Unknown content source ${kind}`,
        owner: 'Catalog',
      });
    }

    const config = await this.prisma.contentSource.findFirst({ where: { propertyId, kind } });
    const result = await source.fetch({
      propertyId,
      tenantId: ctx.tenantId,
      externalId: config?.externalId ?? null,
      credentialsRef: config?.credentialsRef ?? null,
      correlationId: ctx.correlationId,
    });

    const existing = await this.prisma.propertyContent.findFirst({
      where: { propertyId, layer: 'EXTERNAL', locale: 'es' },
    });

    await this.prisma.propertyContent.upsert({
      where: { propertyId_layer_locale: { propertyId, layer: 'EXTERNAL', locale: 'es' } } as any,
      create: {
        tenantId: ctx.tenantId,
        propertyId,
        layer: 'EXTERNAL',
        source: kind,
        locale: 'es',
        ...toDbValues(result.values),
        raw: (result.raw ?? null) as any,
        sourceReference: result.sourceReference,
        sourceUpdatedAt: result.sourceUpdatedAt ? new Date(result.sourceUpdatedAt) : null,
      },
      update: {
        ...toDbValues(result.values),
        raw: (result.raw ?? null) as any,
        sourceReference: result.sourceReference,
        sourceUpdatedAt: result.sourceUpdatedAt ? new Date(result.sourceUpdatedAt) : null,
        version: { increment: 1 },
        receivedAt: new Date(),
      },
    });

    // Imported images are matched on url so a re-import does not duplicate the
    // gallery every night.
    let added = 0;
    for (const img of result.images) {
      const dupe = await this.prisma.propertyImage.findFirst({ where: { propertyId, url: img.url } });
      if (dupe) continue;
      await this.prisma.propertyImage.create({
        data: {
          tenantId: ctx.tenantId,
          propertyId,
          layer: 'EXTERNAL',
          source: kind,
          url: img.url,
          thumbnailUrl: img.thumbnailUrl ?? null,
          caption: img.caption ?? null,
          category: img.category,
          position: img.position,
          credit: img.credit ?? null,
          licence: img.licence ?? null,
        },
      });
      added += 1;
    }

    await this.prisma.contentSource.upsert({
      where: { propertyId_kind: { propertyId, kind } } as any,
      create: {
        tenantId: ctx.tenantId,
        propertyId,
        kind,
        displayName: source.displayName,
        enabled: true,
        lastSyncAt: new Date(),
        lastSyncOk: true,
        lastSyncDetail: `${added} new image(s)`,
      },
      update: { lastSyncAt: new Date(), lastSyncOk: true, lastSyncDetail: `${added} new image(s)` },
    });

    await this.audit.record({
      tenantId: ctx.tenantId,
      actorType: 'USER',
      actorId: ctx.userId,
      action: 'content.imported',
      resourceType: 'Property',
      resourceId: propertyId,
      before: existing ? { version: existing.version } : null,
      after: { source: kind, imagesAdded: added },
      correlationId: ctx.correlationId,
    });

    return { source: kind, imagesAdded: added, effective: await this.effective(ctx, propertyId) };
  }
}

function toEffectiveImage(r: any): EffectiveImage {
  return {
    id: r.id,
    url: r.url,
    thumbnailUrl: r.thumbnailUrl,
    caption: r.caption,
    category: r.category,
    roomTypeId: r.roomTypeId,
    position: r.position,
    isHero: r.isHero,
    layer: r.layer,
    source: r.source,
    credit: r.credit,
    licence: r.licence,
  };
}

function extractValues(r: any) {
  return {
    descriptionShort: r.descriptionShort,
    descriptionLong: r.descriptionLong,
    highlights: r.highlights,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    postalCode: r.postalCode,
    latitude: r.latitude,
    longitude: r.longitude,
    phone: r.phone,
    email: r.email,
    website: r.website,
    checkInFrom: r.checkInFrom,
    checkInTo: r.checkInTo,
    checkOutBy: r.checkOutBy,
    amenities: r.amenities,
    policies: r.policies,
  };
}

function stripUndefined<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Partial<T>;
}

function toDbValues(v: any) {
  return {
    descriptionShort: v.descriptionShort ?? null,
    descriptionLong: v.descriptionLong ?? null,
    highlights: v.highlights ?? [],
    addressLine1: v.addressLine1 ?? null,
    addressLine2: v.addressLine2 ?? null,
    postalCode: v.postalCode ?? null,
    latitude: v.latitude ?? null,
    longitude: v.longitude ?? null,
    phone: v.phone ?? null,
    email: v.email ?? null,
    website: v.website ?? null,
    checkInFrom: v.checkInFrom ?? null,
    checkInTo: v.checkInTo ?? null,
    checkOutBy: v.checkOutBy ?? null,
    amenities: v.amenities ?? [],
    policies: (v.policies ?? null) as any,
  };
}
