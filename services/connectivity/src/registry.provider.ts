import { Provider as NestProvider } from '@nestjs/common';
import {
  AdapterRegistry,
  CanonicalJsonAdapter,
  ConnectionRuntime,
  MockCmAdapter,
  createPendingAdapters,
} from '@wetriip/connectivity-sdk';

export const ADAPTER_REGISTRY = 'ADAPTER_REGISTRY';
export const CONNECTION_RUNTIME = 'CONNECTION_RUNTIME';

/**
 * The provider fleet.
 *
 * Two adapters are real (MOCK_CM for certification, CANONICAL_JSON for anyone
 * willing to speak our schema). The four named channel managers are registered
 * as explicitly uncertified: they appear in the console with their outstanding
 * checklist instead of silently missing, and every operation on them fails with
 * NOT_IMPLEMENTED rather than returning empty results that look like "no
 * inventory today".
 */
export const registryProviders: NestProvider[] = [
  {
    provide: ADAPTER_REGISTRY,
    useFactory: () => {
      const registry = new AdapterRegistry();
      registry.register(new MockCmAdapter({ unknownRate: 0.05, seed: 42 }));
      registry.register(new CanonicalJsonAdapter());
      for (const pending of createPendingAdapters()) registry.register(pending);
      return registry;
    },
  },
  {
    provide: CONNECTION_RUNTIME,
    useFactory: () => new ConnectionRuntime(),
  },
];
