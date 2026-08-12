import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { DomainError, EffectiveAriRow, dateRange, nightsBetween } from '@wetriip/contracts';
import { isOfferExpired, verifyOfferSignature } from '@wetriip/domain';
import { toNumber, toStayDateString } from '@wetriip/persistence';
import { PRISMA, RequestContext, clients } from '@wetriip/service-kit';

/**
 * Offer revalidation.
 *
 * Called by the booking saga immediately before a supplier is contacted. Three
 * separate questions, deliberately not collapsed:
 *
 *   1. is this offer ours and unmodified?  (signature)
 *   2. is it still within its promise?     (TTL)
 *   3. is the inventory still there?       (live ARI re-read)
 *
 * Passing 1 and 2 says nothing about 3. Selling on a signed, unexpired offer
 * whose room disappeared four minutes ago is the P0 the audit describes as
 * "offer based on stale ARI".
 */
@Injectable()
export class OfferService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async get(ctx: RequestContext, offerId: string) {
    const offer = await this.prisma.offer.findFirst({
      where: { id: offerId, tenantId: ctx.tenantId },
    });
    if (!offer) {
      throw new DomainError({
        code: 'NOT_FOUND',
        message: `Offer ${offerId} not found`,
        owner: 'Commerce',
      });
    }
    return offer;
  }

  async revalidate(
    ctx: RequestContext,
    offerId: string,
  ): Promise<{
    valid: boolean;
    offer: any;
    checks: Array<{ code: string; ok: boolean; detail: string }>;
  }> {
    const offer = await this.get(ctx, offerId);
    const checks: Array<{ code: string; ok: boolean; detail: string }> = [];

    const signatureOk = verifyOfferSignature(
      {
        offerId: offer.id,
        propertyId: offer.propertyId,
        roomTypeId: offer.roomTypeId,
        ratePlanId: offer.ratePlanId,
        checkIn: toStayDateString(offer.checkIn),
        checkOut: toStayDateString(offer.checkOut),
        adults: offer.adults,
        children: offer.children,
        buyerOrgId: offer.buyerOrgId,
        buyerCurrency: offer.buyerCurrency,
        buyerAmount: toNumber(offer.buyerAmount)!,
        contractId: offer.contractId,
        promotionIds: offer.promotionIds,
        expiresAt: offer.expiresAt.toISOString(),
        version: offer.version,
      },
      offer.signature,
      process.env.OFFER_SIGNING_SECRET ?? 'change-me-in-production',
    );
    checks.push({
      code: 'SIGNATURE',
      ok: signatureOk,
      detail: signatureOk ? 'Offer is authentic and unmodified.' : 'Signature mismatch — offer was altered.',
    });

    const expired = isOfferExpired(offer.expiresAt.toISOString(), new Date());
    checks.push({
      code: 'TTL',
      ok: !expired,
      detail: expired
        ? `Offer expired at ${offer.expiresAt.toISOString()}. Search again.`
        : `Valid until ${offer.expiresAt.toISOString()}.`,
    });

    // Live re-read of the ledger's projection, not of a cache.
    const checkIn = toStayDateString(offer.checkIn);
    const checkOut = toStayDateString(offer.checkOut);
    const stayDates = dateRange(checkIn, checkOut).slice(0, nightsBetween(checkIn, checkOut));
    const cells = await clients.ari.get<EffectiveAriRow[]>(
      `/internal/ari/effective?propertyId=${offer.propertyId}&from=${stayDates[0]}&to=${stayDates[stayDates.length - 1]}&roomTypeIds=${offer.roomTypeId}&ratePlanIds=${offer.ratePlanId}`,
      ctx,
    );

    const missing = stayDates.filter((d) => !cells.some((c) => c.stayDate === d));
    const unavailable = cells.filter((c) => c.available <= 0 || !c.open);
    const inventoryOk = missing.length === 0 && unavailable.length === 0;
    checks.push({
      code: 'INVENTORY',
      ok: inventoryOk,
      detail: inventoryOk
        ? 'Inventory still open and available for every night.'
        : `Unavailable on ${[...missing, ...unavailable.map((c) => c.stayDate)].join(', ')}.`,
    });

    // A price that moved does not block the booking — the signed offer is what
    // we promised the buyer — but it is recorded so reconciliation can see it.
    const currentTotal = cells.reduce((s, c) => s + (c.baseAmount ?? 0), 0);
    const originalNet = toNumber(offer.netAmount) ?? 0;
    const driftPct = originalNet ? Math.round(((currentTotal - originalNet) / originalNet) * 1000) / 10 : 0;
    checks.push({
      code: 'PRICE_DRIFT',
      ok: true,
      detail: `Underlying ARI moved ${driftPct > 0 ? '+' : ''}${driftPct}% since the offer was issued. Honouring the signed price.`,
    });

    return {
      valid: checks.filter((c) => c.code !== 'PRICE_DRIFT').every((c) => c.ok),
      offer,
      checks,
    };
  }
}
