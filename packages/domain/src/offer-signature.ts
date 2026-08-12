import { createHmac, timingSafeEqual } from 'node:crypto';
import { stableStringify } from '@wetriip/contracts';

/**
 * Offer integrity.
 *
 * An offer is a promise about a price at a moment in time. Between search and
 * booking, ARI moves, promotions expire and contracts get suspended. Two
 * controls make that safe:
 *
 *  · expiresAt — an offer is only bookable inside its TTL
 *  · signature — an HMAC over exactly the price-determining fields, so a
 *    mutated offer id or amount fails before it reaches a supplier
 *
 * Signature verification is NOT a substitute for re-validating ARI at booking
 * time. It proves the offer is ours and unmodified; it does not prove the room
 * is still there. The booking saga does both.
 */
export interface SignableOffer {
  offerId: string;
  propertyId: string;
  roomTypeId: string;
  ratePlanId: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  children: number;
  buyerOrgId: string;
  buyerCurrency: string;
  buyerAmount: number;
  contractId: string | null;
  promotionIds: string[];
  expiresAt: string;
  version: number;
}

export function signOffer(offer: SignableOffer, secret: string): string {
  const canonical = stableStringify({
    ...offer,
    promotionIds: [...offer.promotionIds].sort(),
  });
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifyOfferSignature(
  offer: SignableOffer,
  signature: string,
  secret: string,
): boolean {
  const expected = signOffer(offer, secret);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature ?? '', 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function isOfferExpired(expiresAt: string, now: Date): boolean {
  return new Date(expiresAt).getTime() <= now.getTime();
}
