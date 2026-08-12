import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { DEFAULT_PORTS, SERVICES } from '@wetriip/contracts';
import { bootstrapService } from '@wetriip/service-kit';

import { AgentModule } from '../../agent/src/agent.module';
import { AriIngestionModule } from '../../ari-ingestion/src/ari-ingestion.module';
import { BookingModule } from '../../booking/src/booking.module';
import { ConnectivityModule } from '../../connectivity/src/connectivity.module';
import { CoreCommerceModule } from '../../core-commerce/src/core-commerce.module';
import { GatewayModule } from '../../gateway/src/gateway.module';
import { GroupsModule } from '../../groups/src/groups.module';
import { ReconciliationModule } from '../../reconciliation/src/reconciliation.module';
import { SearchModule } from '../../search/src/search.module';

/**
 * All-in-one host.
 *
 * The SAME service modules, the SAME route prefixes, the SAME HTTP calls
 * between them — just co-located in one process on one port. A laptop or a CI
 * runner gets the whole platform with one command, and nothing about the code
 * differs from the distributed deployment.
 *
 * That is the point: a topology you can only run in production is a topology
 * nobody tests. Services still address each other over HTTP here, so a broken
 * inter-service contract fails locally instead of in staging.
 *
 * It is NOT the production topology. Everything scales and fails together in
 * this mode, which is exactly what the split exists to prevent.
 */
@Module({
  imports: [
    CoreCommerceModule,
    AriIngestionModule,
    ConnectivityModule,
    SearchModule,
    BookingModule,
    GroupsModule,
    AgentModule,
    ReconciliationModule,
    GatewayModule,
  ],
})
class AllInOneModule {}

const port = Number(process.env.PORT ?? DEFAULT_PORTS.gateway);

// Every inter-service client resolves to this process. Setting them here
// rather than in .env keeps the two topologies from drifting apart.
for (const svc of SERVICES) {
  const key = `SVC_${svc.toUpperCase().replace(/-/g, '_')}_URL`;
  process.env[key] = process.env[key] ?? `http://127.0.0.1:${port}`;
}

void bootstrapService({ service: 'all-in-one', module: AllInOneModule, port, cors: true });
