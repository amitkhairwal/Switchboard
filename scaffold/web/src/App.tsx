import { useCallback, useEffect, useRef, useState } from 'react';

type Me = { sub: string; name?: string; workspaces: { id: string; role: string }[] };
type Conv = { contact: string; assignee: string | null; status: 'open' | 'closed'; last_activity: string; last_message: { text: string } | null };
type Msg = { direction: 'in' | 'out'; id: string; text: string; at: string; status?: 'queued' | 'sent' | 'delivered' | 'failed' };
type Thread = { contact: string; assignee: string | null; status: 'open' | 'closed'; messages: Msg[] };
type Frame = { seq: number; type: string; contact?: string };

async function api<T>(path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = still asking, null = signed out
  const [workspace, setWorkspace] = useState('');

  useEffect(() => {
    api<Me>('/api/me').then((r) => {
      if (r.status === 200) {
        setMe(r.data);
        setWorkspace(r.data.workspaces[0]?.id ?? '');
      } else setMe(null);
    }).catch(() => setMe(null));
  }, []);

  if (me === undefined) return <main className="center">Loading…</main>;
  if (me === null) {
    return (
      <main className="center">
        <h1>Switchboard</h1>
        <p>The shared inbox for your team.</p>
        <a className="button primary" href="/auth/login">Sign in</a>
      </main>
    );
  }
  if (!workspace) return <main className="center">Your account is not a member of any workspace.</main>;
  return <Inbox me={me} workspace={workspace} setWorkspace={setWorkspace} />;
}

function Inbox({ me, workspace, setWorkspace }: { me: Me; workspace: string; setWorkspace: (w: string) => void }) {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState('');
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const loadList = useCallback(async () => {
    const r = await api<{ conversations: Conv[] }>(`/api/conversations?workspace=${encodeURIComponent(workspace)}&limit=100`);
    if (r.status === 200) setConvs(r.data.conversations);
  }, [workspace]);

  const loadThread = useCallback(async () => {
    const contact = selectedRef.current;
    if (!contact) return setThread(null);
    const r = await api<Thread>(`/api/conversation?workspace=${encodeURIComponent(workspace)}&contact=${encodeURIComponent(contact)}`);
    if (r.status === 200 && selectedRef.current === contact) setThread(r.data);
  }, [workspace]);

  useEffect(() => void loadList(), [loadList]);
  useEffect(() => void loadThread(), [selected, loadThread]);

  // Live updates. After a drop, reconnect asking for everything after the last frame seen, so nothing is missed.
  useEffect(() => {
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let lastSeq: number | null = null;
    let attempt = 0;
    let closed = false;
    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
      const after = lastSeq === null ? '' : `&after=${lastSeq}`;
      socket = new WebSocket(`${scheme}://${location.host}/ws?workspace=${encodeURIComponent(workspace)}${after}`);
      socket.onopen = () => {
        attempt = 0;
        setLive(true);
        void loadList();
        void loadThread();
      };
      socket.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as Frame;
        lastSeq = frame.seq;
        clearTimeout(refresh); // a burst of frames becomes one refresh
        refresh = setTimeout(() => {
          void loadList();
          if (!frame.contact || frame.contact === selectedRef.current) void loadThread();
        }, 150);
      };
      socket.onclose = () => {
        setLive(false);
        if (closed) return;
        timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** attempt++));
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(refresh);
      socket?.close();
    };
  }, [workspace, loadList, loadThread]);

  const act = async (path: string, body: Record<string, unknown>) => {
    setNotice('');
    const r = await api<{ error?: string }>(path, { workspace, ...body });
    if (r.status >= 400) setNotice(r.status === 409 ? 'Someone else already holds this conversation.' : r.data.error ?? `Failed (${r.status})`);
    await Promise.all([loadList(), loadThread()]);
  };

  return (
    <div className="layout">
      <aside>
        <header>
          <strong>Switchboard</strong>
          <span className={live ? 'dot on' : 'dot'} title={live ? 'Live' : 'Reconnecting…'} />
        </header>
        <div className="who">
          {me.name ?? me.sub}
          {me.workspaces.length > 1 ? (
            <select value={workspace} onChange={(e) => { setSelected(null); setWorkspace(e.target.value); }}>
              {me.workspaces.map((w) => <option key={w.id} value={w.id}>{w.id} ({w.role})</option>)}
            </select>
          ) : (
            <small> · {workspace} ({me.workspaces[0].role})</small>
          )}
          <button className="link" onClick={() => api('/auth/logout', {}).then(() => location.reload())}>Sign out</button>
        </div>
        <ul className="list">
          {convs.length === 0 && <li className="empty">No conversations yet.</li>}
          {convs.map((c) => (
            <li key={c.contact} className={c.contact === selected ? 'row active' : 'row'} onClick={() => setSelected(c.contact)}>
              <div className="top"><b>{c.contact}</b><small>{time(c.last_activity)}</small></div>
              <div className="preview">{c.last_message?.text ?? ''}</div>
              <div className="tags">
                {c.status === 'closed' && <span className="tag">closed</span>}
                {c.assignee ? <span className="tag mine">{c.assignee === me.sub ? 'you' : c.assignee}</span> : <span className="tag free">unclaimed</span>}
              </div>
            </li>
          ))}
        </ul>
      </aside>

      <section>
        {!thread ? (
          <div className="center">Select a conversation.</div>
        ) : (
          <>
            <header>
              <strong>{thread.contact}</strong>
              <span className="actions">
                {thread.assignee === me.sub ? <span className="tag mine">You hold this</span> : thread.assignee ? <span className="tag">Held by {thread.assignee}</span> : (
                  <button className="button" onClick={() => act('/api/claim', { contact: thread.contact })}>Claim</button>
                )}
                <button className="button" onClick={() => act('/api/conversation/status', { contact: thread.contact, status: thread.status === 'open' ? 'closed' : 'open' })}>
                  {thread.status === 'open' ? 'Close' : 'Reopen'}
                </button>
              </span>
            </header>
            {notice && <div className="notice">{notice}</div>}
            <ol className="messages">
              {thread.messages.map((m) => (
                <li key={m.direction + m.id} className={m.direction === 'in' ? 'bubble in' : 'bubble out'}>
                  <div>{m.text}</div>
                  <small>{time(m.at)}{m.status && <span className={`status ${m.status}`}> · {m.status}</span>}</small>
                </li>
              ))}
            </ol>
            <Composer key={thread.contact} onSend={(text) => act('/api/reply', { contact: thread.contact, text })} />
          </>
        )}
      </section>
    </div>
  );
}

function Composer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await onSend(text.trim());
      setText('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="composer" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" maxLength={4096} autoFocus />
      <button className="button primary" disabled={busy || !text.trim()}>Send</button>
    </form>
  );
}
