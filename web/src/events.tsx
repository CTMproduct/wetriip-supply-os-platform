import { useEffect, useState } from 'react';
import { ApiFailure, api, money } from './api';

/* ═══════════════════════════════════════════════════════════
 * SALONES DE EVENTOS
 *
 * Two halves of the same conversation: what the hotel has, and what it costs
 * for a specific event. The quoter sits next to the configuration on purpose —
 * a salesperson loads a salón in order to be able to answer a phone call about
 * it, and a quote that does not reflect what was just configured is worse than
 * no quote.
 *
 * The layout is the load-bearing field. The same room seats 120 in auditorio
 * and 28 en U, so capacity is per layout and a request that does not fit is
 * refused with the number it would have needed.
 * ═══════════════════════════════════════════════════════════ */

const LAYOUTS = [
  ['THEATRE', 'Auditorio'],
  ['CLASSROOM', 'Escuela'],
  ['U_SHAPE', 'En U'],
  ['L_SHAPE', 'En L'],
  ['BOARDROOM', 'Junta'],
  ['IMPERIAL', 'Imperial'],
  ['BANQUET', 'Banquete'],
  ['COCKTAIL', 'Cóctel'],
  ['CABARET', 'Cabaré'],
] as const;

const RATE_UNITS = [
  ['HOUR', 'Por hora'],
  ['HALF_DAY', 'Medio día'],
  ['FULL_DAY', 'Día completo'],
  ['PER_PERSON', 'Por persona'],
] as const;

const ADDONS = [
  ['MICROPHONE', 'Micrófono alámbrico'],
  ['WIRELESS_MICROPHONE', 'Micrófono inalámbrico'],
  ['VIDEOBEAM', 'Videobeam'],
  ['SCREEN', 'Pantalla'],
  ['SOUND_SYSTEM', 'Sonido'],
  ['LECTERN', 'Podio'],
  ['FLIPCHART', 'Papelógrafo'],
  ['WIFI_DEDICATED', 'WiFi dedicado'],
  ['STREAMING', 'Transmisión en vivo'],
  ['TECHNICIAN', 'Técnico'],
  ['STAGE', 'Tarima'],
  ['COFFEE_BREAK', 'Coffee break'],
  ['COFFEE_BREAK_PREMIUM', 'Coffee break premium'],
  ['BREAKFAST', 'Desayuno'],
  ['LUNCH', 'Almuerzo'],
  ['DINNER', 'Cena'],
  ['OPEN_BAR', 'Barra libre'],
  ['HYDRATION_STATION', 'Hidratación'],
] as const;

const ADDON_UNITS = [
  ['PER_EVENT', 'Por evento'],
  ['PER_HOUR', 'Por hora'],
  ['PER_DAY', 'Por día'],
  ['PER_PERSON', 'Por persona'],
] as const;

export function EventSpacesPage({ me, properties }: { me: any; properties: any[] }) {
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? '');
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [quoting, setQuoting] = useState<any | null>(null);

  const canWrite = (me.permissions ?? []).includes('events.write');

  async function load() {
    try {
      setRows(await api.eventSpaces(propertyId));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFailure ? describe(err) : String(err));
    }
  }
  useEffect(() => {
    if (propertyId) load();
  }, [propertyId]);

  if (properties.length === 0) {
    return (
      <div className="empty">
        No hay propiedades visibles para su usuario todavía. Los salones se
        administran por propiedad.
      </div>
    );
  }

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Salones de eventos</h1>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 680 }}>
        Capacidad por montaje, tarifas por hora, medio día, día completo o por persona, y todo lo
        que se le cuelga encima: videobeam, micrófono, coffee break. La cotización toma la unidad
        más barata que aplique y muestra la aritmética línea por línea.
      </p>

      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <select
          value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}
          style={{ width: 'auto', minWidth: 240 }}
        >
          {properties.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {canWrite && (
          <button className="btn-dark" onClick={() => setEditing({ _new: true })}>
            Nuevo salón
          </button>
        )}
      </div>

      {error && <div className="empty">{error}</div>}
      {!error && !rows && <div className="empty">Cargando salones…</div>}

      {rows?.length === 0 && (
        <div className="empty">
          Sin salones cargados. Puede dictarlos en el AI Command Center: nombre, capacidades por
          montaje y tarifas.
        </div>
      )}

      {rows?.map((s) => (
        <div key={s.id} className="card">
          <div className="card-header">
            <div>
              <h3 style={{ marginBottom: 2 }}>{s.name}</h3>
              <span className="caption mono">
                {s.code}
                {s.areaM2 ? ` · ${s.areaM2} m²` : ''}
                {s.ceilingHeightM ? ` · ${s.ceilingHeightM} m de altura` : ''}
                {s.naturalLight ? ' · luz natural' : ''}
                {s.divisible ? ' · divisible' : ''}
              </span>
            </div>
            <div className="row">
              <span className={`badge ${s.active ? 'success' : 'danger'}`}>
                {s.active ? 'ACTIVO' : 'INACTIVO'}
              </span>
              <button className="btn-sm" onClick={() => setQuoting(s)}>
                Cotizar
              </button>
              {canWrite && (
                <button className="btn-sm" onClick={() => setEditing(s)}>
                  Editar
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-2" style={{ gap: 14 }}>
            <div>
              <div className="caption" style={{ marginBottom: 6 }}>
                Capacidad por montaje
              </div>
              {s.layouts.map((l: any) => (
                <div key={l.layout} className="funnel-stage">
                  <span style={{ flex: 1 }}>{l.label}</span>
                  <span className="mono">{l.capacity} pax</span>
                  {l.setupFee > 0 && (
                    <span className="caption">montaje {money(l.setupFee, s.currency)}</span>
                  )}
                </div>
              ))}
            </div>
            <div>
              <div className="caption" style={{ marginBottom: 6 }}>
                Tarifas del salón
              </div>
              {s.rates.map((r: any) => (
                <div key={r.unit} className="funnel-stage">
                  <span style={{ flex: 1 }}>
                    {RATE_UNITS.find(([k]) => k === r.unit)?.[1] ?? r.unit}
                  </span>
                  <span className="mono">{money(r.amount, s.currency)}</span>
                  {r.minimumPax > 0 && <span className="caption">mín {r.minimumPax} pax</span>}
                </div>
              ))}
              <div className="caption" style={{ marginTop: 6 }}>
                Medio día = {s.halfDayHours} h · día completo = {s.fullDayHours} h
              </div>
            </div>
          </div>

          {(s.equipment.length > 0 || s.catering.length > 0) && (
            <div className="grid grid-2" style={{ gap: 14, marginTop: 12 }}>
              <AddonList title="Equipos" items={s.equipment} currency={s.currency} />
              <AddonList title="Alimentos y bebidas" items={s.catering} currency={s.currency} />
            </div>
          )}
        </div>
      ))}

      {editing && (
        <SpaceEditor
          space={editing}
          propertyId={propertyId}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {quoting && <Quoter space={quoting} onClose={() => setQuoting(null)} />}
    </>
  );
}

function AddonList({ title, items, currency }: { title: string; items: any[]; currency: string }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="caption" style={{ marginBottom: 6 }}>
        {title}
      </div>
      {items.map((a) => (
        <div key={a.kind} className="funnel-stage">
          <span style={{ flex: 1 }}>{a.name}</span>
          {a.includedInSpace ? (
            <span className="badge success">incluido</span>
          ) : (
            <>
              <span className="mono">{money(a.amount, currency)}</span>
              <span className="caption">
                {ADDON_UNITS.find(([k]) => k === a.unit)?.[1] ?? a.unit}
              </span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ── Cotizador ───────────────────────────────────────────── */

function Quoter({ space, onClose }: { space: any; onClose: () => void }) {
  const [layout, setLayout] = useState(space.layouts[0]?.layout ?? 'THEATRE');
  const [pax, setPax] = useState(String(space.layouts[0]?.capacity ?? 40));
  const [hours, setHours] = useState('');
  const [days, setDays] = useState('1');
  const [addons, setAddons] = useState<Record<string, boolean>>({});
  const [quote, setQuote] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const all = [...space.equipment, ...space.catering];

  async function run() {
    setBusy(true);
    setError(null);
    setQuote(null);
    try {
      const q = await api.quoteEventSpace({
        spaceId: space.id,
        date: new Date().toISOString().slice(0, 10),
        layout,
        pax: Number(pax),
        hours: hours ? Number(hours) : null,
        days: Number(days),
        addons: Object.entries(addons)
          .filter(([, on]) => on)
          .map(([kind]) => ({ kind, quantity: 1 })),
      });
      setQuote(q);
    } catch (err) {
      setError(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="card-header">
          <h3>Cotizar {space.name}</h3>
          <button className="btn-sm" onClick={onClose}>
            Cerrar
          </button>
        </div>

        <div className="grid grid-2" style={{ gap: 10 }}>
          <Field label="Montaje">
            <select value={layout} onChange={(e) => setLayout(e.target.value)}>
              {space.layouts.map((l: any) => (
                <option key={l.layout} value={l.layout}>
                  {l.label} — hasta {l.capacity}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Personas">
            <input type="number" value={pax} onChange={(e) => setPax(e.target.value)} />
          </Field>
          <Field label="Horas (vacío = día completo)">
            <input
              type="number"
              step="0.5"
              placeholder={String(space.fullDayHours)}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </Field>
          <Field label="Días">
            <input type="number" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>

        <div className="caption" style={{ margin: '4px 0 6px' }}>
          Servicios adicionales
        </div>
        <div className="grid grid-2" style={{ gap: 4 }}>
          {all.map((a: any) => (
            <label
              key={a.kind}
              className="caption"
              style={{ display: 'flex', gap: 6, alignItems: 'center' }}
            >
              <input
                type="checkbox"
                checked={!!addons[a.kind]}
                onChange={(e) => setAddons({ ...addons, [a.kind]: e.target.checked })}
                style={{ width: 'auto' }}
              />
              {a.name}
              {a.includedInSpace && <span className="badge success">incluido</span>}
            </label>
          ))}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button className="btn-primary" disabled={busy} onClick={run}>
            {busy ? 'Calculando…' : 'Cotizar'}
          </button>
        </div>

        {/* A refusal here is the most valuable output the quoter has: it stops a
            hotel selling 80 people into a room that seats 28. */}
        {error && (
          <div className="cc-warn danger" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        {quote && (
          <div className="card" style={{ marginTop: 14 }}>
            <div className="card-header">
              <h3>{money(quote.total, quote.currency)}</h3>
              <span className="caption">{money(quote.perPerson, quote.currency)} por persona</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Paso</th>
                    <th>Concepto</th>
                    <th>Cálculo</th>
                    <th style={{ textAlign: 'right' }}>Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {quote.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td className="mono caption">{l.step}</td>
                      <td>{l.label}</td>
                      <td className="caption">{l.explanation}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {money(l.amount, quote.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="cc-blast" style={{ marginTop: 10 }}>
              <Metric label="Salón" value={money(quote.spaceTotal, quote.currency)} />
              <Metric label="Equipos" value={money(quote.equipmentTotal, quote.currency)} />
              <Metric label="A&B" value={money(quote.cateringTotal, quote.currency)} />
              <Metric label={`Impuestos ${quote.taxPct}%`} value={money(quote.taxTotal, quote.currency)} />
            </div>
            {quote.warnings.map((w: string, i: number) => (
              <div key={i} className="cc-warn">
                {w}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Editor ──────────────────────────────────────────────── */

function SpaceEditor({
  space,
  propertyId,
  onClose,
  onSaved,
}: {
  space: any;
  propertyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<any>({
    code: space.code ?? '',
    name: space.name ?? '',
    currency: space.currency ?? 'COP',
    areaM2: space.areaM2 ?? '',
    ceilingHeightM: space.ceilingHeightM ?? '',
    naturalLight: space.naturalLight ?? false,
    divisible: space.divisible ?? false,
    floor: space.floor ?? '',
    halfDayHours: space.halfDayHours ?? 4,
    fullDayHours: space.fullDayHours ?? 8,
    active: space.active ?? true,
    layouts: space.layouts ?? [],
    rates: space.rates ?? [],
    addons: [...(space.equipment ?? []), ...(space.catering ?? [])],
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function setLayout(layout: string, capacity: string, setupFee: string) {
    const others = d.layouts.filter((l: any) => l.layout !== layout);
    if (capacity && Number(capacity) > 0) {
      others.push({ layout, capacity: Number(capacity), setupFee: Number(setupFee || 0) });
    }
    setD({ ...d, layouts: others });
  }

  function setRate(unit: string, amount: string, minimumPax: string) {
    const others = d.rates.filter((r: any) => r.unit !== unit);
    if (amount !== '') {
      others.push({ unit, amount: Number(amount), minimumPax: Number(minimumPax || 0) });
    }
    setD({ ...d, rates: others });
  }

  function setAddon(kind: string, name: string, patch: any) {
    const existing = d.addons.find((a: any) => a.kind === kind);
    const others = d.addons.filter((a: any) => a.kind !== kind);
    const next = {
      kind,
      name,
      unit: existing?.unit ?? 'PER_EVENT',
      amount: existing?.amount ?? 0,
      includedInSpace: existing?.includedInSpace ?? false,
      description: null,
      ...patch,
    };
    setD({ ...d, addons: [...others, next] });
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await api.upsertEventSpace({
        propertyId,
        code: d.code.trim(),
        name: d.name.trim(),
        currency: d.currency,
        areaM2: d.areaM2 === '' ? null : Number(d.areaM2),
        ceilingHeightM: d.ceilingHeightM === '' ? null : Number(d.ceilingHeightM),
        naturalLight: d.naturalLight,
        divisible: d.divisible,
        floor: d.floor || null,
        halfDayHours: Number(d.halfDayHours),
        fullDayHours: Number(d.fullDayHours),
        layouts: d.layouts,
        rates: d.rates,
        addons: d.addons.map((a: any) => ({
          kind: a.kind,
          name: a.name,
          unit: a.unit,
          amount: a.amount,
          includedInSpace: a.includedInSpace,
          description: a.description ?? null,
        })),
        active: d.active,
        notes: null,
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
          <h3>{space._new ? 'Nuevo salón' : d.name}</h3>
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
              disabled={!space._new}
              onChange={(e) => setD({ ...d, code: e.target.value })}
            />
          </Field>
          <Field label="Nombre">
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Moneda">
            <input value={d.currency} onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Área (m²)">
            <input type="number" value={d.areaM2} onChange={(e) => setD({ ...d, areaM2: e.target.value })} />
          </Field>
          <Field label="Altura (m)">
            <input
              type="number"
              step="0.1"
              value={d.ceilingHeightM}
              onChange={(e) => setD({ ...d, ceilingHeightM: e.target.value })}
            />
          </Field>
          <Field label="Piso">
            <input value={d.floor} onChange={(e) => setD({ ...d, floor: e.target.value })} />
          </Field>
          <Field label="Horas de medio día">
            <input
              type="number"
              value={d.halfDayHours}
              onChange={(e) => setD({ ...d, halfDayHours: e.target.value })}
            />
          </Field>
          <Field label="Horas de día completo">
            <input
              type="number"
              value={d.fullDayHours}
              onChange={(e) => setD({ ...d, fullDayHours: e.target.value })}
            />
          </Field>
        </div>

        <div className="row" style={{ gap: 16, marginBottom: 10 }}>
          <label className="caption" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={d.naturalLight}
              onChange={(e) => setD({ ...d, naturalLight: e.target.checked })}
              style={{ width: 'auto' }}
            />
            Luz natural
          </label>
          <label className="caption" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={d.divisible}
              onChange={(e) => setD({ ...d, divisible: e.target.checked })}
              style={{ width: 'auto' }}
            />
            Divisible
          </label>
          <label className="caption" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={d.active}
              onChange={(e) => setD({ ...d, active: e.target.checked })}
              style={{ width: 'auto' }}
            />
            Activo
          </label>
        </div>

        <div className="card-header" style={{ marginTop: 12 }}>
          <h3>Capacidad por montaje</h3>
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          Deje en blanco los montajes que el salón no ofrece. Cotizar uno no declarado se rechaza
          con la lista de los que sí existen.
        </p>
        {LAYOUTS.map(([key, label]) => {
          const l = d.layouts.find((x: any) => x.layout === key);
          return (
            <div key={key} className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="caption" style={{ width: 110 }}>
                {label}
              </span>
              <input
                type="number"
                placeholder="capacidad"
                value={l?.capacity ?? ''}
                onChange={(e) => setLayout(key, e.target.value, String(l?.setupFee ?? ''))}
                style={{ width: 110 }}
              />
              <input
                type="number"
                placeholder="costo de montaje"
                value={l?.setupFee ?? ''}
                onChange={(e) => setLayout(key, String(l?.capacity ?? ''), e.target.value)}
              />
            </div>
          );
        })}

        <div className="card-header" style={{ marginTop: 16 }}>
          <h3>Tarifas del salón</h3>
        </div>
        {RATE_UNITS.map(([key, label]) => {
          const r = d.rates.find((x: any) => x.unit === key);
          return (
            <div key={key} className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span className="caption" style={{ width: 110 }}>
                {label}
              </span>
              <input
                type="number"
                placeholder="monto"
                value={r?.amount ?? ''}
                onChange={(e) => setRate(key, e.target.value, String(r?.minimumPax ?? ''))}
              />
              {key === 'PER_PERSON' && (
                <input
                  type="number"
                  placeholder="mínimo pax"
                  value={r?.minimumPax ?? ''}
                  onChange={(e) => setRate(key, String(r?.amount ?? ''), e.target.value)}
                  style={{ width: 120 }}
                />
              )}
            </div>
          );
        })}

        <div className="card-header" style={{ marginTop: 16 }}>
          <h3>Equipos, alimentos y bebidas</h3>
        </div>
        {ADDONS.map(([key, label]) => {
          const a = d.addons.find((x: any) => x.kind === key);
          return (
            <div key={key} className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
              <span className="caption" style={{ width: 150 }}>
                {label}
              </span>
              <input
                type="number"
                placeholder="precio"
                value={a?.amount ?? ''}
                onChange={(e) => setAddon(key, label, { amount: Number(e.target.value || 0) })}
                style={{ width: 110 }}
              />
              <select
                value={a?.unit ?? 'PER_EVENT'}
                onChange={(e) => setAddon(key, label, { unit: e.target.value })}
                style={{ width: 'auto' }}
              >
                {ADDON_UNITS.map(([u, ul]) => (
                  <option key={u} value={u}>
                    {ul}
                  </option>
                ))}
              </select>
              <label className="caption" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={a?.includedInSpace ?? false}
                  onChange={(e) => setAddon(key, label, { includedInSpace: e.target.checked })}
                  style={{ width: 'auto' }}
                />
                incluido
              </label>
              {a && (
                <button
                  className="btn-sm"
                  onClick={() => setD({ ...d, addons: d.addons.filter((x: any) => x.kind !== key) })}
                >
                  Quitar
                </button>
              )}
            </div>
          );
        })}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Guardando…' : 'Guardar salón'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="caption">{label}</div>
      <div className="cc-blast-value">{value}</div>
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

function describe(err: ApiFailure): string {
  return [err.error.message, err.error.remediation].filter(Boolean).join(' ');
}
