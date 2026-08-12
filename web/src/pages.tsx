import { useEffect, useState } from 'react';
import { ApiFailure, addDays, api, iso, money, relativeAge } from './api';
import { CopilotContext } from './Copilot';
import { ContentTab, DemandTab, DistributionTab } from './property-extra';

/* ═══════════════════════════════════════════════════════════
 * OVERVIEW
 * Not a dashboard of charts. A list of things that need a decision today,
 * each already carrying who owns it.
 * ═══════════════════════════════════════════════════════════ */
export function OverviewPage({ onOpenProperty }: { onOpenProperty: (id: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .overview()
      .then(setData)
      .catch((e) => setError(e instanceof ApiFailure ? e.error.message : String(e)));
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">Loading…</div>;

  const critical = data.opportunities.filter((o: any) => o.severity === 'CRITICAL').length;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 19 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>{greeting}.</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        {data.opportunities.length === 0
          ? 'Nothing needs your attention across the portfolio.'
          : `${data.opportunities.length} item(s) need a decision${critical ? `, ${critical} of them blocking` : ''}.`}
      </p>

      <div className="grid grid-4" style={{ marginBottom: 18 }}>
        <Stat value={data.properties} label="Properties" />
        <Stat value={data.approvedProperties} label="Approved" />
        <Stat value={`${data.healthyConnections}/${data.connections}`} label="Healthy connections" />
        <Stat value={critical} label="Blocking issues" tone={critical ? 'danger' : 'success'} />
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-header">
            <h3>Needs a decision</h3>
            <span className="badge brand">✦ detected by Wetriip</span>
          </div>
          {data.opportunities.length === 0 && <div className="empty">Everything is healthy.</div>}
          {data.opportunities.map((o: any, i: number) => (
            <div className="opportunity" key={i}>
              <span className={`dot ${o.severity === 'CRITICAL' ? 'critical' : 'warning'}`} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{o.title}</div>
                <div className="caption">
                  {o.propertyName} · owner: {o.owner}
                </div>
              </div>
              <button className="btn-sm" onClick={() => onOpenProperty(o.propertyId)}>
                Review
              </button>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-header">
            <h3>Recent agent actions</h3>
          </div>
          {data.recentActions.length === 0 && <div className="empty">No agent activity yet.</div>}
          {data.recentActions.map((a: any) => (
            <div className="opportunity" key={a.id}>
              <span
                className={`dot ${a.status === 'EXECUTED' ? 'info' : a.status === 'REJECTED' ? 'critical' : 'warning'}`}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.utterance}
                </div>
                <div className="caption">
                  {a.agent} · {a.status} · {a.deterministicIntent ? 'grammar' : (a.modelId ?? 'model')}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ value, label, tone }: { value: any; label: string; tone?: string }) {
  return (
    <div className="stat">
      <div
        className="stat-value"
        style={{ color: tone === 'danger' ? 'var(--color-danger)' : tone === 'success' ? 'var(--color-success)' : undefined }}
      >
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
 * PROPERTY WORKSPACE
 * ═══════════════════════════════════════════════════════════ */
export function PropertyWorkspace({
  propertyId,
  onContext,
  onBack,
}: {
  propertyId: string;
  onContext: (ctx: CopilotContext) => void;
  onBack: () => void;
}) {
  const [ws, setWs] = useState<any>(null);
  const [tab, setTab] = useState<
    'calendar' | 'profile' | 'distribution' | 'demand' | 'health' | 'diagnose' | 'promotions' | 'ledger'
  >('calendar');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .workspace(propertyId)
      .then(setWs)
      .catch((e) => setError(e instanceof ApiFailure ? e.error.message : String(e)));
    onContext({ propertyId });
    return () => onContext({});
  }, [propertyId]);

  if (error) return <div className="empty">{error}</div>;
  if (!ws) return <div className="empty">Loading…</div>;

  const conn = ws.connections?.[0];
  const health = ws.ariHealth?.summary ?? {};

  return (
    <>
      <button className="btn-sm" onClick={onBack} style={{ marginBottom: 12 }}>
        ← Properties
      </button>
      <div className="spread" style={{ marginBottom: 6 }}>
        <h1>{ws.property.name}</h1>
      </div>
      <div className="row wrap" style={{ marginBottom: 20 }}>
        {/* Four separate badges, deliberately. The audit's sharpest finding was
            that a single "Approved" badge is read as operational health. */}
        <span className={`badge ${ws.property.status === 'APPROVED' ? 'success' : 'warning'}`}>
          Approval: {ws.property.status}
        </span>
        <span className={`badge ${conn?.issues?.length ? 'danger' : 'success'}`}>
          Connection: {conn ? (conn.issues.length ? `${conn.issues.length} issue(s)` : 'healthy') : 'none'}
        </span>
        <span className={`badge ${health.broken || health.noData ? 'danger' : health.degraded ? 'warning' : 'success'}`}>
          ARI: {health.healthy ?? 0} healthy / {health.combinations ?? 0}
        </span>
        <span className={`badge ${ws.contracts?.some((c: any) => c.status === 'PUBLISHED') ? 'success' : 'warning'}`}>
          Contracts: {ws.contracts?.filter((c: any) => c.status === 'PUBLISHED').length ?? 0} published
        </span>
      </div>

      <div className="tabs">
        {(
          [
            'calendar',
            'profile',
            'distribution',
            'demand',
            'health',
            'diagnose',
            'promotions',
            'ledger',
          ] as const
        ).map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'diagnose' ? 'Why am I not selling?' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'calendar' && <CalendarTab ws={ws} onContext={onContext} />}
      {tab === 'profile' && <ContentTab propertyId={propertyId} />}
      {tab === 'distribution' && <DistributionTab propertyId={propertyId} />}
      {tab === 'demand' && <DemandTab propertyId={propertyId} />}
      {tab === 'health' && <HealthTab ws={ws} />}
      {tab === 'diagnose' && <DiagnoseTab propertyId={propertyId} />}
      {tab === 'promotions' && <PromotionsTab propertyId={propertyId} />}
      {tab === 'ledger' && <LedgerTab propertyId={propertyId} />}
    </>
  );
}

function CalendarTab({ ws, onContext }: { ws: any; onContext: (c: CopilotContext) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [room, setRoom] = useState(ws.roomTypes[0]?.id ?? '');
  const [plan, setPlan] = useState(ws.ratePlans[0]?.id ?? '');
  const [selected, setSelected] = useState<string[]>([]);
  const from = iso(new Date());
  const to = addDays(34);

  useEffect(() => {
    api.calendar(ws.property.id, from, to).then(setRows).catch(() => setRows([]));
  }, [ws.property.id]);

  useEffect(() => {
    onContext({
      propertyId: ws.property.id,
      roomTypeCode: ws.roomTypes.find((r: any) => r.id === room)?.code ?? null,
      ratePlanCode: ws.ratePlans.find((p: any) => p.id === plan)?.code ?? null,
      selectedDates: selected.length ? selected : null,
    });
  }, [room, plan, selected]);

  if (!rows) return <div className="empty">Loading inventory…</div>;

  const cells = rows.filter((r) => r.roomTypeId === room && r.ratePlanId === plan);
  const byDate = new Map(cells.map((c) => [c.stayDate, c]));
  const days: string[] = [];
  for (let i = 0; i < 35; i++) days.push(addDays(i));
  const leadingBlanks = new Date(`${days[0]}T00:00:00Z`).getUTCDay();

  return (
    <>
      <div className="card">
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <select value={room} onChange={(e) => setRoom(e.target.value)} style={{ width: 200 }}>
            {ws.roomTypes.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.code} · {r.name}
              </option>
            ))}
          </select>
          <select value={plan} onChange={(e) => setPlan(e.target.value)} style={{ width: 220 }}>
            {ws.ratePlans.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.code} · {p.name}
              </option>
            ))}
          </select>
          {selected.length > 0 && (
            <>
              <span className="badge brand">{selected.length} date(s) selected</span>
              <span className="caption">
                Ask the copilot: “pon 3 noches mínimo aquí”
              </span>
              <button className="btn-sm" onClick={() => setSelected([])}>
                Clear
              </button>
            </>
          )}
        </div>

        {cells.length === 0 ? (
          <div className="empty">
            No inventory for this room and rate plan in the next 35 days.
            <div className="caption" style={{ marginTop: 6 }}>
              This is a real state, not an empty table: the connection has never delivered ARI for
              this combination. Check Connectivity.
            </div>
          </div>
        ) : (
          <div className="cal">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div className="cal-head" key={i}>
                {d}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }).map((_, i) => (
              <div className="cal-cell empty" key={`b${i}`} />
            ))}
            {days.map((d) => {
              const cell = byDate.get(d);
              const isSelected = selected.includes(d);
              const managed = cell?.explanation?.layersPresent?.includes('MANAGED');
              return (
                <button
                  key={d}
                  className={`cal-cell ${isSelected ? 'selected' : ''} ${cell && !cell.open ? 'closed' : ''} ${cell?.stale ? 'stale' : ''} ${!cell ? 'empty' : ''}`}
                  onClick={() =>
                    cell &&
                    setSelected((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))
                  }
                >
                  <span className="cal-date">{d.slice(8)}</span>
                  {cell ? (
                    <>
                      <span className="cal-price">
                        {money(cell.baseAmount, cell.currency ?? 'COP')}
                      </span>
                      <span className="cal-meta">
                        {cell.available} rms{cell.minLos > 1 ? ` · ${cell.minLos}N` : ''}
                        {cell.closedToArrival ? ' · CTA' : ''}
                      </span>
                      {managed && <span className="override">✦ override</span>}
                      {!cell.open && <span className="cal-meta" style={{ color: 'var(--color-danger)' }}>closed</span>}
                    </>
                  ) : (
                    <span className="cal-meta">no data</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="card">
        <div className="caption">
          Yellow = past the freshness SLA. Red = closed. ✦ = a managed override is in effect; the
          supplier's own value is preserved underneath and reappears when the override expires.
        </div>
      </div>
    </>
  );
}

function HealthTab({ ws }: { ws: any }) {
  const rows: any[] = ws.ariHealth?.rows ?? [];
  return (
    <div className="card">
      <div className="card-header">
        <h3>ARI Health</h3>
        <span className="caption">
          {ws.ariHealth?.window?.from} → {ws.ariHealth?.window?.to}
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Room</th>
              <th>Rate plan</th>
              <th>Coverage</th>
              <th>Freshness</th>
              <th>Closed</th>
              <th>Zero avail</th>
              <th>Rejected 24h</th>
              <th>Status</th>
              <th>Cause</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.roomTypeId}-${r.ratePlanId}`}>
                <td className="mono">{r.roomTypeCode}</td>
                <td className="mono">{r.ratePlanCode}</td>
                <td>
                  {r.coveragePct}%
                  <div className="caption">
                    {r.datesCovered}/{r.datesExpected}
                  </div>
                </td>
                <td>{relativeAge(r.freshnessSeconds)}</td>
                <td>{r.closedDates}</td>
                <td>{r.zeroAvailabilityDates}</td>
                <td>{r.rejectedLast24h}</td>
                <td>
                  <span
                    className={`badge ${r.status === 'HEALTHY' ? 'success' : r.status === 'DEGRADED' ? 'warning' : 'danger'}`}
                  >
                    {r.status}
                  </span>
                </td>
                <td style={{ maxWidth: 300 }} className="caption">
                  {r.causes.join(' ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption" style={{ marginTop: 12 }}>
        Every metric is bound to a cause and a timestamp. A combination with no data reports NO_DATA
        rather than silently vanishing from the table.
      </p>
    </div>
  );
}

function DiagnoseTab({ propertyId }: { propertyId: string }) {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .diagnose(propertyId)
      .then(setReport)
      .catch((e) => setError(e instanceof ApiFailure ? e.error.message : String(e)));
  }, [propertyId]);

  if (error) return <div className="empty">{error}</div>;
  if (!report) return <div className="empty">Analysing…</div>;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Diagnosis</h3>
          <span className="badge brand">✦ Diagnostic Agent</span>
        </div>
        <p style={{ fontSize: 'var(--text-body-lg)', marginBottom: 16 }}>{report.summary}</p>

        {report.funnel.map((s: any) => {
          const pct = s.total ? Math.round((s.passed / s.total) * 100) : 0;
          return (
            <div className="funnel-stage" key={s.stage}>
              <span style={{ width: 170, fontSize: 'var(--text-caption)' }}>{s.label}</span>
              <div className="funnel-bar">
                <div className={`funnel-fill ${s.ok ? '' : 'bad'}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="caption" style={{ width: 120, textAlign: 'right' }}>
                {s.passed}/{s.total} {s.ok ? '✓' : '✕'}
              </span>
            </div>
          );
        })}
        <p className="caption" style={{ marginTop: 12 }}>{report.compSetBasis}</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Findings</h3>
        </div>
        {report.findings.length === 0 && <div className="empty">No issues found.</div>}
        {report.findings.map((f: any, i: number) => (
          <div className="opportunity" key={i}>
            <span className={`dot ${f.severity === 'CRITICAL' ? 'critical' : 'warning'}`} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{f.title}</div>
              <div className="caption" style={{ marginTop: 3 }}>{f.detail}</div>
              <div className="row" style={{ marginTop: 6 }}>
                <span className="badge">{f.owner}</span>
                {f.autoFixable && <span className="badge brand">✦ Wetriip can prepare a fix</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PromotionsTab({ propertyId }: { propertyId: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.promotions(propertyId).then(setRows).catch(() => setRows([]));
  }, [propertyId]);

  if (!rows) return <div className="empty">Loading…</div>;
  if (rows.length === 0)
    return (
      <div className="empty">
        No promotions yet.
        <div className="caption" style={{ marginTop: 6 }}>
          Ask the copilot: “crea una promoción early booking 30 días, 10% para septiembre, solo
          México”. You will see the diff before anything is applied.
        </div>
      </div>
    );

  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Promotion</th>
              <th>Type</th>
              <th>Discount</th>
              <th>Stay window</th>
              <th>Markets</th>
              <th>v</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong style={{ fontWeight: 500 }}>{p.name}</strong>
                  <div className="mono muted">{p.code}</div>
                </td>
                <td className="mono">{p.type}</td>
                <td>
                  {p.definition.discount.type === 'PERCENTAGE'
                    ? `${p.definition.discount.value}%`
                    : p.definition.discount.type === 'FREE_NIGHTS'
                      ? `stay ${p.definition.discount.stayNights} pay ${p.definition.discount.payNights}`
                      : `${p.definition.discount.value} ${p.definition.discount.currency}`}
                </td>
                <td className="mono">
                  {p.definition.stayWindow.from} → {p.definition.stayWindow.to}
                </td>
                <td>{p.definition.audience?.markets?.join(', ') ?? 'all'}</td>
                <td className="mono">{p.version}</td>
                <td>
                  <span
                    className={`badge ${p.status === 'ACTIVE' ? 'success' : p.status === 'CANCELLED' ? 'danger' : 'warning'}`}
                  >
                    {p.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption" style={{ marginTop: 12 }}>
        A cancelled promotion keeps its row at a higher version. Nothing is ever deleted, which is
        what makes an undo auditable.
      </p>
    </div>
  );
}

function LedgerTab({ propertyId }: { propertyId: string }) {
  const [rows, setRows] = useState<any[] | null>(null);
  useEffect(() => {
    api.ledger(propertyId, 60).then(setRows).catch(() => setRows([]));
  }, [propertyId]);

  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <div className="card">
      <div className="card-header">
        <h3>ARI event ledger</h3>
        <span className="caption">append-only · newest first</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Stay date</th>
              <th>Layer</th>
              <th>Type</th>
              <th>Source</th>
              <th>Status</th>
              <th>Change</th>
              <th>Received</th>
              <th>Correlation</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.stayDate}</td>
                <td>
                  <span className={`badge ${e.layer === 'MANAGED' ? 'brand' : ''}`}>{e.layer}</span>
                </td>
                <td className="mono">{e.eventType}</td>
                <td className="mono" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.source}
                </td>
                <td>
                  <span
                    className={`badge ${e.status === 'ACCEPTED' ? 'success' : e.status === 'DUPLICATE' ? '' : 'warning'}`}
                  >
                    {e.status}
                  </span>
                </td>
                <td className="caption" style={{ maxWidth: 260 }}>
                  {summariseChange(e.before, e.after)}
                </td>
                <td className="caption">{new Date(e.receivedAt).toLocaleString()}</td>
                <td className="mono" style={{ maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {e.correlationId}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function summariseChange(before: any, after: any): string {
  if (!after) return '—';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(after)) {
    if (v === null || v === undefined) continue;
    const prev = before?.[k];
    parts.push(prev != null && prev !== v ? `${k}: ${prev} → ${v}` : `${k}: ${v}`);
  }
  return parts.slice(0, 4).join(' · ') || '—';
}

/* ═══════════════════════════════════════════════════════════
 * CONNECTIVITY
 * ═══════════════════════════════════════════════════════════ */
export function ConnectivityPage() {
  const [health, setHealth] = useState<any[] | null>(null);
  const [providers, setProviders] = useState<any[] | null>(null);
  const [conformance, setConformance] = useState<Record<string, any>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setHealth(await api.connectivityHealth().catch(() => []));
    setProviders(await api.providers().catch(() => []));
  }
  useEffect(() => {
    load();
  }, []);

  if (!health || !providers) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Connectivity</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Source plane only: channel manager → Wetriip. Distribution to buyers is a separate plane and
        a separate service.
      </p>

      <div className="card">
        <div className="card-header">
          <h3>Connections</h3>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th>Provider</th>
                <th>Mode</th>
                <th>Last event</th>
                <th>24h accepted</th>
                <th>Dupes</th>
                <th>Out of order</th>
                <th>Circuit</th>
                <th>Mapping</th>
                <th>Issues</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {health.map((c) => (
                <tr key={c.connectionId}>
                  <td>{c.propertyName}</td>
                  <td className="mono">{c.provider}</td>
                  <td className="mono">{c.mode}</td>
                  <td className="caption">
                    {c.lastEventAt ? new Date(c.lastEventAt).toLocaleString() : 'never'}
                  </td>
                  <td>{c.eventsLast24h}</td>
                  <td>{c.duplicatesLast24h}</td>
                  <td>{c.outOfOrderLast24h}</td>
                  <td>
                    <span className={`badge ${c.circuitState === 'CLOSED' ? 'success' : 'danger'}`}>
                      {c.circuitState}
                    </span>
                  </td>
                  <td className="mono">{c.mappingVersion ? `v${c.mappingVersion}` : '—'}</td>
                  <td className="caption" style={{ maxWidth: 240 }}>
                    {c.issues.join(' ') || '—'}
                  </td>
                  <td>
                    <button
                      className="btn-sm"
                      disabled={busy === c.connectionId}
                      onClick={async () => {
                        setBusy(c.connectionId);
                        try {
                          await api.pull(c.connectionId);
                          await load();
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === c.connectionId ? '…' : 'Pull now'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Provider registry</h3>
          <span className="caption">a connection cannot be enabled until its adapter is certified</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Push ARI</th>
                <th>Pull ARI</th>
                <th>Booking</th>
                <th>Signature</th>
                <th>Sequence</th>
                <th>Conformance</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const c = p.capabilities;
                const report = conformance[p.provider];
                return (
                  <tr key={p.provider}>
                    <td className="mono">{p.provider}</td>
                    <td>{cap(c.receiveAriPush)}</td>
                    <td>{cap(c.fetchAriPull)}</td>
                    <td>{cap(c.createBooking)}</td>
                    <td className="mono caption">{c.signatureScheme}</td>
                    <td>{c.monotonicSequence ? 'monotonic' : 'timestamp only'}</td>
                    <td>
                      {report ? (
                        <span className={`badge ${report.certified ? 'success' : 'danger'}`}>
                          {report.checks.filter((x: any) => x.passed).length}/{report.checks.length}{' '}
                          {report.certified ? 'certified' : 'failed'}
                        </span>
                      ) : (
                        <button
                          className="btn-sm"
                          onClick={async () => {
                            const r = await api.conformance(p.provider).catch((e) => ({
                              certified: false,
                              checks: [{ passed: false, title: String(e) }],
                            }));
                            setConformance((s) => ({ ...s, [p.provider]: r }));
                          }}
                        >
                          Run suite
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="caption" style={{ marginTop: 12 }}>
          Providers with every capability off are registered but not integrated. They fail loudly
          instead of returning empty results that look like “no inventory today”.
        </p>
      </div>
    </>
  );
}

function cap(v: boolean) {
  return v ? <span className="badge success">yes</span> : <span className="badge">no</span>;
}

/* ═══════════════════════════════════════════════════════════
 * DISTRIBUTION
 * ═══════════════════════════════════════════════════════════ */
export function DistributionPage() {
  const [contracts, setContracts] = useState<any[] | null>(null);
  const [bookings, setBookings] = useState<any[] | null>(null);

  useEffect(() => {
    api.contracts().then(setContracts).catch(() => setContracts([]));
    api.bookings().then(setBookings).catch(() => setBookings([]));
  }, []);

  return (
    <>
      <h1 style={{ marginBottom: 18 }}>Distribution</h1>

      <div className="card">
        <div className="card-header">
          <h3>Contracts</h3>
        </div>
        {!contracts ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Payment</th>
                  <th>Commission</th>
                  <th>Markup</th>
                  <th>Markets</th>
                  <th>Resale depth</th>
                  <th>Valid</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{c.name}</strong>
                      <div className="mono muted">{c.code}</div>
                    </td>
                    <td className="mono">{c.paymentModel}</td>
                    <td>{c.commissionPct}%</td>
                    <td>{c.markupPct}%</td>
                    <td>{c.markets.join(', ') || 'all'}</td>
                    <td>{c.maxResaleDepth}</td>
                    <td className="mono caption">
                      {c.validFrom} → {c.validTo}
                    </td>
                    <td>
                      <span className={`badge ${c.status === 'PUBLISHED' ? 'success' : 'warning'}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Bookings</h3>
        </div>
        {!bookings ? (
          <div className="empty">Loading…</div>
        ) : bookings.length === 0 ? (
          <div className="empty">No bookings yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Guest</th>
                  <th>Stay</th>
                  <th>Amount</th>
                  <th>Supplier ref</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.reference}</td>
                    <td>{b.guestName}</td>
                    <td className="mono caption">
                      {b.checkIn} → {b.checkOut}
                    </td>
                    <td>{money(b.amount, b.currencyCode)}</td>
                    <td className="mono caption">{b.supplierReference ?? '—'}</td>
                    <td>
                      <span
                        className={`badge ${
                          b.status === 'CONFIRMED'
                            ? 'success'
                            : b.status === 'UNKNOWN' || b.status === 'MANUAL_REVIEW'
                              ? 'warning'
                              : b.status === 'CANCELLED' || b.status === 'REJECTED'
                                ? 'danger'
                                : ''
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="caption" style={{ marginTop: 12 }}>
          UNKNOWN is a real state, not an error. A supplier timeout means we do not know yet — the
          reconciliation queue resolves it rather than retrying and risking a double booking.
        </p>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
 * AUDIT
 * ═══════════════════════════════════════════════════════════ */
export function AuditPage({ onChanged }: { onChanged: () => void }) {
  const [actions, setActions] = useState<any[] | null>(null);
  const [audit, setAudit] = useState<any[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setActions(await api.actions(40).catch(() => []));
    setAudit(await api.audit(60).catch(() => []));
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Audit</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Every agent action records who asked, how, which agent, which model, the policy decision, the
        simulated diff and the result. Nothing here can be edited or deleted.
      </p>

      <div className="card">
        <div className="card-header">
          <h3>Agent actions</h3>
        </div>
        {!actions ? (
          <div className="empty">Loading…</div>
        ) : actions.length === 0 ? (
          <div className="empty">No agent activity yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Utterance</th>
                  <th>Agent</th>
                  <th>Intent</th>
                  <th>Risk</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a) => (
                  <tr key={a.id}>
                    <td className="caption">{new Date(a.createdAt).toLocaleString()}</td>
                    <td style={{ maxWidth: 240 }}>{a.utterance}</td>
                    <td className="mono caption">{a.agent}</td>
                    <td className="mono caption">{a.intent}</td>
                    <td>
                      <span className={`badge ${a.riskLevel === 'HIGH' ? 'danger' : a.riskLevel === 'MEDIUM' ? 'warning' : ''}`}>
                        {a.riskLevel}
                      </span>
                    </td>
                    <td className="caption">
                      {a.deterministicIntent ? 'grammar' : (a.modelId ?? 'model')}
                    </td>
                    <td>
                      <span
                        className={`badge ${a.status === 'EXECUTED' ? 'success' : a.status === 'REJECTED' || a.status === 'FAILED' ? 'danger' : a.status === 'ROLLED_BACK' ? 'warning' : ''}`}
                      >
                        {a.status}
                      </span>
                    </td>
                    <td className="caption" style={{ maxWidth: 200 }}>
                      {a.result?.summary ?? a.error ?? a.policyDecision?.denialReason ?? '—'}
                    </td>
                    <td>
                      {a.status === 'EXECUTED' && !a.rolledBackById && (
                        <button
                          className="btn-sm btn-danger"
                          disabled={busy === a.id}
                          onClick={async () => {
                            setBusy(a.id);
                            try {
                              await api.rollback(a.id, 'undone from the audit trail');
                              await load();
                              onChanged();
                            } finally {
                              setBusy(null);
                            }
                          }}
                        >
                          Undo
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Audit ledger</h3>
        </div>
        {!audit ? (
          <div className="empty">Loading…</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Resource</th>
                  <th>Reason</th>
                  <th>Correlation</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id}>
                    <td className="caption">{new Date(a.createdAt).toLocaleString()}</td>
                    <td>
                      <span className={`badge ${a.actorType === 'AGENT' ? 'brand' : ''}`}>
                        {a.actorType}
                      </span>
                    </td>
                    <td className="mono">{a.action}</td>
                    <td className="mono caption">
                      {a.resourceType}
                      {a.resourceId ? `/${String(a.resourceId).slice(-6)}` : ''}
                    </td>
                    <td className="caption" style={{ maxWidth: 220 }}>
                      {a.reason ?? '—'}
                    </td>
                    <td className="mono caption" style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {a.correlationId}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
