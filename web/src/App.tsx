import { useEffect, useState } from 'react';
import { ApiFailure, api, getToken, setToken } from './api';
import { Isotype, Lockup, Wordmark } from './Brand';
import { CommandCenter } from './CommandCenter';
import { Copilot, CopilotContext } from './Copilot';
import { AuditPage, ConnectivityPage, DistributionPage, OverviewPage, PropertyWorkspace } from './pages';
import { PartnersPage } from './property-extra';
import { EventSpacesPage } from './events';
import { GroupsPage } from './groups';
import { PlatformAdminPage, UsersPage } from './users';

export type View =
  | { name: 'overview' }
  | { name: 'command' }
  | { name: 'properties' }
  | { name: 'property'; id: string }
  | { name: 'connectivity' }
  | { name: 'distribution' }
  | { name: 'partners' }
  | { name: 'audit' }
  | { name: 'groups' }
  | { name: 'events' }
  | { name: 'users' }
  | { name: 'admin' };

export function App() {
  const [me, setMe] = useState<any>(null);
  const [view, setView] = useState<View>({ name: 'overview' });
  const [ctx, setCtx] = useState<CopilotContext>({});
  const [refreshKey, setRefreshKey] = useState(0);
  const [capabilities, setCapabilities] = useState<any>(null);
  const [properties, setProperties] = useState<any[]>([]);

  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then(setMe)
      .catch(() => setToken(null));
    api.agentCapabilities().then(setCapabilities).catch(() => undefined);
    api.properties().then(setProperties).catch(() => undefined);
  }, []);

  if (!me) return <Login onLogin={setMe} />;

  // The console hides what this person cannot reach. It is courtesy, not
  // security — every one of these routes is enforced again at the gateway.
  const permissions: string[] = me.permissions ?? [];
  const has = (p: string) => permissions.includes(p);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <Lockup size={34} subtitle="SUPPLY OS" />
        </div>

        <div className="nav-group">
          <NavItem
            label="Overview"
            glyph="⌂"
            active={view.name === 'overview'}
            onClick={() => setView({ name: 'overview' })}
          />
          {/* The AI Command Center is top-level, not a hidden chat bubble. */}
          <NavItem
            label="AI Command Center"
            glyph="✦"
            className="ai"
            active={view.name === 'command'}
            onClick={() => setView({ name: 'command' })}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-label">Supply</div>
          <NavItem
            label="Properties"
            glyph="▣"
            active={view.name === 'properties' || view.name === 'property'}
            onClick={() => setView({ name: 'properties' })}
          />
          <NavItem
            label="Connectivity"
            glyph="⇄"
            active={view.name === 'connectivity'}
            onClick={() => setView({ name: 'connectivity' })}
          />
        </div>

        <div className="nav-group">
          <div className="nav-group-label">Commerce</div>
          <NavItem
            label="Distribution"
            glyph="◎"
            active={view.name === 'distribution'}
            onClick={() => setView({ name: 'distribution' })}
          />
          <NavItem
            label="Partners"
            glyph="◈"
            active={view.name === 'partners'}
            onClick={() => setView({ name: 'partners' })}
          />
          {has('groups.read') && (
            <NavItem
              label="Grupos"
              glyph="⧉"
              active={view.name === 'groups'}
              onClick={() => setView({ name: 'groups' })}
            />
          )}
          {has('events.read') && (
            <NavItem
              label="Salones"
              glyph="▦"
              active={view.name === 'events'}
              onClick={() => setView({ name: 'events' })}
            />
          )}
          <NavItem
            label="Audit"
            glyph="≡"
            active={view.name === 'audit'}
            onClick={() => setView({ name: 'audit' })}
          />
        </div>

        {(has('users.read') || has('platform.tenants.read')) && (
          <div className="nav-group">
            <div className="nav-group-label">Administration</div>
            {has('users.read') && (
              <NavItem
                label="Team"
                glyph="◐"
                active={view.name === 'users'}
                onClick={() => setView({ name: 'users' })}
              />
            )}
            {has('platform.tenants.read') && (
              <NavItem
                label="Platform"
                glyph="⬡"
                active={view.name === 'admin'}
                onClick={() => setView({ name: 'admin' })}
              />
            )}
          </div>
        )}

        <div className="sidebar-footer">
          <div className="caption" style={{ color: '#e2e8f0' }}>{me.name ?? me.email}</div>
          <div className="caption" style={{ color: '#94a3b8' }}>
            {me.role} · autonomy L{me.maxAutonomy} · {permissions.length} permissions
          </div>
          {capabilities && (
            <div className="caption" style={{ color: '#475569', marginTop: 4 }}>
              {capabilities.llmConfigured
                ? `intent: ${capabilities.model}`
                : 'intent: deterministic grammar'}
            </div>
          )}
          <button
            className="btn-sm"
            style={{ marginTop: 10, background: 'transparent', borderColor: '#334155', color: '#cbd5e1' }}
            onClick={() => {
              setToken(null);
              setMe(null);
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="eyebrow">
            {view.name === 'property' ? 'PROPERTY WORKSPACE' : view.name.toUpperCase()}
          </div>
          <div className="row">
            <span className="badge brand">✦ AI-first</span>
            <span className="caption">{me.userId.slice(-6)}</span>
          </div>
        </div>

        <div className="content" style={view.name === 'command' ? { padding: 0 } : undefined}>
          {view.name === 'command' && (
            <CommandCenter
              properties={properties}
              contextPropertyId={ctx.propertyId ?? null}
              onContextProperty={(id) => setCtx({ propertyId: id })}
              onChanged={() => setRefreshKey((k) => k + 1)}
            />
          )}
          {view.name === 'overview' && (
            <OverviewPage key={refreshKey} onOpenProperty={(id) => setView({ name: 'property', id })} />
          )}
          {view.name === 'properties' && (
            <PropertiesPage onOpen={(id) => setView({ name: 'property', id })} />
          )}
          {view.name === 'property' && (
            <PropertyWorkspace
              key={`${view.id}-${refreshKey}`}
              propertyId={view.id}
              onContext={setCtx}
              onBack={() => setView({ name: 'properties' })}
            />
          )}
          {view.name === 'connectivity' && <ConnectivityPage key={refreshKey} />}
          {view.name === 'distribution' && <DistributionPage key={refreshKey} />}
          {view.name === 'partners' && <PartnersPage key={refreshKey} />}
          {view.name === 'audit' && <AuditPage key={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />}
          {view.name === 'groups' && <GroupsPage key={refreshKey} me={me} properties={properties} />}
          {view.name === 'events' && (
            <EventSpacesPage key={refreshKey} me={me} properties={properties} />
          )}
          {view.name === 'users' && <UsersPage key={refreshKey} me={me} properties={properties} />}
          {view.name === 'admin' && <PlatformAdminPage key={refreshKey} />}
        </div>
      </div>

      {view.name !== 'command' && (
        <Copilot context={ctx} onChanged={() => setRefreshKey((k) => k + 1)} />
      )}
    </div>
  );
}

function NavItem({
  label,
  glyph,
  active,
  onClick,
  className,
}: {
  label: string;
  glyph: string;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button className={`nav-item ${active ? 'active' : ''} ${className ?? ''}`} onClick={onClick}>
      <span className="glyph">{glyph}</span>
      {label}
    </button>
  );
}

function Login({ onLogin }: { onLogin: (me: any) => void }) {
  const [email, setEmail] = useState('melisa@caribehotels.co');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email);
      setToken(res.token);
      onLogin(await api.me());
    } catch (err) {
      setError(err instanceof ApiFailure ? `${err.error.message}. ${err.error.remediation ?? ''}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="row" style={{ marginBottom: 20 }}>
          <Isotype size={44} />
          <Wordmark size="1.5rem" color="var(--color-text)" />
        </div>
        <h3 style={{ marginBottom: 4 }}>Supply OS</h3>
        <p className="caption" style={{ marginBottom: 18 }}>
          The agentic operating system for travel supply.
        </p>

        <label className="caption">Work email</label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ marginTop: 4, marginBottom: 12 }}
        />
        <button className="btn-dark" onClick={submit} disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Continue'}
        </button>
        {error && (
          <p className="caption" style={{ color: 'var(--color-danger)', marginTop: 10 }}>
            {error}
          </p>
        )}
        <p className="caption" style={{ marginTop: 16 }}>
          Development sign-in. Production terminates OIDC at the gateway; this screen never handles a
          password.
        </p>
      </div>
    </div>
  );
}

function PropertiesPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .properties()
      .then(setRows)
      .catch((e) => setError(e instanceof ApiFailure ? e.error.message : String(e)));
  }, []);

  if (error) return <div className="empty">{error}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      <h1 style={{ marginBottom: 4 }}>Properties</h1>
      <p className="muted" style={{ marginBottom: 18 }}>
        Approval is a workflow state. It is not proof that a hotel is sellable — open a property to
        see its connection, ARI and contract badges separately.
      </p>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Property</th>
                <th>City</th>
                <th>Currency</th>
                <th>Approval</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    <strong style={{ fontWeight: 500 }}>{p.name}</strong>
                    <div className="mono muted">{p.code}</div>
                  </td>
                  <td>
                    {p.city}, {p.country}
                  </td>
                  <td className="mono">{p.currency}</td>
                  <td>
                    <span className={`badge ${p.status === 'APPROVED' ? 'success' : 'warning'}`}>
                      {p.status}
                    </span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-sm" onClick={() => onOpen(p.id)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
