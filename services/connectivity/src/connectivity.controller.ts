import { Body, Controller, Get, Headers, Param, Post, Query, Req } from '@nestjs/common';
import { AdapterRegistry, runConformance } from '@wetriip/connectivity-sdk';
import { Provider } from '@wetriip/contracts';
import { Inject } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { ConnectionService } from './connection.service';
import { MappingService } from './mapping.service';

/**
 * Provider webhooks.
 *
 * Public by necessity and therefore authenticated by SIGNATURE, not by a user
 * token — no tenant header, no session. This controller is deliberately
 * separate from the internal one so the different trust model is visible in
 * the route table.
 */
@Controller('webhooks')
export class WebhookController {
  constructor(private readonly connections: ConnectionService) {}

  @Post(':connectionId/ari')
  async ari(
    @Param('connectionId') connectionId: string,
    @Req() req: any,
    @Headers() headers: Record<string, string>,
    @Body() body: unknown,
  ) {
    const rawBody: string = req.rawBody?.toString('utf8') ?? JSON.stringify(body ?? {});
    return this.connections.receivePush({
      connectionId,
      rawBody,
      payload: body,
      headers,
      idempotencyKey: headers['idempotency-key'] ?? null,
    });
  }
}

@Controller('internal/connectivity')
export class ConnectivityController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly mapping: MappingService,
    @Inject('ADAPTER_REGISTRY') private readonly registry: AdapterRegistry,
  ) {}

  @Get('connections')
  list(@Ctx() ctx: RequestContext, @Query('propertyId') propertyId?: string) {
    return this.connections.list(ctx, propertyId);
  }

  @Get('health')
  health(@Ctx() ctx: RequestContext, @Query('propertyId') propertyId?: string) {
    return this.connections.health(ctx, propertyId);
  }

  @Post('connections/:id/health-check')
  healthCheck(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.connections.runHealthCheck(ctx, id);
  }

  @Post('connections/:id/discover')
  discover(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.connections.discover(ctx, id);
  }

  @Post('connections/:id/pull')
  pull(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { from?: string; to?: string },
  ) {
    return this.connections.pull(
      ctx,
      id,
      body?.from && body?.to ? { from: body.from, to: body.to } : undefined,
    );
  }

  @Post('connections/:id/push')
  push(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { commands: any[] }) {
    return this.connections.pushToProvider(ctx, id, body?.commands ?? []);
  }

  @Post('connections/:id/booking')
  createBooking(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: any) {
    return this.connections.createSupplierBooking(ctx, id, body);
  }

  @Post('connections/:id/booking/cancel')
  cancelBooking(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { supplierReference: string; idempotencyKey: string },
  ) {
    return this.connections.cancelSupplierBooking(ctx, id, body.supplierReference, body.idempotencyKey);
  }

  @Get('connections/:id/mappings')
  mappings(@Param('id') id: string) {
    return this.mapping.listVersions(id);
  }

  @Post('connections/:id/mappings')
  createMapping(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { entries: any[]; note?: string },
  ) {
    return this.mapping.createVersion(ctx, id, body?.entries ?? [], body?.note);
  }

  @Post('connections/:id/mappings/:version/publish')
  publishMapping(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    return this.mapping.publishVersion(ctx, id, Number(version));
  }

  /** The registry as the console shows it: who we can talk to, and how far
   *  each integration actually got. */
  @Get('providers')
  providers() {
    return this.registry.list();
  }

  /** Certification gate. A connection should not be enabled until its adapter
   *  reports certified:true here. */
  @Post('providers/:provider/conformance')
  conformance(@Param('provider') provider: string) {
    return runConformance(this.registry.get(provider as Provider));
  }
}
