import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { Ctx, RequestContext } from '@wetriip/service-kit';
import { CatalogService } from './catalog.service';
import { CommercialService } from './commercial.service';
import { ContentService } from './content.service';
import { DistributionService } from './distribution.service';
import { PartnerService } from './partner.service';
import { UserService } from './user.service';

/**
 * Internal API of core-commerce.
 *
 * `/internal/*` is reachable only from inside the service mesh; the gateway is
 * the single component exposed publicly. Keeping the prefix explicit makes an
 * accidental public route obvious in a diff.
 */
@Controller('internal/core')
export class CoreController {
  constructor(
    private readonly catalog: CatalogService,
    private readonly commercial: CommercialService,
    private readonly content: ContentService,
    private readonly distribution: DistributionService,
    private readonly partners: PartnerService,
    private readonly users: UserService,
  ) {}

  @Get('properties')
  listProperties(@Ctx() ctx: RequestContext) {
    return this.catalog.listProperties(ctx);
  }

  @Get('properties/:id')
  getProperty(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.catalog.getProperty(ctx, id);
  }

  @Get('properties/:id/catalog')
  getCatalog(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.catalog.getCatalog(ctx, id);
  }

  @Post('properties/:id/approve')
  approve(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.catalog.approveProperty(ctx, id, body?.reason);
  }

  @Get('organizations')
  organizations(@Ctx() ctx: RequestContext) {
    return this.catalog.listOrganizations(ctx);
  }

  @Get('contracts')
  listContracts(
    @Ctx() ctx: RequestContext,
    @Query('buyerOrgId') buyerOrgId?: string,
    @Query('propertyId') propertyId?: string,
    @Query('status') status?: string,
  ) {
    return this.commercial.listContracts(ctx, { buyerOrgId, propertyId, status });
  }

  @Post('contracts')
  createContract(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.commercial.createContract(ctx, body);
  }

  @Post('contracts/:id/publish')
  publishContract(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.commercial.publishContract(ctx, id);
  }

  @Post('contracts/resolve')
  resolveContract(
    @Ctx() ctx: RequestContext,
    @Body() body: { buyerOrgId: string; propertyId: string; market: string; channel: string; on: string },
  ) {
    return this.commercial.resolveContract(ctx, body);
  }

  // ── Content ──────────────────────────────────────────────

  @Get('properties/:id/content')
  getContent(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Query('locale') locale?: string,
  ) {
    return this.content.effective(ctx, id, locale ?? 'es');
  }

  @Post('properties/:id/content')
  updateContent(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.content.updateManaged(ctx, id, body);
  }

  @Post('properties/:id/content/images')
  addImages(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { images: unknown[] }) {
    return this.content.addImages(ctx, id, body?.images ?? []);
  }

  @Post('properties/:id/content/images/:imageId/remove')
  removeImage(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.content.removeImage(ctx, id, imageId);
  }

  @Get('properties/:id/content/sources')
  contentSources(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.content.listSources(ctx, id);
  }

  @Post('properties/:id/content/import')
  importContent(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { kind: any },
  ) {
    return this.content.importFrom(ctx, id, body.kind);
  }

  // ── Distribution policy ──────────────────────────────────

  @Get('properties/:id/distribution')
  getDistribution(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.distribution.get(ctx, id);
  }

  @Post('properties/:id/distribution')
  setDistribution(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: unknown) {
    return this.distribution.upsert(ctx, id, body);
  }

  @Get('properties/:id/distribution/reach')
  reach(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.distribution.reach(ctx, id);
  }

  @Post('properties/:id/distribution/evaluate')
  evaluateDistribution(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: any,
  ) {
    return this.distribution.evaluate(ctx, id, body);
  }

  // ── Partners and credit ──────────────────────────────────

  @Get('partners')
  listPartners(@Ctx() ctx: RequestContext) {
    return this.partners.list(ctx);
  }

  @Get('partners/:idOrCode')
  partner(@Ctx() ctx: RequestContext, @Param('idOrCode') idOrCode: string) {
    return this.partners.get(ctx, idOrCode);
  }

  @Post('partners')
  upsertPartner(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return this.partners.upsert(ctx, body);
  }

  @Post('partners/:organizationId/credit/decision')
  creditDecision(
    @Ctx() ctx: RequestContext,
    @Param('organizationId') organizationId: string,
    @Body() body: { amount: number; currency: string },
  ) {
    return this.partners.creditDecision(ctx, organizationId, body.amount, body.currency);
  }

  @Post('partners/:organizationId/credit/entries')
  recordCredit(
    @Ctx() ctx: RequestContext,
    @Param('organizationId') organizationId: string,
    @Body() body: any,
  ) {
    return this.partners.recordCredit(ctx, { organizationId, ...body });
  }

  @Get('partners/:organizationId/credit/entries')
  creditHistory(
    @Ctx() ctx: RequestContext,
    @Param('organizationId') organizationId: string,
    @Query('limit') limit?: string,
  ) {
    return this.partners.creditHistory(ctx, organizationId, limit ? Number(limit) : 50);
  }

  // ── Users and permissions ────────────────────────────────

  @Get('users/catalog')
  userCatalog(@Ctx() ctx: RequestContext) {
    return this.users.catalog(ctx);
  }

  @Get('users')
  listUsers(@Ctx() ctx: RequestContext, @Query('organizationId') organizationId?: string) {
    return this.users.list(ctx, organizationId);
  }

  @Get('users/:id')
  getUser(@Ctx() ctx: RequestContext, @Param('id') id: string) {
    return this.users.get(ctx, id);
  }

  @Post('users')
  upsertUser(
    @Ctx() ctx: RequestContext,
    @Body() body: any,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.users.upsert(ctx, body, organizationId);
  }

  @Post('users/:id/status')
  setUserStatus(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { status: 'ACTIVE' | 'DISABLED'; reason?: string },
  ) {
    return this.users.setStatus(ctx, id, body.status, body?.reason);
  }

  @Get('users/resolve/:email')
  resolveUser(@Ctx() ctx: RequestContext, @Param('email') email: string) {
    return this.users.resolveForSession(ctx.tenantId, email);
  }

  @Get('promotions')
  listPromotions(
    @Ctx() ctx: RequestContext,
    @Query('propertyId') propertyId?: string,
    @Query('activeOn') activeOn?: string,
  ) {
    return this.commercial.listPromotions(ctx, { propertyId, activeOn });
  }

  @Post('promotions')
  createPromotion(
    @Ctx() ctx: RequestContext,
    @Body()
    body: { code: string; name: string; definition: unknown; validFrom: string; validTo: string; publish?: boolean },
  ) {
    return this.commercial.createPromotion(ctx, body);
  }

  @Post('promotions/:id/update')
  updatePromotion(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { changes: Record<string, any>; reason?: string },
  ) {
    return this.commercial.updatePromotion(
      ctx,
      id,
      body?.changes ?? {},
      body?.reason ?? 'updated',
    );
  }

  @Post('promotions/:id/status')
  setPromotionStatus(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { status: 'ACTIVE' | 'PAUSED' | 'CANCELLED'; reason?: string },
  ) {
    return this.commercial.setPromotionStatus(ctx, id, body.status, body?.reason ?? 'status change');
  }

  @Post('promotions/:id/rollback')
  rollbackPromotion(
    @Ctx() ctx: RequestContext,
    @Param('id') id: string,
    @Body() body: { toVersion?: number; reason?: string },
  ) {
    return this.commercial.rollbackPromotion(
      ctx,
      id,
      body?.toVersion ?? null,
      body?.reason ?? 'rollback requested',
    );
  }

  @Post('promotions/:id/cancel')
  cancelPromotion(@Ctx() ctx: RequestContext, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.commercial.cancelPromotion(ctx, id, body?.reason ?? 'cancelled');
  }
}
