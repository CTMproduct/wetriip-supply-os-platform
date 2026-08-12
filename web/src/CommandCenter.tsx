import { useEffect, useRef, useState } from 'react';
import { api, getToken, money } from './api';
import { Isotype } from './Brand';
import { Markdown } from './markdown';
import { DictationHandle, cancelSpeech, speak, startDictation, voiceSupported } from './voice';

/**
 * AI Command Center.
 *
 * A full-surface assistant, not a command bar. It streams, it shows the tools
 * it reached for, and it renders structured results as cards instead of
 * burying them in prose.
 *
 * The one thing it never does is apply a change. A proposal arrives as a card
 * with the simulated blast radius and sits there until a human presses Confirm.
 * That is the same path a typed command takes — the chat is a nicer way in, not
 * a different set of rules.
 */

interface Step {
  id: string;
  name: string;
  label: string;
  input: Record<string, unknown>;
  status: 'RUNNING' | 'OK' | 'ERROR';
  summary?: string;
  error?: string;
  durationMs?: number;
  card?: { type: string; data: any } | null;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: Step[];
  proposals: any[];
  streaming?: boolean;
}

const SUGGESTIONS: Array<{ group: string; items: string[] }> = [
  {
    group: 'Revenue',
    items: [
      '¿Cómo mejoro mi RevPAR este mes?',
      '¿Mi ADR está bien contra el mercado?',
      '¿Por qué no estoy vendiendo?',
    ],
  },
  {
    group: 'Distribución',
    items: [
      '¿Qué agencia me deja más margen neto?',
      'Compara la producción de mis mayoristas',
      '¿Debería abrir un canal nuevo o subir tarifa?',
    ],
  },
  {
    group: 'Acciones',
    items: [
      'Crea una promoción early booking 30 días, 10% para septiembre, solo México',
      'Pon 3 noches mínimo los fines de semana de diciembre',
      'Sube mis tarifas 8% para navidad',
    ],
  },
];

export function CommandCenter({
  properties,
  contextPropertyId,
  onContextProperty,
  onChanged,
}: {
  properties: any[];
  contextPropertyId: string | null;
  onContextProperty: (id: string | null) => void;
  onChanged: () => void;
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [listening, setListening] = useState(false);
  const [voiceReply, setVoiceReply] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<any>(null);

  const dictation = useRef<DictationHandle | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api.agentCapabilities().then(setCapabilities).catch(() => undefined);
    refreshSessions();
  }, []);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  async function refreshSessions() {
    try {
      setSessions(await api.chatSessions());
    } catch {
      /* the thread list is a convenience, never a blocker */
    }
  }

  async function openThread(id: string) {
    cancelSpeech();
    const messages = await api.chatThread(id);
    setSessionId(id);
    setTurns(
      messages.map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        steps: m.steps ?? [],
        proposals: m.proposals ?? [],
      })),
    );
  }

  function newThread() {
    cancelSpeech();
    setSessionId(null);
    setTurns([]);
    setInput('');
    textarea.current?.focus();
  }

  /**
   * Streams a turn over SSE. `fetch` rather than EventSource because the
   * request needs an Authorization header and a POST body, neither of which
   * EventSource supports.
   */
  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    cancelSpeech();
    setInput('');
    setBusy(true);
    setNotice(null);

    const userTurn: Turn = {
      id: `u${Date.now()}`,
      role: 'user',
      content: message,
      steps: [],
      proposals: [],
    };
    const assistantTurn: Turn = {
      id: `a${Date.now()}`,
      role: 'assistant',
      content: '',
      steps: [],
      proposals: [],
      streaming: true,
    };
    setTurns((t) => [...t, userTurn, assistantTurn]);

    const update = (patch: (turn: Turn) => Turn) =>
      setTurns((t) => t.map((x) => (x.id === assistantTurn.id ? patch(x) : x)));

    try {
      const res = await fetch('/api/v1/agent/chat/stream', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          message,
          sessionId,
          channel: listening ? 'VOICE' : 'CHAT',
          context: contextPropertyId ? { propertyId: contextPropertyId } : undefined,
        }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`The assistant responded ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let spoken = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          const line = frame.replace(/^data:\s*/, '').trim();
          if (!line || line === '[DONE]') continue;

          let event: any;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === 'session') {
            setSessionId(event.sessionId);
          } else if (event.type === 'text') {
            spoken += event.delta;
            update((t) => ({ ...t, content: t.content + event.delta }));
          } else if (event.type === 'step') {
            update((t) => {
              const steps = [...t.steps];
              const at = steps.findIndex((s) => s.id === event.step.id);
              if (at >= 0) steps[at] = event.step;
              else steps.push(event.step);
              return { ...t, steps };
            });
          } else if (event.type === 'proposal') {
            update((t) => ({ ...t, proposals: [...t.proposals, event.action] }));
          } else if (event.type === 'error') {
            update((t) => ({
              ...t,
              content: `${t.content}\n\n${event.message}${event.remediation ? ` ${event.remediation}` : ''}`,
            }));
          } else if (event.type === 'done') {
            update((t) => ({
              ...t,
              id: event.message.id,
              content: event.message.content,
              steps: event.message.steps ?? t.steps,
              proposals: event.message.proposals?.length ? event.message.proposals : t.proposals,
              streaming: false,
            }));
          }
        }
      }

      update((t) => ({ ...t, streaming: false }));
      if (voiceReply && spoken.trim()) speak(spoken);
      refreshSessions();
    } catch (err) {
      update((t) => ({
        ...t,
        streaming: false,
        content:
          t.content ||
          `I could not reach the assistant: ${err instanceof Error ? err.message : String(err)}`,
      }));
    } finally {
      setBusy(false);
    }
  }

  function toggleMic() {
    if (listening) {
      dictation.current?.stop();
      return;
    }
    cancelSpeech();
    const handle = startDictation({
      onPartial: (text) => setInput(text),
      onFinal: (text) => {
        setInput(text);
        // Give the transcript a beat to settle before sending, so the user can
        // still cancel a misheard command.
        setTimeout(() => send(text), 250);
      },
      onError: (m) => setNotice(m),
      onEnd: () => {
        setListening(false);
        dictation.current = null;
      },
    });
    if (handle) {
      dictation.current = handle;
      setListening(true);
    }
  }

  async function confirmProposal(actionId: string) {
    setBusy(true);
    try {
      const res = await api.confirm(actionId);
      setTurns((t) => [
        ...t,
        {
          id: `sys${Date.now()}`,
          role: 'assistant',
          content: res.speech,
          steps: [],
          proposals: [],
        },
      ]);
      markProposal(actionId, 'EXECUTED');
      onChanged();
      if (voiceReply) speak(res.speech);
    } catch (err: any) {
      const detail = err?.error;
      setNotice(
        detail?.code === 'STEP_UP_REQUIRED'
          ? `${detail.message}. ${detail.remediation ?? ''}`
          : (detail?.message ?? String(err)),
      );
    } finally {
      setBusy(false);
    }
  }

  async function discardProposal(actionId: string) {
    await api.reject(actionId, 'discarded from the command center');
    markProposal(actionId, 'REJECTED');
  }

  function markProposal(actionId: string, status: string) {
    setTurns((t) =>
      t.map((turn) => ({
        ...turn,
        proposals: turn.proposals.map((p) => (p.id === actionId ? { ...p, status } : p)),
      })),
    );
  }

  const contextProperty = properties.find((p) => p.id === contextPropertyId);

  return (
    <div className="cc">
      <aside className="cc-threads">
        <button className="btn-dark" style={{ width: '100%' }} onClick={newThread}>
          + New conversation
        </button>
        <div className="cc-thread-list">
          {sessions.length === 0 && <div className="caption" style={{ padding: '10px 4px' }}>No conversations yet.</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              className={`cc-thread ${s.id === sessionId ? 'active' : ''}`}
              onClick={() => openThread(s.id)}
            >
              <div className="cc-thread-title">{s.title ?? 'Untitled'}</div>
              <div className="caption">{new Date(s.updatedAt).toLocaleDateString()}</div>
            </button>
          ))}
        </div>
      </aside>

      <div className="cc-main">
        <div className="cc-topbar">
          <div className="row wrap">
            <span className="badge brand">✦ Wetriip</span>
            <select
              value={contextPropertyId ?? ''}
              onChange={(e) => onContextProperty(e.target.value || null)}
              style={{ width: 240 }}
            >
              <option value="">No property in context</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {contextProperty && (
              <span className="caption">
                {contextProperty.city} · {contextProperty.currency}
              </span>
            )}
          </div>
          <div className="row">
            {voiceSupported.output() && (
              <button
                className={`btn-sm ${voiceReply ? 'btn-dark' : ''}`}
                onClick={() => {
                  cancelSpeech();
                  setVoiceReply((v) => !v);
                }}
                title="Read answers aloud"
              >
                {voiceReply ? '🔊 Voice on' : '🔈 Voice off'}
              </button>
            )}
            {capabilities && (
              <span className="caption">
                {capabilities.llmConfigured ? capabilities.model : 'deterministic mode'}
              </span>
            )}
          </div>
        </div>

        <div className="cc-scroll">
          <div className="cc-column">
            {turns.length === 0 && <EmptyState onPick={send} llm={capabilities?.llmConfigured} />}

            {turns.map((turn) =>
              turn.role === 'user' ? (
                <div className="cc-user" key={turn.id}>
                  {turn.content}
                </div>
              ) : (
                <div className="cc-assistant" key={turn.id}>
                  <div className="cc-avatar">
                    <Isotype size={26} />
                  </div>
                  <div className="cc-body">
                    {turn.steps.length > 0 && <Steps steps={turn.steps} />}
                    {turn.content ? (
                      <Markdown text={turn.content} />
                    ) : turn.streaming ? (
                      <div className="caption">Thinking…</div>
                    ) : null}
                    {turn.streaming && turn.content && <span className="cc-caret" />}
                    {turn.proposals.map((p) => (
                      <Proposal
                        key={p.id}
                        action={p}
                        busy={busy}
                        onConfirm={confirmProposal}
                        onDiscard={discardProposal}
                      />
                    ))}
                  </div>
                </div>
              ),
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="cc-composer-wrap">
          <div className="cc-column">
            {notice && (
              <div className="cc-notice">
                {notice}
                <button className="btn-sm" onClick={() => setNotice(null)}>
                  Dismiss
                </button>
              </div>
            )}
            <div className={`cc-composer ${listening ? 'listening' : ''}`}>
              <textarea
                ref={textarea}
                rows={1}
                value={input}
                placeholder={
                  listening
                    ? 'Listening…'
                    : contextProperty
                      ? `Ask about ${contextProperty.name}, or tell me what to change`
                      : 'Ask about revenue, distribution or inventory'
                }
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send(input);
                  }
                }}
              />
              <div className="cc-composer-actions">
                {voiceSupported.input() && (
                  <button
                    className={`cc-mic ${listening ? 'on' : ''}`}
                    onClick={toggleMic}
                    title={listening ? 'Stop dictation' : 'Dictate'}
                  >
                    {listening ? '■' : '🎙'}
                  </button>
                )}
                <button className="btn-dark btn-sm" onClick={() => send(input)} disabled={busy || !input.trim()}>
                  {busy ? '…' : 'Send'}
                </button>
              </div>
            </div>
            <div className="caption cc-disclaimer">
              Wetriip proposes changes; you confirm them. Nothing is applied to rates, inventory or
              promotions without your approval.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick, llm }: { onPick: (s: string) => void; llm?: boolean }) {
  return (
    <div className="cc-empty">
      <div className="cc-empty-mark">
        <Isotype size={52} />
      </div>
      <h1>How can I help with your revenue?</h1>
      <p className="muted" style={{ maxWidth: 560, margin: '8px auto 26px' }}>
        I read your live inventory, rates, contracts and partner production. I can explain what is
        happening, recommend what to do about it, and prepare the change for you to confirm.
      </p>

      <div className="cc-suggestions">
        {SUGGESTIONS.map((group) => (
          <div key={group.group}>
            <div className="eyebrow" style={{ marginBottom: 8 }}>
              {group.group}
            </div>
            {group.items.map((s) => (
              <button key={s} className="cc-suggestion" onClick={() => onPick(s)}>
                {s}
              </button>
            ))}
          </div>
        ))}
      </div>

      {llm === false && (
        <p className="caption" style={{ marginTop: 24 }}>
          No language model is configured, so I am running on the deterministic parser and the
          revenue engine's own analysis. Every capability still works; the phrasing is stricter.
        </p>
      )}
    </div>
  );
}

function Steps({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false);
  const running = steps.some((s) => s.status === 'RUNNING');
  const cards = steps.map((s) => s.card).filter(Boolean) as Array<{ type: string; data: any }>;

  return (
    <>
      <button className="cc-steps-toggle" onClick={() => setOpen((o) => !o)}>
        <span className={running ? 'spin' : ''}>{running ? '◐' : '✓'}</span>
        {running
          ? (steps.find((s) => s.status === 'RUNNING')?.label ?? 'Working')
          : `${steps.length} step${steps.length === 1 ? '' : 's'}`}
        <span className="caption">{open ? 'hide' : 'show'}</span>
      </button>

      {open && (
        <div className="cc-steps">
          {steps.map((s) => (
            <div className="cc-step" key={s.id}>
              <span
                className={`dot ${s.status === 'ERROR' ? 'critical' : s.status === 'OK' ? 'info' : 'warning'}`}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>
                  {s.label} <span className="mono muted">{s.name}</span>
                </div>
                {s.summary && <div className="caption">{s.summary}</div>}
                {s.error && (
                  <div className="caption" style={{ color: 'var(--color-danger)' }}>
                    {s.error}
                  </div>
                )}
              </div>
              {s.durationMs != null && <span className="caption">{s.durationMs}ms</span>}
            </div>
          ))}
        </div>
      )}

      {cards.map((c, i) => (
        <ResultCard key={i} card={c} />
      ))}
    </>
  );
}

/** Structured tool output, rendered as data instead of prose. */
function ResultCard({ card }: { card: { type: string; data: any } }) {
  if (card.type === 'revenue') {
    const a = card.data;
    const m = a.metrics;
    return (
      <div className="cc-card">
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          {a.propertyName} · {m.window.from} → {m.window.to}
        </div>
        <div className="cc-metrics">
          <Metric label="RevPAR" value={money(m.revpar, m.currency)} />
          <Metric label="ADR" value={money(m.adr, m.currency)} />
          <Metric
            label="Occupancy"
            value={m.occupancy != null ? `${Math.round(m.occupancy * 100)}%` : '—'}
          />
          <Metric label="Bookings" value={m.bookingCount} />
          <Metric
            label="Confidence"
            value={m.confidence}
            tone={m.confidence === 'NONE' || m.confidence === 'LOW' ? 'warning' : 'ok'}
          />
        </div>
        {a.competitive?.deltaPct != null && (
          <div className="caption" style={{ marginTop: 10 }}>
            Rate position: {a.competitive.deltaPct > 0 ? '+' : ''}
            {a.competitive.deltaPct}% vs peer median {money(a.competitive.medianPeerRate, m.currency)}
          </div>
        )}
      </div>
    );
  }

  if (card.type === 'partners' && Array.isArray(card.data) && card.data.length) {
    return (
      <div className="cc-card">
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          Partner production
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Partner</th>
                <th>Bookings</th>
                <th>Room nights</th>
                <th>Net ADR</th>
                <th>Commission</th>
                <th>Share</th>
              </tr>
            </thead>
            <tbody>
              {card.data.slice(0, 8).map((p: any) => (
                <tr key={p.organizationId}>
                  <td>
                    {p.name}
                    <div className="caption">
                      {p.type} · {p.country}
                    </div>
                  </td>
                  <td>{p.bookings}</td>
                  <td>{p.roomNights}</td>
                  <td>
                    {p.netRevenue != null && p.roomNights > 0
                      ? Math.round(p.netRevenue / p.roomNights).toLocaleString()
                      : '—'}
                  </td>
                  <td>{p.commissionPct ?? 0}%</td>
                  <td>{Math.round(p.share * 100)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (card.type === 'promotions' && Array.isArray(card.data) && card.data.length) {
    return (
      <div className="cc-card">
        <div className="eyebrow" style={{ marginBottom: 10 }}>
          Promotions
        </div>
        {card.data.slice(0, 6).map((p: any) => (
          <div className="spread" key={p.id} style={{ padding: '5px 0' }}>
            <span>
              {p.name} <span className="mono muted">{p.code}</span>
            </span>
            <span
              className={`badge ${p.status === 'ACTIVE' ? 'success' : p.status === 'CANCELLED' ? 'danger' : 'warning'}`}
            >
              {p.status} v{p.version}
            </span>
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function Metric({ label, value, tone }: { label: string; value: any; tone?: string }) {
  return (
    <div>
      <div className="cc-metric-value" style={{ color: tone === 'warning' ? 'var(--color-warning)' : undefined }}>
        {value}
      </div>
      <div className="caption">{label}</div>
    </div>
  );
}

/**
 * The gate. Counts first, then the sentence, then the buttons — a proposal has
 * to be refusable at a glance.
 */
function Proposal({
  action,
  busy,
  onConfirm,
  onDiscard,
}: {
  action: any;
  busy: boolean;
  onConfirm: (id: string) => void;
  onDiscard: (id: string) => void;
}) {
  const sim = action.simulation;
  const policy = action.policyDecision;
  const awaiting = action.status === 'AWAITING_CONFIRMATION';
  const denied = action.status === 'REJECTED' && policy && !policy.allowed;

  return (
    <div className={`cc-proposal ${denied ? 'denied' : ''}`}>
      <div className="spread" style={{ marginBottom: 8 }}>
        <div className="row wrap">
          <span className="badge">{action.intent}</span>
          <span
            className={`badge ${action.riskLevel === 'HIGH' ? 'danger' : action.riskLevel === 'MEDIUM' ? 'warning' : ''}`}
          >
            {action.riskLevel} risk
          </span>
          {action.requiresStepUp && <span className="badge warning">step-up</span>}
        </div>
        <span className="caption">
          {action.status === 'EXECUTED'
            ? 'applied'
            : action.status === 'REJECTED'
              ? 'not applied'
              : 'awaiting your confirmation'}
        </span>
      </div>

      {sim?.confirmationPrompt && <p style={{ marginBottom: 8 }}>{sim.confirmationPrompt}</p>}

      {sim?.blastRadius && (
        <div className="cc-blast">
          <Blast label="ARI cells" value={sim.blastRadius.ariCells} />
          <Blast label="Stay dates" value={sim.blastRadius.stayDates} />
          <Blast label="Rate plans" value={sim.blastRadius.ratePlans} />
          {sim.projections?.avgBefore != null && (
            <Blast
              label="Average"
              value={`${Math.round(sim.projections.avgBefore).toLocaleString()} → ${Math.round(sim.projections.avgAfter ?? 0).toLocaleString()}`}
            />
          )}
        </div>
      )}

      {sim?.warnings?.map((w: string) => (
        <div className="cc-warn" key={w}>
          ⚠ {w}
        </div>
      ))}
      {sim?.blockers?.map((b: string) => (
        <div className="cc-warn danger" key={b}>
          ✕ {b}
        </div>
      ))}

      {denied && (
        <div className="cc-warn danger">
          ✕ {policy.denialReason}
        </div>
      )}

      {awaiting && (
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn-primary btn-sm" disabled={busy} onClick={() => onConfirm(action.id)}>
            Confirm and apply
          </button>
          <button className="btn-sm" disabled={busy} onClick={() => onDiscard(action.id)}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

function Blast({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div className="cc-blast-value">{value}</div>
      <div className="caption">{label}</div>
    </div>
  );
}
