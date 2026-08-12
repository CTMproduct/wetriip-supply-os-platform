import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { BlockService } from './block.service';
import { EventSpaceService } from './eventspace.service';
import { InventoryService } from './inventory.service';
import { NotificationService } from './notification.service';
import { RequestService } from './request.service';

/** Internal API of the groups service. Only the gateway reaches it. */
@Controller('internal/groups')
export class GroupsController {
  constructor(
    private readonly blocks: BlockService,
    private readonly requests: RequestService,
    private readonly spaces: EventSpaceService,
    private readonly notifications: NotificationService,
    private readonly inventory: InventoryService,
  ) {}

  // ── Blocks ───────────────────────────────────────────────

  @Get('blocks')
  listBlocks(@Ctx() ctx: RequestContext, @Query('propertyId') propertyId?: string) {
    return this.blocks.list(ctx, propertyId);
  }

  @Get('blocks/:id')
  getBlock(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.blocks.get(ctx, id);
  }

  @Post('blocks')
  upsertBlock(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.blocks.upsert(ctx, body);
  }

  // ── Policy ───────────────────────────────────────────────

  @Get('policy/:propertyId')
  getPolicy(@Ctx() ctx: RequestContext, @Param('propertyId') propertyId: string) {
    return this.blocks.getPolicy(ctx, propertyId);
  }

  @Post('policy')
  setPolicy(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.blocks.setPolicy(ctx, body);
  }

  // ── Requests ─────────────────────────────────────────────

  @Get('requests')
  listRequests(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
  ) {
    return this.requests.list(ctx, { propertyId, status, mine: mine === 'true' });
  }

  @Get('requests/:id')
  getRequest(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.requests.get(ctx, id);
  }

  @Post('requests')
  createRequest(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.requests.create(ctx, body);
  }

  @Post('requests/respond')
  respond(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.requests.respond(ctx, body);
  }

  @Post('requests/:id/withdraw')
  withdraw(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.requests.withdraw(ctx, id, body?.reason);
  }

  /** Exposed so the sweep can be driven by a test or an operator, not only by
   *  the timer. A scheduled job you cannot trigger by hand is a job you cannot
   *  debug at 2am. */
  @Post('requests/sweep')
  sweep() {
    return this.requests.sweep();
  }

  /** Retry taking an accepted group's rooms out of sale. The one failure a
   *  hotel must be able to fix immediately, because until it succeeds the
   *  channel manager is still selling committed rooms. */
  @Post('requests/:id/release-inventory')
  releaseInventory(@Param('id') id: string) {
    return this.inventory.release(id);
  }

  @Post('inventory/retry')
  retryReleases() {
    return this.inventory.retryFailed();
  }

  // ── Event spaces ─────────────────────────────────────────

  @Get('spaces')
  listSpaces(@Ctx() ctx: RequestContext, @Query('propertyId') propertyId?: string) {
    return this.spaces.list(ctx, propertyId);
  }

  @Get('spaces/:id')
  getSpace(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.spaces.get(ctx, id);
  }

  @Post('spaces')
  upsertSpace(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.spaces.upsert(ctx, body);
  }

  @Post('spaces/quote')
  quote(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.spaces.quote(ctx, body);
  }

  // ── Notifications ────────────────────────────────────────

  @Get('notifications')
  listNotifications(
    @Ctx() ctx: RequestContext,
    @Query('requestId') requestId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.notifications.list(ctx.tenantId, requestId, Number(limit ?? 100));
  }

  @Get('notifications/capabilities')
  capabilities() {
    return this.notifications.capabilities();
  }

  @Post('notifications/dispatch')
  dispatch() {
    return this.notifications.dispatch();
  }
}
