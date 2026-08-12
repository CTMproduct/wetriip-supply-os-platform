import { ChannelManagerAdapter, DomainError, Provider } from '@wetriip/contracts';

/**
 * Adapter registry.
 *
 * The set of providers we can talk to is data, not a switch statement scattered
 * through the codebase. Resolution failures are explicit errors with the list
 * of what IS registered — an unhelpful "provider not supported" is how
 * onboarding stalls for a day.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<Provider, ChannelManagerAdapter>();

  register(adapter: ChannelManagerAdapter): this {
    this.adapters.set(adapter.provider, adapter);
    return this;
  }

  has(provider: Provider): boolean {
    return this.adapters.has(provider);
  }

  get(provider: Provider): ChannelManagerAdapter {
    const a = this.adapters.get(provider);
    if (!a) {
      throw new DomainError({
        code: 'NOT_IMPLEMENTED',
        message: `No adapter registered for provider ${provider}`,
        owner: 'Connectivity',
        remediation: 'Implement the adapter and pass the conformance suite before enabling it.',
        details: { registered: [...this.adapters.keys()] },
      });
    }
    return a;
  }

  list(): Array<{ provider: Provider; capabilities: ChannelManagerAdapter['capabilities'] }> {
    return [...this.adapters.values()].map((a) => ({
      provider: a.provider,
      capabilities: a.capabilities,
    }));
  }

  /** Capability check before an operation is attempted, so the failure is
   *  "this provider cannot push restrictions" rather than a 500 from their API. */
  assertCapability(provider: Provider, capability: keyof ChannelManagerAdapter['capabilities']): void {
    const a = this.get(provider);
    if (!a.capabilities[capability]) {
      throw new DomainError({
        code: 'NOT_IMPLEMENTED',
        message: `${provider} does not support ${String(capability)}`,
        owner: 'Connectivity',
        remediation:
          'Use the alternative transport for this operation, or negotiate the capability with the provider.',
        details: { provider, capability, capabilities: a.capabilities },
      });
    }
  }
}
