import { useEffect, useMemo, useState } from 'react';
import { ApiFailure, api, relativeAge } from './api';

/* ═══════════════════════════════════════════════════════════
 * TEAM
 *
 * A hotel runs its own access. The general manager decides who gets in, what
 * each person may touch, and which properties they may touch it on.
 *
 * The screen is built around one idea: a role must never be a word you have to
 * trust. Selecting one shows the exact list of capabilities it carries, and any
 * individual addition or removal on top of it is shown as a separate, labelled
 * layer — because "revenue manager, minus contract publication" is a real thing
 * a manager needs to express and a real thing an auditor needs to see.
 * ═══════════════════════════════════════════════════════════ */

type Catalog = {
  roles: {
    role: string;
    label: string;
    description: string;
    permissions: string[];
    assignable: boolean;
  }[];
  permissions: { permission: string; label: string; grantable: boolean }[];
};

const EMPTY_DRAFT = {
  email: '',
  name: '',
  jobTitle: '',
  role: 'REVENUE_MANAGER',
  status: 'ACTIVE',
  grants: [] as string[],
  revokes: [] as string[],
  propertyIds: [] as string[],
  maxAutonomy: 2,
};

export function UsersPage({ me, properties }: { me: any; properties: any[] }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null>(null);

  const canManage = (me.permissions ?? []).includes('users.manage');

  async function load() {
    try {
      setRows(await api.users());
      setCatalog(await api.userCatalog());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiFailure ? describe(err) : String(err));
    }
  }
  useEffect(() => {
    load();
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!rows || !catalog) return <div className="empty">Loading team…</div>;

  const active = rows.filter((r) => r.status === 'ACTIVE');
  const administrators = active.filter((r) => r.permissions.includes('users.manage'));

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ marginBottom: 4 }}>Team</h1>
          <p className="muted" style={{ marginBottom: 18, maxWidth: 620 }}>
            A role decides <em>what</em> someone may do. The property scope decides <em>where</em>.
            Autonomy decides how far the assistant may go on their behalf before a human confirms.
            The three are independent on purpose.
          </p>
        </div>
        {canManage && (
          <button
            className="btn-dark"
            onClick={() => setEditing({ ...EMPTY_DRAFT, _new: true })}
          >
            Invite someone
          </button>
        )}
      </div>

      {administrators.length === 1 && (
        <div className="cc-warn" style={{ marginBottom: 14 }}>
          ⚠ {administrators[0].name} is the only active administrator. If that account is lost,
          nobody at this hotel can restore access from inside. Promote a second general manager.
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Scope</th>
                <th>Autonomy</th>
                <th>Last active</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const role = catalog.roles.find((r) => r.role === u.role);
                return (
                  <tr key={u.id} style={u.status === 'DISABLED' ? { opacity: 0.55 } : undefined}>
                    <td>
                      <strong style={{ fontWeight: 500 }}>{u.name}</strong>
                      <div className="mono muted">{u.email}</div>
                    </td>
                    <td>
                      {role?.label ?? u.role}
                      {(u.grants.length > 0 || u.revokes.length > 0) && (
                        <div className="caption" style={{ color: 'var(--color-warning, #b45309)' }}>
                          {u.grants.length > 0 && `+${u.grants.length} granted`}
                          {u.grants.length > 0 && u.revokes.length > 0 && ' · '}
                          {u.revokes.length > 0 && `−${u.revokes.length} revoked`}
                        </div>
                      )}
                    </td>
                    <td className="caption">
                      {u.propertyIds.length === 0
                        ? 'All properties'
                        : u.propertyIds
                            .map((id: string) => properties.find((p) => p.id === id)?.code ?? id.slice(-6))
                            .join(', ')}
                    </td>
                    <td className="mono">L{u.maxAutonomy}</td>
                    <td className="caption">
                      {u.lastActiveAt
                        ? relativeAge(Math.round((Date.now() - Date.parse(u.lastActiveAt)) / 1000))
                        : 'never'}
                    </td>
                    <td>
                      <span className={`badge ${u.status === 'ACTIVE' ? 'success' : 'danger'}`}>
                        {u.status}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {canManage && (
                        <button className="btn-sm" onClick={() => setEditing({ ...u })}>
                          Edit
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <RoleReference catalog={catalog} inUse={rows.map((u) => u.role)} />

      {editing && (
        <UserEditor
          draft={editing}
          catalog={catalog}
          properties={properties}
          meId={me.userId}
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

/** The bundles, spelled out. Nobody should have to guess what ECOMMERCE means. */
function RoleReference({ catalog, inUse }: { catalog: Catalog; inUse: string[] }) {
  const label = (p: string) =>
    catalog.permissions.find((x) => x.permission === p)?.label ?? p;
  /** `agent.use` is not authority — it opens the assistant. Listing it as a
   *  capability is what would make an analyst look like an operator. */
  const writes = (perms: string[]) =>
    perms.filter((p) => !p.endsWith('.read') && p !== 'agent.use');

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <h3>What each role carries</h3>
      </div>
      <div className="grid grid-2" style={{ gap: 14 }}>
        {catalog.roles
          .filter((r) => r.assignable || inUse.includes(r.role))
          .map((r) => (
          <div key={r.role} style={{ borderLeft: '2px solid var(--color-border)', paddingLeft: 12 }}>
            <strong style={{ fontWeight: 500 }}>{r.label}</strong>
            <p className="caption" style={{ margin: '2px 0 6px' }}>
              {r.description}
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
              {writes(r.permissions).length === 0 ? (
                <span className="caption">
                  Reads and analyses. Writes nothing — anything they propose is confirmed by
                  somebody else.
                </span>
              ) : (
                writes(r.permissions).map((p) => (
                  <span key={p} className="badge" title={p}>
                    {label(p)}
                  </span>
                ))
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UserEditor({
  draft,
  catalog,
  properties,
  meId,
  onClose,
  onSaved,
}: {
  draft: any;
  catalog: Catalog;
  properties: any[];
  meId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [d, setD] = useState<any>({ ...EMPTY_DRAFT, ...draft, jobTitle: draft.jobTitle ?? '' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const role = catalog.roles.find((r) => r.role === d.role);
  const bundle = role?.permissions ?? [];

  /** Exactly what this person will end up holding — the same arithmetic the
   *  server performs, shown before the change is saved rather than after. */
  const effective = useMemo(() => {
    const set = new Set<string>(bundle);
    for (const g of d.grants) set.add(g);
    for (const r of d.revokes) set.delete(r);
    return [...set].sort();
  }, [bundle, d.grants, d.revokes]);

  function toggleGrant(p: string) {
    const inBundle = bundle.includes(p);
    if (inBundle) {
      // Inside the bundle the only meaningful action is taking it away.
      setD({
        ...d,
        revokes: d.revokes.includes(p)
          ? d.revokes.filter((x: string) => x !== p)
          : [...d.revokes, p],
      });
    } else {
      setD({
        ...d,
        grants: d.grants.includes(p) ? d.grants.filter((x: string) => x !== p) : [...d.grants, p],
      });
    }
  }

  async function save() {
    setBusy(true);
    setNotice(null);
    try {
      await api.upsertUser({
        email: d.email.trim(),
        name: d.name.trim(),
        jobTitle: d.jobTitle?.trim() || undefined,
        role: d.role,
        status: d.status,
        grants: d.grants,
        revokes: d.revokes,
        propertyIds: d.propertyIds,
        maxAutonomy: Number(d.maxAutonomy),
      });
      onSaved();
    } catch (err) {
      setNotice(err instanceof ApiFailure ? describe(err) : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setBusy(true);
    setNotice(null);
    try {
      await api.setUserStatus(d.id, d.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE');
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
          <h3>{d._new ? 'Invite someone' : d.name}</h3>
          <button className="btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        {notice && (
          <div className="cc-warn danger" style={{ marginBottom: 12 }}>
            {notice}
          </div>
        )}

        <div className="grid grid-2" style={{ gap: 10 }}>
          <Field label="Full name">
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Work email">
            <input
              value={d.email}
              disabled={!d._new}
              onChange={(e) => setD({ ...d, email: e.target.value })}
            />
          </Field>
          <Field label="Job title">
            <input
              placeholder="Revenue Manager"
              value={d.jobTitle}
              onChange={(e) => setD({ ...d, jobTitle: e.target.value })}
            />
          </Field>
          <Field label="Agent autonomy">
            <select
              value={d.maxAutonomy}
              onChange={(e) => setD({ ...d, maxAutonomy: Number(e.target.value) })}
            >
              <option value={1}>L1 · Observe — proposes, never executes</option>
              <option value={2}>L2 · Confirm — executes after a human says yes</option>
              <option value={3}>L3 · Act — executes low-risk changes directly</option>
            </select>
          </Field>
        </div>

        <Field label="Role">
          <select value={d.role} onChange={(e) => setD({ ...d, role: e.target.value, grants: [], revokes: [] })}>
            {catalog.roles
              .filter((r) => r.assignable || r.role === d.role)
              .map((r) => (
                <option key={r.role} value={r.role} disabled={!r.assignable}>
                  {r.label}
                  {r.assignable ? '' : ' — you cannot assign this role'}
                </option>
              ))}
          </select>
        </Field>
        {role && (
          <p className="caption" style={{ marginTop: -4, marginBottom: 12 }}>
            {role.description}
          </p>
        )}

        <Field label="Properties this person may touch">
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            <button
              className={`btn-sm ${d.propertyIds.length === 0 ? 'btn-dark' : ''}`}
              onClick={() => setD({ ...d, propertyIds: [] })}
            >
              All properties
            </button>
            {properties.map((p) => {
              const on = d.propertyIds.includes(p.id);
              return (
                <button
                  key={p.id}
                  className={`btn-sm ${on ? 'btn-dark' : ''}`}
                  onClick={() =>
                    setD({
                      ...d,
                      propertyIds: on
                        ? d.propertyIds.filter((x: string) => x !== p.id)
                        : [...d.propertyIds, p.id],
                    })
                  }
                >
                  {p.code}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="card-header" style={{ marginTop: 18 }}>
          <h3>Permissions</h3>
          <span className="caption">{effective.length} effective</span>
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          Ticked items come from the role. Removing one records a revocation, which always wins over
          the role. Adding one you hold yourself records a grant.
        </p>

        <div className="grid grid-2" style={{ gap: 4 }}>
          {catalog.permissions.map((p) => {
            const inBundle = bundle.includes(p.permission);
            const held = effective.includes(p.permission);
            const disabled = !p.grantable && !inBundle;
            return (
              <label
                key={p.permission}
                className="caption"
                title={disabled ? 'You cannot grant a permission you do not hold yourself.' : p.permission}
                style={{
                  display: 'flex',
                  gap: 6,
                  alignItems: 'center',
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={held}
                  disabled={disabled}
                  onChange={() => toggleGrant(p.permission)}
                />
                <span>{p.label}</span>
                {held && !inBundle && <span className="badge success">granted</span>}
                {!held && inBundle && <span className="badge danger">revoked</span>}
              </label>
            );
          })}
        </div>

        <div className="row" style={{ marginTop: 18, justifyContent: 'space-between' }}>
          <div>
            {!d._new && d.id !== meId && (
              <button className="btn-sm" disabled={busy} onClick={toggleStatus}>
                {d.status === 'ACTIVE' ? 'Disable account' : 'Re-enable account'}
              </button>
            )}
          </div>
          <button className="btn-primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : d._new ? 'Send invitation' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
 * PLATFORM ADMINISTRATION — Wetriip staff only
 *
 * Complete sight of every tenant. Gated on permissions no hotel role holds and
 * no hotel administrator can grant, so this view cannot be reached by anyone
 * inside a hotel however they configure their own team.
 * ═══════════════════════════════════════════════════════════ */
export function PlatformAdminPage() {
  const [tab, setTab] = useState<'tenants' | 'users' | 'activity'>('tenants');
  const [tenants, setTenants] = useState<any[] | null>(null);
  const [users, setUsers] = useState<any[] | null>(null);
  const [activity, setActivity] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load =
      tab === 'tenants'
        ? api.adminTenants().then(setTenants)
        : tab === 'users'
          ? api.adminUsers().then(setUsers)
          : api.adminActivity().then(setActivity);
    load.catch((e) => setError(e instanceof ApiFailure ? describe(e) : String(e)));
  }, [tab]);

  if (error) return <div className="empty">{error}</div>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Platform administration</h1>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 620 }}>
        Wetriip's own view. Every tenant, every account, and every action any of them took — read
        only, and itself recorded in the ledger.
      </p>

      <div className="row" style={{ marginBottom: 14 }}>
        {(['tenants', 'users', 'activity'] as const).map((t) => (
          <button key={t} className={`btn-sm ${tab === t ? 'btn-dark' : ''}`} onClick={() => setTab(t)}>
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'tenants' && (
        <Table
          rows={tenants}
          head={['Tenant', 'Organizations', 'Properties', 'Users', 'Since']}
          row={(t) => [
            <>
              <strong style={{ fontWeight: 500 }}>{t.name}</strong>
              <div className="mono muted">{t.code}</div>
            </>,
            t.organizations,
            t.properties,
            t.users,
            t.createdAt.slice(0, 10),
          ]}
        />
      )}

      {tab === 'users' && (
        <Table
          rows={users}
          head={['Person', 'Tenant', 'Organization', 'Role', 'Autonomy', 'Last active', 'Status']}
          row={(u) => [
            <>
              <strong style={{ fontWeight: 500 }}>{u.name}</strong>
              <div className="mono muted">{u.email}</div>
            </>,
            <span className="mono">{u.tenant}</span>,
            u.organization,
            <>
              {u.role}
              {(u.grants?.length > 0 || u.revokes?.length > 0) && (
                <div className="caption">
                  {u.grants?.length ? `+${u.grants.length}` : ''}
                  {u.revokes?.length ? ` −${u.revokes.length}` : ''}
                </div>
              )}
            </>,
            <span className="mono">L{u.maxAutonomy}</span>,
            u.lastActiveAt
              ? relativeAge(Math.round((Date.now() - Date.parse(u.lastActiveAt)) / 1000))
              : 'never',
            <span className={`badge ${u.status === 'ACTIVE' ? 'success' : 'danger'}`}>{u.status}</span>,
          ]}
        />
      )}

      {tab === 'activity' && (
        <Table
          rows={activity}
          head={['When', 'Actor', 'Action', 'Resource', 'Reason']}
          row={(a) => [
            <span className="caption">{new Date(a.occurredAt ?? a.createdAt).toLocaleString()}</span>,
            <>
              <span className="mono">{a.actorType}</span>
              <div className="caption">{a.actorId?.slice(-8)}</div>
            </>,
            <span className="mono">{a.action}</span>,
            <span className="caption">
              {a.resourceType} {a.resourceId?.slice(-8)}
            </span>,
            <span className="caption">{a.reason ?? '—'}</span>,
          ]}
        />
      )}
    </>
  );
}

function Table({
  rows,
  head,
  row,
}: {
  rows: any[] | null;
  head: string[];
  row: (r: any) => any[];
}) {
  if (!rows) return <div className="empty">Loading…</div>;
  if (rows.length === 0) return <div className="empty">Nothing recorded yet.</div>;
  return (
    <div className="card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i}>
                {row(r).map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

/** A refusal is information. Show the remediation, not just the message. */
function describe(err: ApiFailure): string {
  return [err.error.message, err.error.remediation].filter(Boolean).join(' ');
}
