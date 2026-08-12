import { useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, money, stalenessOf } from './api';

/* ═══════════════════════════════════════════════════════════
 * GROUPS
 *
 * Three screens that are really one workflow:
 *
 *   BLOQUEOS   what the hotel is holding back, by bedding
 *   POLÍTICA   the floor rate and the gratuidad rule
 *   SOLICITUDES the negotiation, on a clock
 *
 * The deadline leads everywhere. A hotel that loses a group because nobody
 * opened the console is the exact failure this exists to prevent, so the hours
 * remaining are the first thing on the row and the sort key of the list.
 * ═══════════════════════════════════════════════════════════ */

const BEDDINGS = ['SINGLE', 'TWIN', 'DOUBLE', 'TRIPLE', 'QUAD'] as const;
const BEDDING_ES: Record<string, string> = {
  SINGLE: 'Sencilla',
  TWIN: 'Twin',
  DOUBLE: 'Doble',
  TRIPLE: 'Triple',
  QUAD: 'Cuádruple',
};

export function GroupsPage({ me, properties }: { me: any; properties: any[] }) {
  const [tab, setTab] = useState<'requests' | 'blocks' | 'policy'>('requests');
  const [propertyId, setPropertyId] = useState<string>(properties[0]?.id ?? '');

  // Properties load asynchronously, so the first render can legitimately have
  // none. Saying so beats rendering three empty tabs that look like a hotel
  // with no groups.
  if (properties.length === 0) {
    return (
      <div className="empty">
        No hay propiedades visibles para su usuario todavía. Los grupos se
        administran por propiedad.
      </div>
    );
  }

  const perms: string[] = me.permissions ?? [];
  const canWrite = perms.includes('groups.write');
  const canNegotiate = perms.includes('groups.negotiate');

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Grupos</h1>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 680 }}>
        Inventario declarado para grupos, la gratuidad que el hotel otorga, y la negociación con la
        agencia — con su reloj. El presupuesto de la agencia se compara contra la tarifa piso del
        hotel y el resultado se muestra con la aritmética, no como un veredicto.
      </p>

      <div className="row" style={{ marginBottom: 14, gap: 8, flexWrap: 'wrap' }}>
        {(
          [
            ['requests', 'Solicitudes'],
            ['blocks', 'Bloqueos'],
            ['policy', 'Política'],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={`btn-sm ${tab === k ? 'btn-dark' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
        <select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          style={{ width: 'auto', minWidth: 220 }}
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>

      {tab === 'requests' && (
        <RequestsTab propertyId={propertyId} canNegotiate={canNegotiate} me={me} />
      )}
      {tab === 'blocks' && (
        <BlocksTab propertyId={propertyId} canWrite={canWrite} />
      )}
      {tab === 'policy' && <PolicyTab propertyId={propertyId} canWrite={canWrite} />}
    </>
  );
}

/* ── Solicitudes ─────────────────────────────────────────── */

function RequestsTab({
  propertyId,
  canNegotiate,
  me,
}: {
  propertyId: string;
  canNegotiate: boolean;
  me: any;
}) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<any | null>(null);
  const [channels, setChannels] = useState<any[]>([]);

  async function load() {
    try {
      setRows(await api.groupRequests(propertyId));
      setChannels(await api.notificationCapabilities().catch(() => []));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFailure ? describe(err) : String(err));
    }
  }
  useEffect(() => {
    if (propertyId) load();
  }, [propertyId]);

  if (error) return <div className="empty">{error}</div>;
  if (!rows) return <div className="empty">Cargando solicitudes…</div>;

  const stale = stalenessOf(`/api/v1/groups/requests?propertyId=${propertyId}`);
  const live = rows.filter((r) => r.status === 'OPEN' || r.status === 'COUNTERED');
  const urgent = live.filter((r) => r.hoursRemaining <= 6);
  const undeliverable = channels.filter((c) => !c.configured);
  // The most dangerous state in this domain: the hotel believes the rooms are
  // committed and the channel manager is still selling them.
  const stuck = rows.filter(
    (r) => r.status === 'ACCEPTED' && r.inventoryStatus !== 'APPLIED',
  );

  return (
    <>
      {stale?.stale && <StaleBanner stale={stale} />}

      {stuck.length > 0 && (
        <div className="cc-warn danger" style={{ marginBottom: 12 }}>
          ⚠ {stuck.length} grupo(s) aceptado(s) cuyas habitaciones <strong>no salieron de la
          venta</strong>. El channel manager las sigue vendiendo. Abra cada uno y reintente.
        </div>
      )}

      {urgent.length > 0 && (
        <div className="cc-warn danger" style={{ marginBottom: 12 }}>
          ⚠ {urgent.length} solicitud(es) vencen en menos de 6 horas:{' '}
          {urgent.map((r) => `${r.agencyName} (${r.hoursRemaining} h)`).join(', ')}.
        </div>
      )}

      {undeliverable.length > 0 && (
        <div className="cc-warn" style={{ marginBottom: 12 }}>
          ⚠ Avisos por {undeliverable.map((c) => c.channel).join(' y ')} quedan registrados pero{' '}
          <strong>no se envían</strong>: {undeliverable[0].requirement}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          Ninguna agencia ha solicitado un grupo en esta propiedad todavía.
        </div>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Vence</th>
                  <th>Agencia</th>
                  <th>Grupo</th>
                  <th>Habitaciones</th>
                  <th>Sobre la mesa</th>
                  <th>Estado</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {r.status === 'OPEN' || r.status === 'COUNTERED' ? (
                        <span
                          className={`badge ${
                            r.hoursRemaining <= 6 ? 'danger' : r.hoursRemaining <= 12 ? 'warning' : ''
                          }`}
                        >
                          {r.hoursRemaining} h
                        </span>
                      ) : (
                        <span className="caption">—</span>
                      )}
                    </td>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{r.agencyName}</strong>
                      <div className="mono muted">{r.agencyCode ?? ''}</div>
                    </td>
                    <td>
                      {r.groupName}
                      <div className="caption">
                        {r.checkIn} → {r.checkOut} · {r.pax} pax
                      </div>
                    </td>
                    <td className="caption">{r.roomsSummary}</td>
                    <td>
                      <strong style={{ fontWeight: 500 }}>
                        {money(r.currentTotal, r.currency)}
                      </strong>
                      <div className="caption">
                        {r.currentActor === 'HOTEL' ? 'contraoferta del hotel' : 'oferta de la agencia'}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                      {r.status === 'ACCEPTED' && (
                        <div className="caption">
                          {r.inventoryStatus === 'APPLIED' ? (
                            <span style={{ color: 'var(--color-success)' }}>
                              −{r.inventoryDetail?.cells ?? 0} celdas de venta
                            </span>
                          ) : (
                            <span style={{ color: 'var(--color-danger)' }}>
                              ⚠ sigue a la venta
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn-sm" onClick={() => setOpen(r)}>
                        Abrir
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && (
        <RequestDrawer
          request={open}
          canNegotiate={canNegotiate}
          me={me}
          onClose={() => setOpen(null)}
          onSettled={() => {
            setOpen(null);
            load();
          }}
        />
      )}
    </>
  );
}

function RequestDrawer({
  request,
  canNegotiate,
  me,
  onClose,
  onSettled,
}: {
  request: any;
  canNegotiate: boolean;
  me: any;
  onClose: () => void;
  onSettled: () => void;
}) {
  const [full, setFull] = useState<any>(request);
  const [counter, setCounter] = useState<string>('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .groupRequest(request.id)
      .then(setFull)
      .catch(() => undefined);
  }, [request.id]);

  const lastRound = full.rounds?.[full.rounds.length - 1];
  const evaluation = lastRound?.evaluation;
  const isOwnAgency = full.organizationId === me.organizationId;
  const settled = !['OPEN', 'COUNTERED'].includes(full.status);

  async function retryRelease() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await api.releaseGroupInventory(full.id);
      setFull(await api.groupRequest(full.id));
      setNotice(
        res.status === 'APPLIED'
          ? `Listo: ${res.cells} celda(s) fuera de venta.`
          : `Sigue fallando: ${res.reason}`,
      );
    } catch (err) {
      setNotice(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function respond(decision: 'ACCEPT' | 'COUNTER' | 'DECLINE') {
    setBusy(true);
    setNotice(null);
    try {
      await api.respondGroupRequest({
        requestId: full.id,
        decision,
        counterTotal: decision === 'COUNTER' ? Number(counter) : null,
        benefitsOffered: [],
        message: message || null,
      });
      onSettled();
    } catch (err) {
      setNotice(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <h3>{full.groupName}</h3>
          <button className="btn-sm" onClick={onClose}>
            Cerrar
          </button>
        </div>

        {notice && (
          <div className="cc-warn danger" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        <div className="grid grid-2" style={{ gap: 10, marginBottom: 14 }}>
          <Stat label="Agencia" value={full.agencyName} />
          <Stat label="Fechas" value={`${full.checkIn} → ${full.checkOut} (${full.nights} n)`} />
          <Stat label="Personas" value={String(full.pax)} />
          <Stat label="Habitaciones" value={full.roomsSummary} />
        </div>

        {/* The arithmetic, not a verdict. A hotel accepting below its floor to
            fill a shoulder date is a legitimate choice — it just must not be an
            accidental one. */}
        {evaluation && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-header">
              <h3>La aritmética</h3>
              <span className={`badge ${verdictTone(evaluation.verdict)}`}>
                {verdictLabel(evaluation.verdict)}
              </span>
            </div>
            <div className="cc-blast">
              <Metric label="Room-nights" value={String(evaluation.roomNights)} />
              <Metric label="ADR ofrecido" value={money(evaluation.offeredAdr, full.currency)} />
              <Metric
                label="ADR neto"
                value={money(evaluation.netAdr, full.currency)}
                hint="incluye las noches gratuitas que ocupan pero no facturan"
              />
              <Metric
                label="Piso"
                value={evaluation.floorRate ? money(evaluation.floorRate, full.currency) : 'sin definir'}
              />
              {evaluation.shortfallTotal != null && (
                <Metric
                  label="Cede contra el piso"
                  value={money(evaluation.shortfallTotal, full.currency)}
                />
              )}
            </div>
            <ul className="caption" style={{ margin: '8px 0 0 16px' }}>
              {evaluation.explanation.map((line: string, i: number) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
            {evaluation.benefits?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                {evaluation.benefits.map((b: any, i: number) => (
                  <div key={i} className="caption">
                    <strong style={{ fontWeight: 500 }}>{b.kind}</strong>: {b.units} — {b.explanation}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {full.status === 'ACCEPTED' && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-header">
              <h3>Inventario</h3>
              <span className={`badge ${full.inventoryStatus === 'APPLIED' ? 'success' : 'danger'}`}>
                {full.inventoryStatus}
              </span>
            </div>
            {full.inventoryStatus === 'APPLIED' ? (
              <>
                <p className="caption">
                  Se redujeron {full.inventoryDetail?.cells} celda(s) de inventario en{' '}
                  {full.inventoryDetail?.nights} noche(s), del{' '}
                  {full.inventoryDetail?.window?.from} al {full.inventoryDetail?.window?.to}. La
                  reducción vive en la capa MANAGED: la tarifa del channel manager queda intacta y
                  distinguible.
                </p>
                <p
                  className="caption"
                  style={{
                    color: full.inventoryDetail?.pushedToProvider
                      ? 'var(--color-success)'
                      : 'var(--color-danger)',
                  }}
                >
                  {full.inventoryDetail?.pushedToProvider ? '✓ ' : '⚠ '}
                  {full.inventoryDetail?.pushDetail}
                </p>
              </>
            ) : (
              <>
                <div className="cc-warn danger">
                  Las habitaciones comprometidas <strong>no</strong> salieron de la venta.{' '}
                  {full.inventoryDetail?.reason}
                </div>
                <button
                  className="btn-primary btn-sm"
                  style={{ marginTop: 8 }}
                  disabled={busy}
                  onClick={retryRelease}
                >
                  Reintentar
                </button>
              </>
            )}
          </div>
        )}

        <div className="card" style={{ marginBottom: 14 }}>
          <div className="card-header">
            <h3>Rondas</h3>
            <span className="caption">{full.rounds?.length ?? 0}</span>
          </div>
          {(full.rounds ?? []).map((r: any) => (
            <div key={r.round} className="funnel-stage">
              <span className="badge">{r.actor === 'HOTEL' ? 'Hotel' : 'Agencia'}</span>
              <span style={{ flex: 1 }}>
                {money(r.total, r.currency)}
                {r.message && <div className="caption">{r.message}</div>}
              </span>
              <span className="caption">{new Date(r.createdAt).toLocaleString()}</span>
            </div>
          ))}
        </div>

        {full.notifications?.length > 0 && (
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="card-header">
              <h3>Avisos</h3>
            </div>
            {full.notifications.map((n: any, i: number) => (
              <div key={i} className="caption" style={{ marginBottom: 4 }}>
                <span className={`badge ${n.status === 'SENT' ? 'success' : 'warning'}`}>
                  {n.status}
                </span>{' '}
                {n.channel} → {n.recipient}
                {n.requirement && <div style={{ color: 'var(--color-warning)' }}>{n.requirement}</div>}
              </div>
            ))}
          </div>
        )}

        {settled ? (
          <div className="cc-warn">
            Esta negociación está {full.status}. Una negociación cerrada no se reabre; una nueva
            solicitud empieza una nueva.
          </div>
        ) : isOwnAgency ? (
          <div className="cc-warn">
            Esta solicitud es de su propia organización. La agencia que la levanta no puede
            responderla — solo retirarla.
          </div>
        ) : canNegotiate ? (
          <>
            <Field label="Mensaje para la agencia (opcional)">
              <textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
            </Field>
            <Field label="Contraoferta">
              <input
                type="number"
                placeholder={String(full.currentTotal)}
                value={counter}
                onChange={(e) => setCounter(e.target.value)}
              />
            </Field>
            <div className="row" style={{ justifyContent: 'space-between', marginTop: 12 }}>
              <button className="btn-sm" disabled={busy} onClick={() => respond('DECLINE')}>
                Rechazar
              </button>
              <div className="row">
                <button
                  className="btn-sm"
                  disabled={busy || !counter}
                  onClick={() => respond('COUNTER')}
                >
                  Contraofertar
                </button>
                <button className="btn-primary" disabled={busy} onClick={() => respond('ACCEPT')}>
                  {busy ? 'Enviando…' : 'Aceptar el grupo'}
                </button>
              </div>
            </div>
            <p className="caption" style={{ marginTop: 8 }}>
              Aceptar compromete las habitaciones y el precio. No se puede deshacer desde aquí.
            </p>
          </>
        ) : (
          <div className="cc-warn">
            Su rol no incluye <span className="mono">groups.negotiate</span>. Puede leer la
            negociación pero no responderla.
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Bloqueos ────────────────────────────────────────────── */

function BlocksTab({ propertyId, canWrite }: { propertyId: string; canWrite: boolean }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [roomTypes, setRoomTypes] = useState<any[]>([]);

  async function load() {
    try {
      setRows(await api.groupBlocks(propertyId));
      const ws = await api.workspace(propertyId).catch(() => null);
      setRoomTypes(ws?.roomTypes ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFailure ? describe(err) : String(err));
    }
  }
  useEffect(() => {
    if (propertyId) load();
  }, [propertyId]);

  if (error) return <div className="empty">{error}</div>;
  if (!rows) return <div className="empty">Cargando bloqueos…</div>;

  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 10 }}>
        {canWrite && (
          <button className="btn-dark" onClick={() => setEditing({ _new: true })}>
            Nuevo bloqueo
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          Sin bloqueos de grupo. Cargue cuántas twin y cuántas doble reserva para grupos, con el
          techo físico de habitaciones que existen.
        </div>
      ) : (
        rows.map((b) => (
          <div key={b.id} className="card">
            <div className="card-header">
              <div>
                <h3 style={{ marginBottom: 2 }}>{b.name}</h3>
                <span className="caption mono">
                  {b.code} · {b.from} → {b.to} · release {b.releaseDays} d
                </span>
              </div>
              <div className="row">
                <span className={`badge ${b.status === 'OPEN' ? 'success' : 'warning'}`}>
                  {b.status}
                </span>
                {canWrite && (
                  <button className="btn-sm" onClick={() => setEditing(b)}>
                    Editar
                  </button>
                )}
              </div>
            </div>

            {/* The ceiling is shown apart from the lines, because that is the
                whole modelling point: the same rooms convert between twin and
                double, so the lines legitimately sum above it. */}
            <div className="cc-blast">
              <Metric label="Techo físico" value={String(b.roomsCeiling)} />
              <Metric label="Comprometidas" value={String(b.capacity.ceilingCommitted)} />
              <Metric label="En negociación" value={String(b.capacity.ceilingHeld)} />
              <Metric label="Disponibles" value={String(b.capacity.ceilingAvailable)} />
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Acomodación</th>
                    <th>En el bloqueo</th>
                    <th>Comprometidas</th>
                    <th>En negociación</th>
                    <th>Disponibles</th>
                    <th>Tarifa</th>
                  </tr>
                </thead>
                <tbody>
                  {b.capacity.lines.map((l: any) => {
                    // Look the rate up by bedding rather than by position. The
                    // two arrays happen to be built in the same order today;
                    // relying on that makes a reordering upstream show the wrong
                    // price against the wrong room.
                    const line = b.lines.find((x: any) => x.bedding === l.bedding);
                    return (
                      <tr key={l.bedding}>
                        <td>{BEDDING_ES[l.bedding] ?? l.bedding}</td>
                        <td className="mono">{l.roomsTotal}</td>
                        <td className="mono">{l.committed}</td>
                        <td className="mono">{l.held}</td>
                        <td className="mono">
                          <strong style={{ fontWeight: 500 }}>{l.available}</strong>
                        </td>
                        <td className="mono">
                          {line?.ratePerNight ? money(line.ratePerNight, b.currency) : 'a negociar'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      {editing && (
        <BlockEditor
          block={editing}
          propertyId={propertyId}
          roomTypes={roomTypes}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </>
  );
}

function BlockEditor({
  block,
  propertyId,
  roomTypes,
  onClose,
  onSaved,
}: {
  block: any;
  propertyId: string;
  roomTypes: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<any>({
    code: block.code ?? '',
    name: block.name ?? '',
    from: block.from ?? '',
    to: block.to ?? '',
    currency: block.currency ?? 'COP',
    roomsCeiling: block.roomsCeiling ?? 20,
    releaseDays: block.releaseDays ?? 30,
    minRooms: block.minRooms ?? 10,
    status: block.status ?? 'OPEN',
    lines: block.lines ?? [],
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const lineSum = useMemo(
    () => d.lines.reduce((a: number, l: any) => a + Number(l.roomsTotal || 0), 0),
    [d.lines],
  );

  function setLine(roomTypeId: string, bedding: string, rooms: number, rate: string) {
    const others = d.lines.filter(
      (l: any) => !(l.roomTypeId === roomTypeId && l.bedding === bedding),
    );
    if (rooms > 0) {
      others.push({
        roomTypeId,
        bedding,
        roomsTotal: rooms,
        ratePerNight: rate ? Number(rate) : null,
      });
    }
    setD({ ...d, lines: others });
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await api.upsertGroupBlock({
        propertyId,
        code: d.code.trim(),
        name: d.name.trim(),
        from: d.from,
        to: d.to,
        currency: d.currency,
        roomsCeiling: Number(d.roomsCeiling),
        releaseDays: Number(d.releaseDays),
        minRooms: Number(d.minRooms),
        status: d.status,
        notes: null,
        lines: d.lines,
      });
      onSaved();
    } catch (err) {
      setNotice(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <h3>{block._new ? 'Nuevo bloqueo' : d.name}</h3>
          <button className="btn-sm" onClick={onClose}>
            Cerrar
          </button>
        </div>

        {notice && (
          <div className="cc-warn danger" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        <div className="grid grid-2" style={{ gap: 10 }}>
          <Field label="Código">
            <input
              value={d.code}
              disabled={!block._new}
              onChange={(e) => setD({ ...d, code: e.target.value })}
            />
          </Field>
          <Field label="Nombre">
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Desde">
            <input type="date" value={d.from} onChange={(e) => setD({ ...d, from: e.target.value })} />
          </Field>
          <Field label="Hasta">
            <input type="date" value={d.to} onChange={(e) => setD({ ...d, to: e.target.value })} />
          </Field>
          <Field label="Techo físico de habitaciones">
            <input
              type="number"
              value={d.roomsCeiling}
              onChange={(e) => setD({ ...d, roomsCeiling: e.target.value })}
            />
          </Field>
          <Field label="Release (días antes)">
            <input
              type="number"
              value={d.releaseDays}
              onChange={(e) => setD({ ...d, releaseDays: e.target.value })}
            />
          </Field>
          <Field label="Mínimo de habitaciones">
            <input
              type="number"
              value={d.minRooms}
              onChange={(e) => setD({ ...d, minRooms: e.target.value })}
            />
          </Field>
          <Field label="Estado">
            <select value={d.status} onChange={(e) => setD({ ...d, status: e.target.value })}>
              <option value="DRAFT">Borrador</option>
              <option value="OPEN">Abierto</option>
              <option value="CLOSED">Cerrado</option>
            </select>
          </Field>
        </div>

        <div className="card-header" style={{ marginTop: 16 }}>
          <h3>Habitaciones por acomodación</h3>
          <span className="caption">{lineSum} en líneas</span>
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          Las líneas pueden sumar más que el techo: la misma habitación se arma twin o doble. El
          techo es lo que realmente puede venderse.
        </p>
        {lineSum < d.roomsCeiling && d.lines.length > 0 && (
          <div className="cc-warn" style={{ marginBottom: 8 }}>
            Las líneas suman {lineSum} y el techo es {d.roomsCeiling}: {d.roomsCeiling - lineSum}{' '}
            habitación(es) del techo no se pueden vender en ninguna acomodación.
          </div>
        )}

        {roomTypes.map((rt) => (
          <div key={rt.id} className="card" style={{ marginBottom: 8 }}>
            <div className="caption" style={{ marginBottom: 6 }}>
              <strong style={{ fontWeight: 500 }}>{rt.name}</strong> ({rt.code}) · {rt.quantity} en
              inventario
            </div>
            <div className="grid grid-2" style={{ gap: 6 }}>
              {BEDDINGS.map((bed) => {
                const line = d.lines.find(
                  (l: any) => l.roomTypeId === rt.id && l.bedding === bed,
                );
                return (
                  <div key={bed} className="row" style={{ gap: 6 }}>
                    <span className="caption" style={{ width: 82 }}>
                      {BEDDING_ES[bed]}
                    </span>
                    <input
                      type="number"
                      min={0}
                      placeholder="0"
                      value={line?.roomsTotal ?? ''}
                      onChange={(e) =>
                        setLine(rt.id, bed, Number(e.target.value || 0), String(line?.ratePerNight ?? ''))
                      }
                      style={{ width: 80 }}
                    />
                    <input
                      type="number"
                      placeholder="tarifa"
                      value={line?.ratePerNight ?? ''}
                      onChange={(e) =>
                        setLine(rt.id, bed, Number(line?.roomsTotal ?? 0), e.target.value)
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar bloqueo'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Política ────────────────────────────────────────────── */

function PolicyTab({ propertyId, canWrite }: { propertyId: string; canWrite: boolean }) {
  const [p, setP] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!propertyId) return;
    api
      .groupPolicy(propertyId)
      .then(setP)
      .catch((e) => setError(e instanceof ApiFailure ? describe(e) : String(e)));
  }, [propertyId]);

  if (error) return <div className="empty">{error}</div>;
  if (!p) return <div className="empty">Cargando política…</div>;

  function setBenefit(i: number, patch: any) {
    const benefits = [...p.benefits];
    benefits[i] = { ...benefits[i], ...patch };
    setP({ ...p, benefits });
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      const saved = await api.setGroupPolicy({
        propertyId,
        minRoomsForGroup: Number(p.minRoomsForGroup),
        floorRatePerNight: p.floorRatePerNight != null ? Number(p.floorRatePerNight) : null,
        floorCurrency: p.floorCurrency || null,
        autoDeclineBelowFloor: p.autoDeclineBelowFloor,
        responseWindowHours: Number(p.responseWindowHours),
        depositPct: Number(p.depositPct),
        cancellationPolicy: p.cancellationPolicy || null,
        benefits: p.benefits,
        notifyEmails: p.notifyEmails,
        notifyWhatsapp: p.notifyWhatsapp,
      });
      setP(saved);
      setNotice('Guardado.');
    } catch (err) {
      setNotice(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!p.configured && (
        <div className="cc-warn" style={{ marginBottom: 12 }}>
          Esta propiedad nunca ha declarado qué acepta para grupos. Sin tarifa piso, una oferta no
          se puede medir contra nada — el motor lo dirá así en vez de inventar un umbral.
        </div>
      )}

      {notice && (
        <div className={`cc-warn ${notice === 'Guardado.' ? '' : 'danger'}`} style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <h3>Qué acepta el hotel</h3>
        </div>
        <div className="grid grid-2" style={{ gap: 10 }}>
          <Field label="Mínimo de habitaciones para ser grupo">
            <input
              type="number"
              disabled={!canWrite}
              value={p.minRoomsForGroup}
              onChange={(e) => setP({ ...p, minRoomsForGroup: e.target.value })}
            />
          </Field>
          <Field label="Ventana de respuesta (horas)">
            <input
              type="number"
              disabled={!canWrite}
              value={p.responseWindowHours}
              onChange={(e) => setP({ ...p, responseWindowHours: e.target.value })}
            />
          </Field>
          <Field label="Tarifa piso por noche">
            <input
              type="number"
              disabled={!canWrite}
              placeholder="sin definir"
              value={p.floorRatePerNight ?? ''}
              onChange={(e) =>
                setP({ ...p, floorRatePerNight: e.target.value === '' ? null : e.target.value })
              }
            />
          </Field>
          <Field label="Moneda del piso">
            <input
              disabled={!canWrite}
              placeholder="COP"
              value={p.floorCurrency ?? ''}
              onChange={(e) => setP({ ...p, floorCurrency: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Depósito (%)">
            <input
              type="number"
              disabled={!canWrite}
              value={p.depositPct}
              onChange={(e) => setP({ ...p, depositPct: e.target.value })}
            />
          </Field>
        </div>

        <label className="caption" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            disabled={!canWrite}
            checked={p.autoDeclineBelowFloor}
            onChange={(e) => setP({ ...p, autoDeclineBelowFloor: e.target.checked })}
            style={{ width: 'auto' }}
          />
          Rechazar automáticamente por debajo del piso
        </label>
        <p className="caption" style={{ marginTop: 4 }}>
          Apagado por defecto: normalmente un hotel quiere enterarse de que alguien preguntó, aunque
          la cifra no sirva.
        </p>
      </div>

      <div className="card">
        <div className="card-header">
          <h3>Beneficios</h3>
          {canWrite && (
            <button
              className="btn-sm"
              onClick={() =>
                setP({
                  ...p,
                  benefits: [
                    ...p.benefits,
                    { kind: 'COMP_ROOM', everyNRooms: 20, maxUnits: null, basis: 'PER_STAY', description: null },
                  ],
                })
              }
            >
              Agregar
            </button>
          )}
        </div>
        <p className="caption" style={{ marginBottom: 10 }}>
          La gratuidad se calcula sobre habitaciones <em>pagadas</em>: 21 habitaciones con regla de
          1 por 20 dan una gratuidad, no una y fracción. Y la habitación gratis ocupa noches que no
          se facturan, así que el ADR real baja — el motor lo muestra en cada oferta.
        </p>

        {p.benefits.length === 0 ? (
          <div className="empty">Sin beneficios declarados.</div>
        ) : (
          p.benefits.map((b: any, i: number) => (
            <div key={i} className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
              <select
                disabled={!canWrite}
                value={b.kind}
                onChange={(e) => setBenefit(i, { kind: e.target.value })}
                style={{ width: 'auto', minWidth: 190 }}
              >
                <option value="COMP_ROOM">Habitación gratuita</option>
                <option value="TOUR_LEADER_FREE">Tour leader gratis</option>
                <option value="UPGRADE">Upgrade</option>
                <option value="EARLY_CHECK_IN">Early check-in</option>
                <option value="LATE_CHECK_OUT">Late check-out</option>
                <option value="WELCOME_DRINK">Cóctel de bienvenida</option>
                <option value="MEETING_ROOM_HOURS">Horas de salón</option>
                <option value="PORTERAGE">Maletero</option>
              </select>
              <span className="caption">1 por cada</span>
              <input
                type="number"
                disabled={!canWrite}
                value={b.everyNRooms}
                onChange={(e) => setBenefit(i, { everyNRooms: Number(e.target.value) })}
                style={{ width: 80 }}
              />
              <span className="caption">habitaciones</span>
              <select
                disabled={!canWrite}
                value={b.basis}
                onChange={(e) => setBenefit(i, { basis: e.target.value })}
                style={{ width: 'auto' }}
              >
                <option value="PER_STAY">por estadía</option>
                <option value="PER_NIGHT">por noche</option>
              </select>
              <input
                type="number"
                disabled={!canWrite}
                placeholder="máx"
                value={b.maxUnits ?? ''}
                onChange={(e) =>
                  setBenefit(i, { maxUnits: e.target.value === '' ? null : Number(e.target.value) })
                }
                style={{ width: 80 }}
              />
              {canWrite && (
                <button
                  className="btn-sm"
                  onClick={() => setP({ ...p, benefits: p.benefits.filter((_: any, j: number) => j !== i) })}
                >
                  Quitar
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3>A quién avisar</h3>
        </div>
        <Field label="Correos (separados por coma)">
          <input
            disabled={!canWrite}
            value={p.notifyEmails.join(', ')}
            onChange={(e) =>
              setP({ ...p, notifyEmails: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })
            }
          />
        </Field>
        <Field label="WhatsApp en formato E.164 (+573001234567)">
          <input
            disabled={!canWrite}
            value={p.notifyWhatsapp.join(', ')}
            onChange={(e) =>
              setP({
                ...p,
                notifyWhatsapp: e.target.value.split(',').map((x) => x.trim()).filter(Boolean),
              })
            }
          />
        </Field>
      </div>

      {canWrite && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar política'}
          </button>
        </div>
      )}
    </>
  );
}

/* ── Shared ──────────────────────────────────────────────── */

export function StaleBanner({ stale }: { stale: { fetchedAt: number | null; reason: string | null } }) {
  const age = stale.fetchedAt ? Math.round((Date.now() - stale.fetchedAt) / 60000) : null;
  return (
    <div className="cc-warn" style={{ marginBottom: 12 }}>
      ⚠ Mostrando la última copia conocida{age != null ? `, de hace ${age} min` : ''}. {stale.reason}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="caption">{label}</div>
      <div style={{ fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="caption">{label}</div>
      <div className="cc-blast-value">{value}</div>
      {hint && <div className="caption">{hint}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label className="caption">{label}</label>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  );
}

function statusTone(status: string): string {
  if (status === 'ACCEPTED') return 'success';
  if (status === 'DECLINED' || status === 'EXPIRED') return 'danger';
  if (status === 'COUNTERED') return 'warning';
  return '';
}

function verdictTone(v: string): string {
  return v === 'ABOVE_FLOOR' ? 'success' : v === 'BELOW_FLOOR' ? 'danger' : 'warning';
}

function verdictLabel(v: string): string {
  return v === 'ABOVE_FLOOR'
    ? 'Sobre el piso'
    : v === 'BELOW_FLOOR'
      ? 'Bajo el piso'
      : 'Sin piso definido';
}

function describe(err: ApiFailure): string {
  return [err.error.message, err.error.remediation].filter(Boolean).join(' ');
}
