import {
  ContentFetchResult,
  ContentSourceCapabilities,
  ContentSourceKind,
  ContentSourceStatus,
  DomainError,
} from '@wetriip/contracts';

/**
 * Content source registry.
 *
 * Same discipline as the channel-manager adapters: a source declares its
 * capabilities honestly, and one that is not certified fails loudly instead of
 * returning an empty hotel that looks like a hotel with no photos.
 *
 * ── On Booking.com and Expedia ────────────────────────────────────────
 *
 * Neither publishes a content API that a third party may call to pull an
 * arbitrary hotel's profile. That is a licensing position, not a technical
 * gap, and scraping their listings breaches their terms and exposes both us
 * and the hotel.
 *
 * The legitimate routes, all of which need paperwork before code:
 *
 *   · Booking.com Content API — requires the property's own Connectivity
 *     Partner credentials under Booking's partner agreement. The hotel
 *     authorises us; we do not call it on our own account.
 *   · Expedia Rapid / Partner Central — same shape: the property grants
 *     access under an Expedia partner agreement.
 *   · GIATA / Gimmonix — commercial content aggregators. They exist precisely
 *     because this problem is licensing, not scraping, and they are the
 *     fastest legitimate route to multi-source content at scale.
 *   · The channel manager already connected to the hotel, which often carries
 *     descriptive content alongside ARI.
 *
 * So they are registered here, visible in the console with their exact
 * outstanding requirements, and every call fails with NOT_IMPLEMENTED until
 * the agreement and the credentials exist.
 */

export interface ContentSourceDefinition {
  kind: ContentSourceKind;
  displayName: string;
  certified: boolean;
  capabilities: ContentSourceCapabilities;
  /** What must be true before this can be switched on. Shown in the console. */
  requirements: string[];
  fetch(ctx: {
    propertyId: string;
    tenantId: string;
    externalId: string | null;
    credentialsRef: string | null;
    correlationId: string;
  }): Promise<ContentFetchResult>;
}

const NO_CAPABILITIES: ContentSourceCapabilities = {
  fetchProfile: false,
  fetchImages: false,
  fetchRoomContent: false,
  redistributionPermitted: false,
  requiresPropertyOwnedCredentials: true,
  authScheme: 'NONE',
};

function pending(
  kind: ContentSourceKind,
  displayName: string,
  requirements: string[],
  authScheme: ContentSourceCapabilities['authScheme'],
): ContentSourceDefinition {
  return {
    kind,
    displayName,
    certified: false,
    capabilities: { ...NO_CAPABILITIES, authScheme },
    requirements,
    async fetch() {
      throw new DomainError({
        code: 'NOT_IMPLEMENTED',
        message: `${displayName} content import is not enabled.`,
        owner: 'Catalog',
        remediation: requirements.join(' · '),
        details: { kind, requirements },
      });
    },
  };
}

/**
 * The house dialect. Anything that can produce our schema — a partner-side
 * exporter, a migration script, an aggregator we have wrapped — connects
 * through this without bespoke code.
 */
const canonicalJson: ContentSourceDefinition = {
  kind: 'CANONICAL_JSON',
  displayName: 'Canonical JSON import',
  certified: true,
  capabilities: {
    fetchProfile: true,
    fetchImages: true,
    fetchRoomContent: false,
    redistributionPermitted: true,
    requiresPropertyOwnedCredentials: false,
    authScheme: 'API_KEY',
  },
  requirements: [],
  async fetch() {
    // Pull is not the mode for this source: callers POST the payload to the
    // import endpoint. Declaring it here keeps the registry uniform.
    throw new DomainError({
      code: 'VALIDATION',
      message: 'Canonical JSON is a push import. POST the payload to /content/import.',
      owner: 'Catalog',
      remediation: 'Use POST /internal/core/properties/:id/content/import with a canonical body.',
    });
  },
};

export const CONTENT_SOURCES: ContentSourceDefinition[] = [
  canonicalJson,
  pending(
    'BOOKING',
    'Booking.com Content API',
    [
      "Signed Booking.com Connectivity Partner agreement covering content",
      "The property grants access with its own Booking.com credentials",
      'Redistribution rights for images confirmed in writing',
      'Machine account and credential rotation configured in the vault',
    ],
    'OAUTH2',
  ),
  pending(
    'EXPEDIA',
    'Expedia Rapid / Partner Central',
    [
      'Signed Expedia partner agreement covering content retrieval',
      'The property grants access under its Expedia Partner Central account',
      'Image licence terms recorded per asset before publication',
    ],
    'API_KEY',
  ),
  pending(
    'GIATA',
    'GIATA content aggregator',
    [
      'GIATA subscription active',
      'GIATA property id mapped for this hotel',
      'Multi-source content licence covers redistribution to our buyers',
    ],
    'BASIC',
  ),
  pending(
    'GIMMONIX',
    'Gimmonix content and mapping',
    ['Gimmonix subscription active', 'Property mapped to a Gimmonix id'],
    'API_KEY',
  ),
  pending(
    'CHANNEL_MANAGER',
    'Channel manager descriptive content',
    [
      'The connected channel manager adapter declares fetchProfile',
      'Content scope enabled on the existing ARI credentials',
    ],
    'API_KEY',
  ),
];

export function contentSourceStatus(
  propertyId: string,
  source: ContentSourceDefinition,
  config: {
    enabled: boolean;
    lastSyncAt: Date | null;
    lastSyncOk: boolean | null;
    lastSyncDetail: string | null;
  } | null,
): ContentSourceStatus {
  return {
    propertyId,
    kind: source.kind,
    displayName: source.displayName,
    // A source can never report enabled while uncertified, whatever the row says.
    enabled: source.certified && (config?.enabled ?? false),
    certified: source.certified,
    capabilities: source.capabilities,
    lastSyncAt: config?.lastSyncAt?.toISOString() ?? null,
    lastSyncOk: config?.lastSyncOk ?? null,
    lastSyncDetail: config?.lastSyncDetail ?? null,
    requirements: source.requirements,
  };
}
