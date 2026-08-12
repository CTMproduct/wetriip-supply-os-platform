import { Body, Controller, Get, Headers, Ip, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Inject } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  AriHealthRow,
  ConnectionHealthSnapshot,
  DomainError,
  PropertyRef,
  addDays,
  newCorrelationId,
  serviceBaseUrl,
  toStayDate,
} from '@wetriip/contracts';
import { Permission } from '@wetriip/contracts';
import { assertCan } from '@wetriip/domain';
import { AuditLog } from '@wetriip/persistence';
import { AUDIT_LOG, PRISMA, RequestContext, clients, contextToHeaders } from '@wetriip/service-kit';
import { AuthService } from './auth.service';

/**
 * BFF.
 *
 * Explicit endpoints, not a transparent proxy. Two reasons:
 *  · the console needs composed views (a property workspace is four services)
 *    and doing that composition in the browser is how a page ends up making
 *    nine round trips
 *  · a proxy would let any internal route become public by accident
 *
 * No commercial logic lives here. This file fetches, joins and shapes.
 */
@Controller('api/v1')
export class BffController {
  constructor(
    private readonly auth: AuthService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(AUDIT_LOG) private readonly audit: AuditLog,
  ) {}

  private ctx(authorization?: string, ip?: string, stepUp?: string): RequestContext {
    const token = (authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!token) {
      throw new DomainError({
        code: 'PERMISSION',
        message: 'Missing session token',
        owner: 'Platform Security',
        remediation: 'Sign in first.',
      });
    }
    return this.auth.toContext(this.auth.verify(token), {
      correlationId: newCorrelationId(),
      ip,
      stepUp: String(stepUp ?? '').toLowerCase() === 'true',
    });
  }

  /**
   * Context plus an authority check, in one call.
   *
   * Enforcement lives at the gateway because it is the only component that
   * knows who the caller is. Internal services trust the context headers, and
   * those headers can only originate here.
   */
  private guard(
    permission: Permission,
    authorization?: string,
    ip?: string,
    stepUp?: string,
  ): RequestContext {
    const ctx = this.ctx(authorization, ip, stepUp);
    assertCan(
      {
        userId: ctx.userId,
        tenantId: ctx.tenantId,
        organizationId: ctx.organizationId,
        role: ctx.role as any,
        permissions: ctx.permissions,
        propertyIds: ctx.propertyIds,
        status: ctx.status,
      },
      permission,
    );
    return ctx;
  }

  // ── Session ──────────────────────────────────────────────

  @Post('auth/login')
  login(@Body() body: { email: string }) {
    return this.auth.login(body?.email ?? '');
  }

  @Get('me')
  me(@Headers('authorization') authorization?: string) {
    const ctx = this.ctx(authorization);
    const claims = this.auth.verify((authorization ?? '').replace(/^Bearer\s+/i, ''));
    return {
      name: claims.name,
      email: claims.email,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      role: ctx.role,
      maxAutonomy: ctx.maxAutonomy,
      // The console hides what the caller cannot do. Hiding is courtesy, not
      // security — every one of those routes is still enforced above.
      permissions: ctx.permissions,
      propertyIds: ctx.propertyIds,
      status: ctx.status,
    };
  }

  // ── Home ─────────────────────────────────────────────────

  /**
   * The console home. Not a dashboard of charts — a list of things that need a
   * decision today, each already carrying the command that would fix it.
   */
  @Get('overview')
  async overview(@Headers('authorization') authorization?: string) {
    const ctx = this.ctx(authorization);
    // Promise.allSettled, not Promise.all. A composed view is the one place a
    // single dead upstream can black out a screen that eight other services
    // could still have filled — and "the whole console is down" is how an
    // outage in the agent service becomes an outage in the hotel's day.
    const [properties, connectivity, actions] = await Promise.all([
      settle('properties', () =>
        clients.coreCommerce.get<PropertyRef[]>('/internal/core/properties', ctx),
      ),
      settle('connectivity', () =>
        clients.connectivity.get<ConnectionHealthSnapshot[]>('/internal/connectivity/health', ctx),
      ),
      settle('agent', () => clients.agent.get<any[]>('/internal/agent/actions?limit=5', ctx)),
    ]).then(([p, c, a]) => [p, c, a] as const);

    const degraded = [properties, connectivity, actions]
      .filter((r) => !r.ok)
      .map((r) => ({ section: r.section, reason: r.reason }));

    const from = toStayDate(new Date());
    const to = addDays(from, 30);

    const opportunities: any[] = [];
    for (const conn of connectivity.data ?? []) {
      for (const issue of conn.issues) {
        opportunities.push({
          kind: 'CONNECTIVITY',
          severity: issue.includes('never') || issue.includes('beyond') ? 'CRITICAL' : 'WARNING',
          propertyId: conn.propertyId,
          propertyName: conn.propertyName,
          title: `${conn.provider}: ${issue}`,
          owner: 'Connectivity',
        });
      }
    }

    // A per-property diagnosis is expensive, so the home runs it only for the
    // first few. The rest are reachable from the property list.
    const sample = (properties.data ?? []).slice(0, 3);
    for (const p of sample) {
      try {
        const health = await clients.ari.get<{ rows: AriHealthRow[]; summary: any }>(
          `/internal/ari/health-report?propertyId=${p.id}&from=${from}&to=${to}`,
          ctx,
        );
        for (const row of health.rows.filter((r) => r.status === 'BROKEN' || r.status === 'NO_DATA')) {
          opportunities.push({
            kind: 'ARI',
            severity: 'CRITICAL',
            propertyId: p.id,
            propertyName: p.name,
            title: `${row.roomTypeCode}/${row.ratePlanCode}: ${row.causes[0] ?? row.status}`,
            owner: 'Connectivity',
          });
        }
      } catch {
        // A failing health report must not blank the whole home page.
      }
    }

    return {
      properties: (properties.data ?? []).length,
      approvedProperties: (properties.data ?? []).filter((p) => p.status === 'APPROVED').length,
      connections: (connectivity.data ?? []).length,
      healthyConnections: (connectivity.data ?? []).filter((c) => c.issues.length === 0).length,
      opportunities: opportunities.slice(0, 12),
      recentActions: actions.data ?? [],
      // Named, so the console can say WHICH part is missing instead of
      // rendering a confident zero.
      degraded,
      window: { from, to },
    };
  }

  // ── Catalog ──────────────────────────────────────────────

  @Get('properties')
  properties(@Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get('/internal/core/properties', this.ctx(authorization));
  }

  @Get('properties/:id/workspace')
  async workspace(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    const ctx = this.ctx(authorization);
    const from = toStayDate(new Date());
    const to = addDays(from, 30);
    const [catalog, connections, health, promotions, contracts, blocks, spaces] = await Promise.all([
      settle('catalog', () =>
        clients.coreCommerce.get<any>(`/internal/core/properties/${id}/catalog`, ctx),
      ),
      settle('connections', () =>
        clients.connectivity.get<any>(`/internal/connectivity/health?propertyId=${id}`, ctx),
      ),
      settle('ariHealth', () =>
        clients.ari.get<any>(`/internal/ari/health-report?propertyId=${id}&from=${from}&to=${to}`, ctx),
      ),
      settle('promotions', () =>
        clients.coreCommerce.get<any>(`/internal/core/promotions?propertyId=${id}`, ctx),
      ),
      settle('contracts', () =>
        clients.coreCommerce.get<any>(`/internal/core/contracts?propertyId=${id}`, ctx),
      ),
      settle('groupBlocks', () =>
        clients.groups.get<any>(`/internal/groups/blocks?propertyId=${id}`, ctx),
      ),
      settle('eventSpaces', () =>
        clients.groups.get<any>(`/internal/groups/spaces?propertyId=${id}`, ctx),
      ),
    ]);

    // The catalog IS the page — without it there is no property to render, so
    // that one failure is still fatal and says so with its real cause.
    if (!catalog.ok) {
      throw new DomainError({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'The property catalog is unavailable, so this workspace cannot be built.',
        owner: 'Platform',
        remediation: catalog.reason ?? undefined,
      });
    }

    return {
      ...catalog.data,
      connections: connections.data ?? [],
      ariHealth: health.data ?? null,
      promotions: promotions.data ?? [],
      contracts: contracts.data ?? [],
      groupBlocks: blocks.data ?? [],
      eventSpaces: spaces.data ?? [],
      degraded: [connections, health, promotions, contracts, blocks, spaces]
        .filter((r) => !r.ok)
        .map((r) => ({ section: r.section, reason: r.reason })),
      window: { from, to },
    };
  }

  @Get('properties/:id/calendar')
  calendar(
    @Param('id') id: string,
    @Query('from') from: string,
    @Query('to') to: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.ari.get(
      `/internal/ari/effective?propertyId=${id}&from=${from}&to=${to}`,
      this.ctx(authorization),
    );
  }

  @Get('properties/:id/ledger')
  ledger(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.ari.get(
      `/internal/ari/ledger?propertyId=${id}&limit=${limit ?? 100}`,
      this.ctx(authorization),
    );
  }

  @Get('properties/:id/revenue')
  revenue(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const qs = new URLSearchParams({ propertyId: id });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return clients.search.get(
      `/internal/search/revenue-advisory?${qs}`,
      this.guard('analytics.read', authorization),
    );
  }

  @Get('properties/:id/partners')
  propertyPartnerProduction(
    @Param('id') id: string,
    @Query('sinceDays') sinceDays?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.search.get(
      `/internal/search/partner-production?propertyId=${id}&sinceDays=${sinceDays ?? 90}`,
      this.ctx(authorization),
    );
  }

  @Get('properties/:id/diagnose')
  diagnose(
    @Param('id') id: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const qs = new URLSearchParams({ propertyId: id });
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return clients.search.get(`/internal/search/diagnose?${qs}`, this.ctx(authorization));
  }

  @Post('properties/:id/approve')
  approve(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/approve`,
      this.guard('property.approve', authorization),
      body,
    );
  }

  // ── Connectivity ─────────────────────────────────────────

  @Get('connectivity/health')
  connectivityHealth(
    @Query('propertyId') propertyId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.connectivity.get(
      `/internal/connectivity/health${propertyId ? `?propertyId=${propertyId}` : ''}`,
      this.ctx(authorization),
    );
  }

  @Get('connectivity/providers')
  providers(@Headers('authorization') authorization?: string) {
    return clients.connectivity.get('/internal/connectivity/providers', this.ctx(authorization));
  }

  @Post('connectivity/providers/:provider/conformance')
  conformance(@Param('provider') provider: string, @Headers('authorization') authorization?: string) {
    return clients.connectivity.post(
      `/internal/connectivity/providers/${provider}/conformance`,
      this.ctx(authorization),
    );
  }

  @Post('connectivity/connections/:id/pull')
  pull(
    @Param('id') id: string,
    @Body() body: { from?: string; to?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return clients.connectivity.post(
      `/internal/connectivity/connections/${id}/pull`,
      this.guard('connectivity.sync', authorization),
      body,
      120_000,
    );
  }

  @Post('connectivity/connections/:id/health-check')
  healthCheck(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.connectivity.post(
      `/internal/connectivity/connections/${id}/health-check`,
      this.guard('connectivity.sync', authorization),
    );
  }

  // ── Commercial ───────────────────────────────────────────

  // ── Content, distribution, partners, demand ──────────────

  @Get('properties/:id/content')
  propertyContent(
    @Param('id') id: string,
    @Query('locale') locale?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.get(
      `/internal/core/properties/${id}/content?locale=${locale ?? 'es'}`,
      this.ctx(authorization),
    );
  }

  @Post('properties/:id/content')
  updateContent(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/content`,
      this.guard('content.write', authorization),
      body,
    );
  }

  @Post('properties/:id/content/images')
  addImages(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/content/images`,
      this.guard('content.write', authorization),
      body,
    );
  }

  @Post('properties/:id/content/images/:imageId/remove')
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/content/images/${imageId}/remove`,
      this.guard('content.write', authorization),
      {},
    );
  }

  @Get('properties/:id/content/sources')
  contentSources(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get(
      `/internal/core/properties/${id}/content/sources`,
      this.ctx(authorization),
    );
  }

  @Post('properties/:id/content/import')
  importContent(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/content/import`,
      this.guard('content.write', authorization),
      body,
      120_000,
    );
  }

  @Get('properties/:id/distribution')
  distributionPolicy(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get(
      `/internal/core/properties/${id}/distribution`,
      this.ctx(authorization),
    );
  }

  @Post('properties/:id/distribution')
  setDistribution(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/properties/${id}/distribution`,
      this.guard('distribution.write', authorization),
      body,
    );
  }

  @Get('properties/:id/distribution/reach')
  distributionReach(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get(
      `/internal/core/properties/${id}/distribution/reach`,
      this.ctx(authorization),
    );
  }

  @Get('properties/:id/demand')
  propertyDemand(
    @Param('id') id: string,
    @Query('days') days?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.search.get(
      `/internal/search/property-demand?propertyId=${id}&days=${days ?? 30}`,
      this.ctx(authorization),
    );
  }

  @Get('travel-flow')
  travelFlow(
    @Query('direction') direction: string,
    @Query('anchor') anchor: string,
    @Query('days') days?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.search.get(
      `/internal/search/travel-flow?direction=${direction ?? 'OUTBOUND'}&anchor=${anchor}&days=${days ?? 30}`,
      this.ctx(authorization),
    );
  }

  @Get('partners')
  partnerDirectory(@Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get('/internal/core/partners', this.ctx(authorization));
  }

  @Post('partners')
  upsertPartner(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    return clients.coreCommerce.post('/internal/core/partners', this.guard('partners.write', authorization), body);
  }

  @Get('partners/:organizationId/credit')
  partnerCredit(
    @Param('organizationId') organizationId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.get(
      `/internal/core/partners/${organizationId}/credit/entries`,
      this.ctx(authorization),
    );
  }

  // ── Groups ───────────────────────────────────────────────

  @Get('groups/blocks')
  groupBlocks(
    @Query('propertyId') propertyId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.get(
      `/internal/groups/blocks${propertyId ? `?propertyId=${propertyId}` : ''}`,
      this.guard('groups.read', authorization),
    );
  }

  @Post('groups/blocks')
  upsertGroupBlock(
    @Body() body: unknown,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      '/internal/groups/blocks',
      this.guard('groups.write', authorization, ip),
      body,
    );
  }

  @Get('groups/policy/:propertyId')
  groupPolicy(
    @Param('propertyId') propertyId: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.get(
      `/internal/groups/policy/${propertyId}`,
      this.guard('groups.read', authorization),
    );
  }

  @Post('groups/policy')
  setGroupPolicy(
    @Body() body: unknown,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      '/internal/groups/policy',
      this.guard('groups.write', authorization, ip),
      body,
    );
  }

  @Get('groups/requests')
  groupRequests(
    @Query('propertyId') propertyId?: string,
    @Query('status') status?: string,
    @Query('mine') mine?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const qs = new URLSearchParams();
    if (propertyId) qs.set('propertyId', propertyId);
    if (status) qs.set('status', status);
    if (mine) qs.set('mine', mine);
    return clients.groups.get(
      `/internal/groups/requests?${qs.toString()}`,
      this.guard('groups.read', authorization),
    );
  }

  @Get('groups/requests/:id')
  groupRequest(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.groups.get(
      `/internal/groups/requests/${id}`,
      this.guard('groups.read', authorization),
    );
  }

  /** The buying side. An agency holds groups.negotiate for its own requests;
   *  the service scopes it to their organization. */
  @Post('groups/requests')
  createGroupRequest(
    @Body() body: unknown,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      '/internal/groups/requests',
      this.guard('groups.negotiate', authorization, ip),
      body,
    );
  }

  /**
   * The hotel's answer. Step-up is carried through because accepting a group
   * commits rooms and money — the same bar as any HIGH-risk agent action.
   */
  @Post('groups/requests/respond')
  respondGroupRequest(
    @Body() body: unknown,
    @Ip() ip?: string,
    @Headers('x-wetriip-step-up') stepUp?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      '/internal/groups/requests/respond',
      this.guard('groups.negotiate', authorization, ip, stepUp),
      body,
    );
  }

  @Post('groups/requests/:id/withdraw')
  withdrawGroupRequest(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      `/internal/groups/requests/${id}/withdraw`,
      this.guard('groups.negotiate', authorization, ip),
      body,
    );
  }

  /**
   * Retry taking an accepted group's rooms out of sale.
   *
   * Gated on `groups.negotiate` rather than `availability.write`: the person who
   * committed the rooms is the person who must be able to finish committing
   * them. The decrement itself runs as the system, because it is a consequence
   * of the commitment and not a discretionary write.
   */
  @Post('groups/requests/:id/release-inventory')
  releaseGroupInventory(
    @Param('id') id: string,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      `/internal/groups/requests/${id}/release-inventory`,
      this.guard('groups.negotiate', authorization, ip),
      {},
    );
  }

  @Get('groups/notifications')
  groupNotifications(
    @Query('requestId') requestId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.get(
      `/internal/groups/notifications${requestId ? `?requestId=${requestId}` : ''}`,
      this.guard('groups.read', authorization),
    );
  }

  @Get('groups/notifications/capabilities')
  notificationCapabilities(@Headers('authorization') authorization?: string) {
    return clients.groups.get(
      '/internal/groups/notifications/capabilities',
      this.guard('groups.read', authorization),
    );
  }

  // ── Event spaces ─────────────────────────────────────────

  @Get('event-spaces')
  eventSpaces(
    @Query('propertyId') propertyId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.get(
      `/internal/groups/spaces${propertyId ? `?propertyId=${propertyId}` : ''}`,
      this.guard('events.read', authorization),
    );
  }

  @Post('event-spaces')
  upsertEventSpace(
    @Body() body: unknown,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.groups.post(
      '/internal/groups/spaces',
      this.guard('events.write', authorization, ip),
      body,
    );
  }

  @Post('event-spaces/quote')
  quoteEventSpace(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    return clients.groups.post(
      '/internal/groups/spaces/quote',
      this.guard('events.read', authorization),
      body,
    );
  }

  // ── Users and permissions ────────────────────────────────

  @Get('users/catalog')
  userCatalog(@Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get('/internal/core/users/catalog', this.ctx(authorization));
  }

  @Get('users')
  users(
    @Query('organizationId') organizationId?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.get(
      `/internal/core/users${organizationId ? `?organizationId=${organizationId}` : ''}`,
      this.guard('users.read', authorization),
    );
  }

  @Post('users')
  upsertUser(
    @Body() body: unknown,
    @Query('organizationId') organizationId?: string,
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/users${organizationId ? `?organizationId=${organizationId}` : ''}`,
      this.guard('users.manage', authorization, ip),
      body,
    );
  }

  @Post('users/:id/status')
  setUserStatus(
    @Param('id') id: string,
    @Body() body: { status: 'ACTIVE' | 'DISABLED'; reason?: string },
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.coreCommerce.post(
      `/internal/core/users/${id}/status`,
      this.guard('users.manage', authorization, ip),
      body,
    );
  }

  // ── Platform administration (Wetriip staff) ──────────────

  /**
   * What every tenant is doing, in one place.
   *
   * Gated on `platform.activity.read`, which no hotel role can hold and which a
   * hotel administrator is forbidden from granting. Wetriip needs full sight of
   * the platform; a hotel must never be able to award itself the same view.
   */
  @Get('admin/activity')
  async adminActivity(
    @Query('limit') limit?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const ctx = this.guard('platform.activity.read', authorization);
    const rows = await this.prisma.auditEvent.findMany({
      orderBy: { id: 'desc' },
      take: Math.min(Number(limit ?? 100), 500),
    });
    return rows.map((r) => ({ ...r, id: r.id.toString() }));
  }

  @Get('admin/tenants')
  async adminTenants(@Headers('authorization') authorization?: string) {
    this.guard('platform.tenants.read', authorization);
    const tenants = await this.prisma.tenant.findMany({
      include: {
        _count: { select: { organizations: true, properties: true, users: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return tenants.map((t) => ({
      id: t.id,
      code: t.code,
      name: t.name,
      organizations: t._count.organizations,
      properties: t._count.properties,
      users: t._count.users,
      createdAt: t.createdAt.toISOString(),
    }));
  }

  @Get('admin/users')
  async adminUsers(@Headers('authorization') authorization?: string) {
    this.guard('platform.impersonate.read', authorization);
    const rows = await this.prisma.user.findMany({
      include: { organization: true, tenant: true },
      orderBy: [{ tenantId: 'asc' }, { name: 'asc' }],
      take: 500,
    });
    return rows.map((u) => ({
      id: u.id,
      tenant: u.tenant.code,
      organization: u.organization.name,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      maxAutonomy: u.maxAutonomy,
      grants: u.grants,
      revokes: u.revokes,
      lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
    }));
  }

  @Get('promotions')
  promotions(@Query('propertyId') propertyId: string, @Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get(
      `/internal/core/promotions?propertyId=${propertyId}`,
      this.ctx(authorization),
    );
  }

  @Get('contracts')
  contracts(@Headers('authorization') authorization?: string) {
    return clients.coreCommerce.get('/internal/core/contracts', this.ctx(authorization));
  }

  // ── Demand ───────────────────────────────────────────────

  @Post('search')
  search(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    return clients.search.post('/internal/search', this.ctx(authorization), body, 60_000);
  }

  @Post('bookings')
  book(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    return clients.booking.post('/internal/booking', this.ctx(authorization), body, 60_000);
  }

  @Get('bookings')
  bookings(@Query('propertyId') propertyId?: string, @Headers('authorization') authorization?: string) {
    return clients.booking.get(
      `/internal/booking${propertyId ? `?propertyId=${propertyId}` : ''}`,
      this.ctx(authorization),
    );
  }

  // ── Agent ────────────────────────────────────────────────

  /**
   * Streams the assistant turn straight through to the browser.
   *
   * A proxy that buffered here would undo the point of streaming, so the
   * upstream body is piped chunk by chunk and the anti-buffering headers are
   * set on both hops.
   */
  @Post('agent/chat/stream')
  async chatStream(
    @Body() body: unknown,
    @Ip() ip: string,
    @Res() res: Response,
    @Headers('authorization') authorization?: string,
  ) {
    const ctx = this.guard('agent.use', authorization, ip);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    try {
      const upstream = await fetch(`${serviceBaseUrl('agent')}/internal/agent/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...contextToHeaders(ctx) },
        body: JSON.stringify(body),
      });

      if (!upstream.ok || !upstream.body) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            code: 'DEPENDENCY_UNAVAILABLE',
            message: `The assistant service responded ${upstream.status}.`,
          })}\n\n`,
        );
        return res.end();
      }

      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } catch (err) {
      res.write(
        `data: ${JSON.stringify({
          type: 'error',
          code: 'DEPENDENCY_UNAVAILABLE',
          message: err instanceof Error ? err.message : 'The assistant is unreachable.',
        })}\n\n`,
      );
      res.end();
    }
  }

  @Get('agent/chat/sessions')
  chatSessions(@Headers('authorization') authorization?: string) {
    return clients.agent.get('/internal/agent/chat/sessions', this.ctx(authorization));
  }

  @Get('agent/chat/sessions/:id')
  chatThread(@Param('id') id: string, @Headers('authorization') authorization?: string) {
    return clients.agent.get(`/internal/agent/chat/sessions/${id}`, this.ctx(authorization));
  }

  @Get('agent/capabilities')
  agentCapabilities(@Headers('authorization') authorization?: string) {
    return clients.agent.get('/internal/agent/capabilities', this.ctx(authorization));
  }

  @Post('agent/ask')
  ask(
    @Body() body: unknown,
    @Ip() ip: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.agent.post('/internal/agent/ask', this.ctx(authorization, ip), body, 60_000);
  }

  @Post('agent/actions/:id/confirm')
  confirm(
    @Param('id') id: string,
    @Ip() ip: string,
    @Headers('authorization') authorization?: string,
    @Headers('x-wetriip-step-up') stepUp?: string,
  ) {
    return clients.agent.post(
      `/internal/agent/actions/${id}/confirm`,
      this.guard('agent.execute', authorization, ip, stepUp),
      {},
      120_000,
    );
  }

  @Post('agent/actions/:id/reject')
  reject(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Headers('authorization') authorization?: string,
  ) {
    return clients.agent.post(`/internal/agent/actions/${id}/reject`, this.ctx(authorization), body);
  }

  @Post('agent/actions/:id/rollback')
  rollback(
    @Param('id') id: string,
    @Body() body: { reason?: string },
    @Ip() ip?: string,
    @Headers('authorization') authorization?: string,
  ) {
    return clients.agent.post(
      `/internal/agent/actions/${id}/rollback`,
      this.guard('agent.rollback', authorization, ip),
      body,
      60_000,
    );
  }

  @Get('agent/actions')
  actions(@Query('limit') limit?: string, @Headers('authorization') authorization?: string) {
    return clients.agent.get(`/internal/agent/actions?limit=${limit ?? 50}`, this.ctx(authorization));
  }

  // ── Reconciliation & audit ───────────────────────────────

  @Post('reconciliation/run')
  reconcile(@Body() body: unknown, @Headers('authorization') authorization?: string) {
    return clients.reconciliation.post(
      '/internal/reconciliation/run',
      this.guard('connectivity.sync', authorization),
      body,
      120_000,
    );
  }

  @Get('reconciliation/runs')
  reconRuns(@Headers('authorization') authorization?: string) {
    return clients.reconciliation.get('/internal/reconciliation/runs', this.ctx(authorization));
  }

  @Get('audit')
  async auditTrail(
    @Query('limit') limit?: string,
    @Query('resourceType') resourceType?: string,
    @Headers('authorization') authorization?: string,
  ) {
    const ctx = this.guard('audit.read', authorization);
    return this.audit.list(ctx.tenantId, {
      limit: limit ? Number(limit) : 100,
      resourceType,
    });
  }
}

/**
 * Run one upstream call and report the outcome instead of throwing.
 *
 * The section name travels with the failure so the console can say "promotions
 * are unavailable" rather than showing an empty list that looks like a hotel
 * with no promotions. An empty state and a broken state must never render the
 * same — the audit named that ambiguity as a real operational cost.
 */
async function settle<T>(
  section: string,
  run: () => Promise<T>,
): Promise<{ section: string; ok: boolean; data: T | null; reason: string | null }> {
  try {
    return { section, ok: true, data: await run(), reason: null };
  } catch (err) {
    const reason =
      err instanceof DomainError ? err.message : `${section} is not responding right now.`;
    return { section, ok: false, data: null, reason };
  }
}
