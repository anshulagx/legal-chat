import { useEffect, useRef, useState, type FormEvent } from 'react';

type Conversation = { id: string; title: string; updatedAt: string };
type Message = {
  id: string; conversationId: string; role: 'user' | 'assistant'; content: string;
  status: string; attemptId: string; sequence: number;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type SendBody = { message: string; clientMessageId: string; conversationId?: string };
type SendResult = { conversationId: string; userMessageId: string; attemptId: string; response: string; status: string };

export function ChatWorkspace({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState<SendBody>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const focusComposer = useRef(false);
  const viewVersion = useRef(0);
  const activeSend = useRef(false);
  const lifetime = useRef<AbortController>(new AbortController());

  useEffect(() => () => { lifetime.current.abort(); }, []);
  useEffect(() => {
    if (focusComposer.current && !sending && !retry && !loading) {
      focusComposer.current = false;
      textarea.current?.focus();
    }
  });

  async function request<T>(path: string, body?: SendBody): Promise<T> {
    const result = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: lifetime.current.signal,
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (result.status === 401) {
      onSessionExpired();
      throw new Error('Please log in again.');
    }
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.message || 'The request could not be completed.');
    return payload;
  }

  async function loadConversations(cursor?: string) {
    setListLoading(true);
    setListError('');
    try {
      const page = await request<Page<Conversation>>(`/conversations?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (lifetime.current.signal.aborted) return;
      setConversations(previous => cursor ? [...previous, ...page.items.filter(item => !previous.some(old => old.id === item.id))] : page.items);
      setNextCursor(page.nextCursor);
    } catch {
      if (!lifetime.current.signal.aborted) setListError('Could not load previous chats. Please try again.');
    } finally {
      if (!lifetime.current.signal.aborted) setListLoading(false);
    }
  }

  useEffect(() => { void loadConversations(); }, []);

  async function history(conversationId: string) {
    const collected: Message[] = [];
    let cursor: string | null = null;
    do {
      const page: Page<Message> = await request(`/chat/history?conversationId=${conversationId}&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      collected.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return collected;
  }

  async function select(conversationId?: string) {
    if (activeSend.current) return;
    const version = ++viewVersion.current;
    setSelected(conversationId);
    setMessages([]);
    setDraft('');
    setRetry(undefined);
    setProblem('');
    setHistoryOpen(false);
    setLoading(Boolean(conversationId));
    if (!conversationId) { focusComposer.current = true; return; }
    try {
      const saved = await history(conversationId);
      if (version === viewVersion.current && !lifetime.current.signal.aborted) setMessages(saved);
    } catch {
      if (version === viewVersion.current && !lifetime.current.signal.aborted) setProblem('Could not load this chat. Select it again to retry.');
    } finally {
      if (version === viewVersion.current && !lifetime.current.signal.aborted) setLoading(false);
    }
  }

  async function send(body: SendBody) {
    if (activeSend.current) return;
    activeSend.current = true;
    setSending(true);
    setProblem('');
    setRetry(body);
    if (!retry) {
      setMessages(previous => [...previous, { id: body.clientMessageId, content: body.message, role: 'user',
        conversationId: body.conversationId ?? '', sequence: previous.length, status: 'pending', attemptId: '' }]);
      setDraft('');
    }
    try {
      const result = await request<SendResult>('/chat/send', body);
      if (lifetime.current.signal.aborted) return;
      setSelected(result.conversationId);
      const deadline = Date.now() + 60000;
      let saved = await history(result.conversationId);
      while (saved.find(item => item.id === result.attemptId)?.status === 'generating') {
        if (Date.now() >= deadline) throw new Error('The reply is still pending. Retry to check the saved result.');
        await new Promise(resolve => setTimeout(resolve, 500));
        saved = await history(result.conversationId);
      }
      if (lifetime.current.signal.aborted) return;
      setMessages(saved);
      setRetry(undefined);
      void loadConversations();
      focusComposer.current = true;
    } catch (error) {
      if (!lifetime.current.signal.aborted) setProblem(error instanceof Error ? error.message : 'Could not send your question. Retry to check whether it was saved.');
    } finally {
      activeSend.current = false;
      if (!lifetime.current.signal.aborted) setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (activeSend.current || loading || retry) return;
    if (!draft.trim() || draft.trim().length > 8000) {
      setProblem('Enter a question of at most 8,000 characters.');
      textarea.current?.focus();
      return;
    }
    void send({ message: draft.trim(), clientMessageId: crypto.randomUUID(), ...(selected ? { conversationId: selected } : {}) });
  }

  const title = selected ? conversations.find(item => item.id === selected)?.title ?? 'Your chat' : 'How can we help?';
  return <div className="chat-layout">
    <button type="button" className="secondary history-toggle" aria-expanded={historyOpen} aria-controls="chat-history"
      onClick={() => setHistoryOpen(open => !open)}>Previous chats</button>
    <aside id="chat-history" className={`chat-sidebar ${historyOpen ? 'is-open' : ''}`} aria-label="Previous chats">
      <button type="button" className="secondary" disabled={sending} onClick={() => void select()}>New chat</button>
      <h2>Previous chats</h2>
      <nav aria-label="Conversations">
        {conversations.map(conversation => <button type="button" key={conversation.id} className="thread-link"
          aria-current={selected === conversation.id ? 'true' : undefined} disabled={sending}
          onClick={() => void select(conversation.id)}>{conversation.title}</button>)}
      </nav>
      {!listLoading && !listError && !conversations.length && <p>No previous chats yet.</p>}
      {listLoading && <p role="status">Loading chats…</p>}
      {listError && <><p className="error" role="alert">{listError}</p>
        <button className="secondary" onClick={() => void loadConversations()}>Retry history</button></>}
      {nextCursor && <button className="secondary" disabled={listLoading} onClick={() => void loadConversations(nextCursor)}>Load more chats</button>}
    </aside>
    <main className={`chat-main ${!selected && !messages.length ? 'fresh-chat' : ''}`}>
      <h1>{title}</h1>
      {!selected && !messages.length && <p className="chat-intro">Start a new support question, or pick up a previous chat.</p>}
      {loading && <p role="status">Loading this chat…</p>}
      <div className="message-list" aria-label="Messages">
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}>
          <h2>{message.role === 'user' ? 'You' : 'Support'}</h2>
          {message.content && <p>{message.content}</p>}
          {message.status === 'generating' && <p role="status">Preparing a reply…</p>}
          {message.role === 'assistant' && message.status === 'failed' && <p className="error">The reply could not be completed. Your question is saved.</p>}
        </article>)}
      </div>
      <p className="chat-status" role="status" aria-live="polite">{sending ? 'Saving your question and preparing a reply…' : ''}</p>
      {problem && <div className="send-error"><p id="chat-error" className="error" role="alert">{problem}</p>
        {retry && <button type="button" className="secondary" disabled={sending} onClick={() => void send(retry)}>Retry sending</button>}</div>}
      <form className="composer" onSubmit={submit} aria-busy={sending}>
        <label htmlFor="question">Your question</label>
        <textarea ref={textarea} id="question" name="question" value={draft} rows={3} maxLength={8000}
          aria-describedby={problem ? 'chat-error' : undefined} disabled={loading || Boolean(retry)}
          placeholder="Ask a support question…" onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="primary" disabled={sending || loading || Boolean(retry)}>Send question</button>
      </form>
    </main>
  </div>;
}
