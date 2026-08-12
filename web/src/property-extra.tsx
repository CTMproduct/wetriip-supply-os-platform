import { useEffect, useState } from 'react';
import { ApiFailure, api, money } from './api';

/* ═══════════════════════════════════════════════════════════
 * PROFILE
 *
 * Shows WHERE each field came from, because the whole point of layering
 * content is that a hotel can see its own words are winning over an import.
 * ═══════════════════════════════════════════════════════════ */
export function ContentTab({ propertyId }: { propertyId: string }) {
  const [content, setContent] = useState<any>(null);
  const [sources, setSources] = useState<any[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setContent(await api.content(propertyId).catch(() => null));
    setSources(await api.contentSources(propertyId).catch(() => []));
  }
  useEffect(() => {
    load();
  }, [propertyId]);

  if (!content) return <div className="empty">Loading profile…</div>;

  const v = content.values ?? {};
  const provenance = (field: string) => content.explanation?.fields?.[field];

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const updated = await api.updateContent(propertyId, { locale: 'es', values: draft });
      setContent(updated);
      setEditing(false);
      setDraft({});
    } catch (err) {
      setNotice(err instanceof ApiFailure ? err.error.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Hotel profile</h3>
          <div className="row">
            <span
              className={`badge ${content.completeness >= 0.8 ? 'success' : content.completeness >= 0.5 ? 'warning' : 'danger'}`}
            >
              {Math.round(content.completeness * 100)}% complete
            </span>
            {!editing ? (
              <button className="btn-sm" onClick={() => { setDraft(v); setEditing(true); }}>
                Edit
              </button>
            ) : (
              <>
                <button className="btn-primary btn-sm" disabled={busy} onClick={save}>
                  Save
                </button>
                <button className="btn-sm" onClick={() => { setEditing(false); setDraft({}); }}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>

        {notice && (
          <div className="cc-warn danger" style={{ marginBottom: 10 }}>
            {notice}
          </div>
        )}

        {content.missing?.length > 0 && (
          <div className="cc-warn" style={{ marginBottom: 12 }}>
            ⚠ Missing: {content.missing.join(', ')}. A listing without these converts badly.
          </div>
        )}

        {editing ? (
          <div className="grid" style={{ gap: 10 }}>
            <Field label="Short description">
              <input
                value={draft.descriptionShort ?? ''}
                onChange={(e) => setDraft({ ...draft, descriptionShort: e.target.value })}
              />
            </Field>
            <Field label="Long description">
              <textarea
                rows={4}
                value={draft.descriptionLong ?? ''}
                onChange={(e) => setDraft({ ...draft, descriptionLong: e.target.value })}
              />
            </Field>
            <div className="grid grid-2">
              <Field label="Address">
                <input
                  value={draft.addressLine1 ?? ''}
                  onChange={(e) => setDraft({ ...draft, addressLine1: e.target.value })}
                />
              </Field>
              <Field label="Phone">
                <input
                  value={draft.phone ?? ''}
                  onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                />
              </Field>
              <Field label="Check-in from">
                <input
                  placeholder="15:00"
                  value={draft.checkInFrom ?? ''}
                  onChange={(e) => setDraft({ ...draft, checkInFrom: e.target.value })}
                />
              </Field>
              <Field label="Check-out by">
                <input
                  placeholder="12:00"
                  value={draft.checkOutBy ?? ''}
                  onChange={(e) => setDraft({ ...draft, checkOutBy: e.target.value })}
                />
              </Field>
            </div>
            <p className="caption">
              Anything you save here is written to the hotel layer. An import can never overwrite it.
            </p>
          </div>
        ) : (
          <>
            <ContentField label="Short description" value={v.descriptionShort} prov={provenance('descriptionShort')} />
            <ContentField label="Long description" value={v.descriptionLong} prov={provenance('descriptionLong')} />
            <ContentField label="Address" value={v.addressLine1} prov={provenance('addressLine1')} />
            <ContentField
              label="Coordinates"
              value={v.latitude != null ? `${v.latitude}, ${v.longitude}` : null}
              prov={provenance('latitude')}
            />
            <ContentField label="Phone" value={v.phone} prov={provenance('phone')} />
            <ContentField
              label="Check-in / check-out"
              value={v.checkInFrom ? `${v.checkInFrom} → ${v.checkOutBy ?? '—'}` : null}
              prov={provenance('checkInFrom')}
            />
            <ContentField
              label="Amenities"
              value={v.amenities?.length ? v.amenities.join(', ') : null}
              prov={provenance('amenities')}
            />
          </>
        )}

        {content.explanation?.notes?.map((n: string) => (
          <p className="caption" key={n} style={{ marginTop: 8 }}>
            {n}
          </p>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Gallery</h3>
          <span className="caption">{content.images?.length ?? 0} image(s)</span>
        </div>
        {content.images?.length === 0 ? (
          <div className="empty">
            No images yet.
            <div className="caption" style={{ marginTop: 6 }}>
              Upload them here, or connect a certified content source below.
            </div>
          </div>
        ) : (
          <div className="gallery">
            {content.images.map((img: any) => (
              <div className="gallery-item" key={img.id}>
                <div className="gallery-thumb">
                  <span className="caption">{img.category}</span>
                </div>
                <div className="row wrap" style={{ marginTop: 6 }}>
                  {img.isHero && <span className="badge brand">hero</span>}
                  <span className={`badge ${img.layer === 'MANAGED' ? 'success' : ''}`}>
                    {img.layer === 'MANAGED' ? 'hotel' : img.source}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
        {content.withheldImages?.length > 0 && (
          <div className="cc-warn" style={{ marginTop: 10 }}>
            ⚠ {content.withheldImages.length} imported image(s) held back: their credit or licence is
            unrecorded, and publishing someone else's photo without terms is a real exposure.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Content sources</h3>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Profile</th>
                <th>Images</th>
                <th>Redistribution</th>
                <th>Status</th>
                <th>Outstanding</th>
              </tr>
            </thead>
            <tbody>
              {(sources ?? []).map((s) => (
                <tr key={s.kind}>
                  <td>
                    {s.displayName}
                    <div className="mono muted">{s.kind}</div>
                  </td>
                  <td>{s.capabilities.fetchProfile ? 'yes' : 'no'}</td>
                  <td>{s.capabilities.fetchImages ? 'yes' : 'no'}</td>
                  <td>{s.capabilities.redistributionPermitted ? 'permitted' : 'not confirmed'}</td>
                  <td>
                    <span className={`badge ${s.certified ? 'success' : 'warning'}`}>
                      {s.certified ? 'certified' : 'not integrated'}
                    </span>
                  </td>
                  <td className="caption" style={{ maxWidth: 340 }}>
                    {s.requirements.length ? s.requirements.join(' · ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="caption" style={{ marginTop: 12 }}>
          Booking.com and Expedia do not publish a content API a third party may call on a hotel's
          behalf. The legitimate routes need the property's own credentials under a partner
          agreement, or a content aggregator. Until that exists these sources fail loudly rather
          than returning a hotel with no photos.
        </p>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <label className="caption">{label}</label>
      <div style={{ marginTop: 3 }}>{children}</div>
    </div>
  );
}

function ContentField({ label, value, prov }: { label: string; value: any; prov: any }) {
  return (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--surface-50)' }}>
      <div className="spread">
        <span className="caption">{label}</span>
        {prov && (
          <span className={`badge ${prov.layer === 'MANAGED' ? 'success' : ''}`}>
            {prov.layer === 'MANAGED' ? 'hotel' : prov.source}
          </span>
        )}
      </div>
      <div style={{ marginTop: 3 }}>{value || <span className="muted">— not set</span>}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
 * DISTRIBUTION
 * ═══════════════════════════════════════════════════════════ */
export function DistributionTab({ propertyId }: { propertyId: string }) {
  const [reach, setReach] = useState<any>(null);
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    const r = await api.distributionReach(propertyId).catch(() => null);
    setReach(r);
    setDraft(
      r?.policy ?? {
        mode: 'MARKETPLACE_OPEN',
        allowedMarkets: [],
        blockedMarkets: [],
        allowedPartnerIds: [],
        blockedPartnerIds: [],
        allowedPartnerTypes: [],
        allowedChannels: ['B2B'],
        requiresApproval: false,
      },
    );
  }
  useEffect(() => {
    load();
  }, [propertyId]);

  if (!reach || !draft) return <div className="empty">Loading distribution…</div>;

  async function save(next: any) {
    setBusy(true);
    setNotice(null);
    try {
      const { id, propertyId: _p, version, updatedBy, updatedAt, ...payload } = next;
      await api.setDistribution(propertyId, payload);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiFailure ? `${err.error.message} ${err.error.remediation ?? ''}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  const visible = reach.partners.filter((p: any) => p.canSee);

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Who can see this hotel</h3>
          <span className={`badge ${visible.length ? 'success' : 'danger'}`}>
            {visible.length}/{reach.partners.length} partners
          </span>
        </div>

        {notice && <div className="cc-warn danger" style={{ marginBottom: 10 }}>{notice}</div>}

        <div className="row wrap" style={{ marginBottom: 14 }}>
          {(['MARKETPLACE_OPEN', 'SELECTED_PARTNERS', 'CLOSED'] as const).map((mode) => (
            <button
              key={mode}
              className={`btn-sm ${draft.mode === mode ? 'btn-dark' : ''}`}
              disabled={busy}
              onClick={() => {
                const next = { ...draft, mode };
                setDraft(next);
                if (mode !== 'SELECTED_PARTNERS' || next.allowedPartnerIds.length) save(next);
              }}
            >
              {mode === 'MARKETPLACE_OPEN'
                ? 'Open to marketplace'
                : mode === 'SELECTED_PARTNERS'
                  ? 'Selected partners only'
                  : 'Closed'}
            </button>
          ))}
        </div>

        <p className="caption" style={{ marginBottom: 14 }}>
          This is the hotel's own rule and it is evaluated before any contract. A partner blocked
          here never reaches the point of having a rate computed, which is how a rate stays out of a
          channel you excluded.
        </p>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Type</th>
                <th>Code</th>
                <th>Can see</th>
                <th>Why not</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {reach.partners.map((p: any) => {
                const allowed = draft.allowedPartnerIds.includes(p.organizationId);
                const blocked = draft.blockedPartnerIds.includes(p.organizationId);
                return (
                  <tr key={p.organizationId}>
                    <td>
                      {p.name}
                      <div className="caption">{p.country}</div>
                    </td>
                    <td className="mono caption">{p.type}</td>
                    <td className="mono caption">{p.partnerCode ?? '—'}</td>
                    <td>
                      <span className={`badge ${p.canSee ? 'success' : 'danger'}`}>
                        {p.canSee ? 'yes' : 'no'}
                      </span>
                    </td>
                    <td className="caption" style={{ maxWidth: 280 }}>
                      {p.reason ?? '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {draft.mode === 'SELECTED_PARTNERS' && (
                          <button
                            className="btn-sm"
                            disabled={busy}
                            onClick={() =>
                              save({
                                ...draft,
                                allowedPartnerIds: allowed
                                  ? draft.allowedPartnerIds.filter((x: string) => x !== p.organizationId)
                                  : [...draft.allowedPartnerIds, p.organizationId],
                              })
                            }
                          >
                            {allowed ? 'Remove' : 'Allow'}
                          </button>
                        )}
                        <button
                          className={`btn-sm ${blocked ? 'btn-danger' : ''}`}
                          disabled={busy}
                          onClick={() =>
                            save({
                              ...draft,
                              blockedPartnerIds: blocked
                                ? draft.blockedPartnerIds.filter((x: string) => x !== p.organizationId)
                                : [...draft.blockedPartnerIds, p.organizationId],
                            })
                          }
                        >
                          {blocked ? 'Unblock' : 'Block'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Market rules</h3>
        </div>
        <div className="row wrap">
          <span className="caption" style={{ width: 130 }}>Blocked markets</span>
          {['VE', 'US', 'GB', 'MX', 'BR', 'AR'].map((m) => {
            const on = draft.blockedMarkets.includes(m);
            return (
              <button
                key={m}
                className={`btn-sm ${on ? 'btn-danger' : ''}`}
                disabled={busy}
                onClick={() =>
                  save({
                    ...draft,
                    blockedMarkets: on
                      ? draft.blockedMarkets.filter((x: string) => x !== m)
                      : [...draft.blockedMarkets, m],
                  })
                }
              >
                {m}
              </button>
            );
          })}
        </div>
        <p className="caption" style={{ marginTop: 10 }}>
          Geo rules apply to the buyer's market, not the traveller's nationality. A wholesaler in
          Mexico selling a Colombian traveller is an MX buyer.
        </p>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
 * DEMAND
 * ═══════════════════════════════════════════════════════════ */
export function DemandTab({ propertyId }: { propertyId: string }) {
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    api.propertyDemand(propertyId).then(setReport).catch(() => setReport(null));
  }, [propertyId]);

  if (!report) return <div className="empty">Loading demand…</div>;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <h3>Demand</h3>
          <span className={`badge ${report.confidence === 'LOW' || report.confidence === 'NONE' ? 'warning' : 'success'}`}>
            {report.confidence} confidence · {report.sampleSize} impressions
          </span>
        </div>

        <div className="cc-metrics" style={{ marginBottom: 14 }}>
          <Metric label="Impressions" value={report.impressions} />
          <Metric label="Quoted" value={report.offered} />
          <Metric
            label="Quote rate"
            value={report.quoteRate != null ? `${Math.round(report.quoteRate * 100)}%` : '—'}
          />
          <Metric label="Bookings" value={report.bookings} />
          <Metric
            label="Conversion"
            value={report.conversionRate != null ? `${Math.round(report.conversionRate * 100)}%` : '—'}
          />
        </div>

        {report.findings.map((f: string) => (
          <p key={f} style={{ marginBottom: 8 }}>
            {f}
          </p>
        ))}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Who is looking</h3>
        </div>
        {report.buyers.length === 0 ? (
          <div className="empty">No buyer has searched this property in the window.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Buyer</th>
                  <th>Market</th>
                  <th>Impressions</th>
                  <th>Quoted</th>
                  <th>Quote rate</th>
                  <th>Bookings</th>
                  <th>Conversion</th>
                  <th>What blocked us</th>
                </tr>
              </thead>
              <tbody>
                {report.buyers.map((b: any) => (
                  <tr key={b.buyerOrgId}>
                    <td>
                      {b.buyerName}
                      <div className="mono muted">{b.partnerCode ?? b.buyerType}</div>
                    </td>
                    <td className="mono">{b.sourceMarket}</td>
                    <td>{b.impressions}</td>
                    <td>{b.offered}</td>
                    <td>{b.quoteRate != null ? `${Math.round(b.quoteRate * 100)}%` : '—'}</td>
                    <td>{b.bookings}</td>
                    <td>{b.conversionRate != null ? `${Math.round(b.conversionRate * 100)}%` : '—'}</td>
                    <td className="caption" style={{ maxWidth: 240 }}>
                      {b.topBlockers.map((x: any) => `${x.code} (${x.count})`).join(', ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {report.blockers.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h3>Why we could not quote</h3>
          </div>
          {report.blockers.map((b: any) => (
            <div className="spread" key={b.code} style={{ padding: '6px 0' }}>
              <span className="mono">{b.code}</span>
              <span>
                {b.count} <span className="caption">({Math.round(b.share * 100)}%)</span>
              </span>
            </div>
          ))}
          <p className="caption" style={{ marginTop: 10 }}>
            Each of these is demand that reached this hotel and left with nothing. It is a fixable
            loss before any pricing question.
          </p>
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div className="cc-metric-value">{value}</div>
      <div className="caption">{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
 * PARTNERS
 * ═══════════════════════════════════════════════════════════ */
export function PartnersPage() {
  const [partners, setPartners] = useState<any[] | null>(null);
  const [flow, setFlow] = useState<any>(null);
  const [anchor, setAnchor] = useState('CO');
  const [direction, setDirection] = useState<'OUTBOUND' | 'INBOUND'>('OUTBOUND');

  useEffect(() => {
    api.partnerDirectory().then(setPartners).catch(() => setPartners([]));
  }, []);
  useEffect(() => {
    api.travelFlow(direction, anchor).then(setFlow).catch(() => setFlow(null));
  }, [direction, anchor]);

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Partners</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Wholesalers and agencies with their partner code, tax identity, payment terms and credit
        line. The code is quoted on bookings and invoices and never changes once issued.
      </p>

      <div className="card">
        {!partners ? (
          <div className="empty">Loading…</div>
        ) : partners.length === 0 ? (
          <div className="empty">No partner profiles yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Partner</th>
                  <th>Tax id</th>
                  <th>Markets</th>
                  <th>Terms</th>
                  <th>Credit</th>
                  <th>Used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {partners.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.partnerCode}</td>
                    <td>
                      {p.organizationName}
                      <div className="caption">{p.legalName}</div>
                    </td>
                    <td className="mono caption">
                      {p.taxId ? `${p.taxIdScheme} ${p.taxId}` : '—'}
                    </td>
                    <td>{p.sourceMarkets.join(', ') || '—'}</td>
                    <td className="mono caption">{p.paymentTerms}</td>
                    <td>{money(p.creditLimit, p.currency)}</td>
                    <td>
                      <span className={p.creditWarning ? 'badge warning' : ''}>
                        {p.creditUtilizationPct}%
                      </span>
                      <div className="caption">{money(p.creditAvailable, p.currency)} available</div>
                    </td>
                    <td>
                      <span
                        className={`badge ${p.status === 'ACTIVE' ? 'success' : p.status === 'SUSPENDED' ? 'danger' : 'warning'}`}
                      >
                        {p.status}
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
          <h3>Travel flow</h3>
          <div className="row">
            <button
              className={`btn-sm ${direction === 'OUTBOUND' ? 'btn-dark' : ''}`}
              onClick={() => setDirection('OUTBOUND')}
            >
              Emisivo
            </button>
            <button
              className={`btn-sm ${direction === 'INBOUND' ? 'btn-dark' : ''}`}
              onClick={() => setDirection('INBOUND')}
            >
              Receptivo
            </button>
            <select value={anchor} onChange={(e) => setAnchor(e.target.value)} style={{ width: 90 }}>
              {['CO', 'MX', 'US', 'BR', 'AR', 'PE', 'CL'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>

        {!flow ? (
          <div className="empty">Loading…</div>
        ) : flow.rows.length === 0 ? (
          <div className="empty">
            No observed demand for {anchor} in this window.
            <div className="caption" style={{ marginTop: 6 }}>
              This view is built from searches our buyers actually ran. It fills in as the platform
              is used.
            </div>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{direction === 'OUTBOUND' ? 'Destination' : 'Source market'}</th>
                    <th>Impressions</th>
                    <th>Share</th>
                    <th>Bookings</th>
                    <th>Avg rate</th>
                    <th>Avg LOS</th>
                    <th>Trend</th>
                  </tr>
                </thead>
                <tbody>
                  {flow.rows.slice(0, 12).map((r: any, i: number) => (
                    <tr key={i}>
                      <td>
                        {direction === 'OUTBOUND'
                          ? `${r.destinationCity}, ${r.destinationCountry}`
                          : r.sourceMarket}
                      </td>
                      <td>{r.impressions}</td>
                      <td>{Math.round(r.share * 100)}%</td>
                      <td>{r.bookings}</td>
                      <td>{r.averageRate != null ? money(r.averageRate, r.currency) : '—'}</td>
                      <td>{r.averageLos ?? '—'}</td>
                      <td>
                        {r.trendPct == null ? (
                          <span className="caption">—</span>
                        ) : (
                          <span style={{ color: r.trendPct > 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
                            {r.trendPct > 0 ? '+' : ''}
                            {r.trendPct}%
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {flow.findings.map((f: string) => (
              <p key={f} style={{ marginTop: 10 }}>
                {f}
              </p>
            ))}
          </>
        )}
        <p className="caption" style={{ marginTop: 12 }}>
          {flow?.basis ??
            'Derived from demand observed on this platform. It is not a national tourism statistic.'}
        </p>
      </div>
    </>
  );
}
