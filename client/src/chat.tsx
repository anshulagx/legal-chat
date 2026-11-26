import { useEffect, useRef, useState, type FormEvent } from 'react';
import { UploadPanel, type Upload } from './uploads';
import { readEventStream } from './sse';
import { CitationLink, ComparisonSurface, SourceViewer, type Citation, type Paragraph, type Comparison, type EmailDraft } from './evidence';

type Conversation = { id: string; title: string; updatedAt: string };
type Message = {
  id: string; conversationId: string; role: 'user' | 'assistant'; content: string;
  status: string; attemptId: string; sequence: number; paragraphs?: Paragraph[]; citations?: Citation[];
  comparison?: Comparison; followUps?: string[]; handoffOffer?: { unresolvedQuestion: string }; draft?: EmailDraft;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type SendBody = { message: string; clientMessageId: string; conversationId?: string; selectedDocumentVersionIds?: string[] };
type SendResult = Omit<Message, 'id' | 'role' | 'content' | 'sequence'> & { userMessageId: string; response: string };

export function ChatWorkspace({ onSessionExpired, admin = false }: { onSessionExpired: () => void; admin?: boolean }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState<SendBody>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [stage, setStage] = useState('');
  const [citation, setCitation] = useState<Citation>();
  const [versions, setVersions] = useState<Upload[]>([]);
  const [selectedVersions, setSelectedVersions] = useState<string[]>([]);
  const [draftBusy, setDraftBusy] = useState<string>();
  const [copyStatus, setCopyStatus] = useState('');
  const [starters, setStarters] = useState<{ id: string; question: string }[]>([]);
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

  async function request<T>(path: string, body?: unknown): Promise<T> {
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
  useEffect(() => {
    if (selected) return;
    async function loadStarters() {
      try { const result = await request<{ items: { id: string; question: string }[] }>('/knowledge/starter-questions');
        if (!lifetime.current.signal.aborted) setStarters(result.items); } catch { /* Optional starter availability must not block the composer. */ }
    }
    void loadStarters();
    const timer = setInterval(() => void loadStarters(), 5000);
    return () => clearInterval(timer);
  }, [selected]);

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
    if (activeSend.current || uploading) return;
    const version = ++viewVersion.current;
    setSelected(conversationId);
    setSelectedVersions([]); setVersions([]);
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
    setStage('Saving your question…');
    setProblem('');
    setRetry(body);
    if (!retry) {
      setMessages(previous => [...previous, { id: body.clientMessageId, content: body.message, role: 'user',
        conversationId: body.conversationId ?? '', sequence: previous.length, status: 'pending', attemptId: '' }]);
      setDraft('');
    }
    try {
      let result: SendResult | undefined;
      let attemptId = '';
      const streamResponse = await fetch('/chat/send', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: lifetime.current.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body) });
      if (streamResponse.status === 401) { onSessionExpired(); throw new Error('Please log in again.'); }
      if (!streamResponse.ok) { const failure = await streamResponse.json(); throw new Error(failure.message || 'Could not send your question.'); }
      if (streamResponse.headers.get('content-type')?.includes('text/event-stream')) {
        if (!streamResponse.body) throw new Error('The reply stream is unavailable.');
        await readEventStream(streamResponse.body, event => {
          const value = event.data as Record<string, unknown>;
          if (event.event === 'accepted') {
            attemptId = String(value.attemptId); const conversationId = String(value.conversationId);
            setSelected(conversationId);
            result = { conversationId, userMessageId: String(value.userMessageId), attemptId, status: 'generating', response: '' };
            setMessages(previous => previous.some(item => item.id === attemptId) ? previous : [...previous, {
              id: attemptId, attemptId, conversationId, role: 'assistant', content: '', status: 'generating', sequence: previous.length, paragraphs: [] }]);
          } else if (event.event === 'progress') {
            const labels: Record<string, string> = { retrieval: 'Finding relevant sources…', retrieving: 'Finding relevant sources…', generation: 'Preparing a grounded reply…', generating: 'Preparing a grounded reply…', comparing: 'Comparing both versions…', validation: 'Checking source references…', validating: 'Checking source references…' };
            setStage(labels[String(value.stage)] ?? String(value.stage ?? 'Preparing your reply…'));
          } else if (event.event === 'paragraph') {
            const paragraph = (value.paragraph ?? value) as Paragraph;
            setMessages(previous => previous.map(item => item.id === attemptId ? { ...item,
              paragraphs: [...(item.paragraphs ?? []).filter(old => old.sequence !== paragraph.sequence), paragraph].sort((a, b) => a.sequence - b.sequence) } : item));
          } else if (event.event === 'comparison') {
            setMessages(previous => previous.map(item => item.id === attemptId ? { ...item, comparison: (value.comparison ?? value) as Comparison } : item));
          } else if (event.event === 'complete') result = value as SendResult;
          else if (event.event === 'error') throw new Error(String(value.message ?? 'The reply was interrupted. Your question and any displayed paragraphs are saved.'));
        });
        if (!result) throw new Error('The reply stream ended before completion. Retry to check the saved answer.');
      } else result = await streamResponse.json() as SendResult;
      if (!result) throw new Error('No reply was received.');
      if (lifetime.current.signal.aborted) return;
      const completed = result;
      setSelected(completed.conversationId);
      const deadline = Date.now() + 60000;
      let saved = await history(completed.conversationId);
      while (saved.find(item => item.id === completed.attemptId)?.status === 'generating') {
        if (Date.now() >= deadline) throw new Error('The reply is still pending. Retry to check the saved result.');
        await new Promise(resolve => setTimeout(resolve, 500));
        saved = await history(completed.conversationId);
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
    if (activeSend.current || uploading || loading || retry) return;
    if (!draft.trim() || draft.trim().length > 8000) {
      setProblem('Enter a question of at most 8,000 characters.');
      textarea.current?.focus();
      return;
    }
    ask(draft.trim());
  }

  function ask(message: string) {
    if (sending || uploading || loading || retry) return;
    void send({ message, clientMessageId: crypto.randomUUID(), ...(selected ? { conversationId: selected } : {}),
      ...(selectedVersions.length ? { selectedDocumentVersionIds: selectedVersions } : {}) });
  }
  async function acceptDraft(message: Message) {
    if (draftBusy) return;
    setDraftBusy(message.id); setProblem('');
    try {
      const result = await request<{ draft: EmailDraft; followUps: string[] }>(`/chat/messages/${message.id}/email-draft`, {});
      setMessages(previous => previous.map(item => item.id === message.id ? { ...item, ...result } : item));
    } catch (error) { setProblem(error instanceof Error ? error.message : 'Could not prepare the draft.'); }
    finally { setDraftBusy(undefined); }
  }
  async function copyDraft(value: EmailDraft) {
    try { await navigator.clipboard.writeText(`Subject: ${value.subject}\n\n${value.body}`); setCopyStatus('Draft copied.'); }
    catch { setCopyStatus('Copy was unavailable. Select the draft text below and copy it.'); }
  }

  const title = selected ? conversations.find(item => item.id === selected)?.title ?? 'Your chat' : 'How can we help?';
  return <div className="chat-layout">
    <button type="button" className="secondary history-toggle" aria-expanded={historyOpen} aria-controls="chat-history"
      onClick={() => setHistoryOpen(open => !open)}>Previous chats</button>
    <aside id="chat-history" className={`chat-sidebar ${historyOpen ? 'is-open' : ''}`} aria-label="Previous chats">
      <button type="button" className="secondary" disabled={sending || uploading} onClick={() => void select()}>New chat</button>
      <h2>Previous chats</h2>
      <nav aria-label="Conversations">
        {conversations.map(conversation => <button type="button" key={conversation.id} className="thread-link"
          aria-current={selected === conversation.id ? 'true' : undefined} disabled={sending || uploading}
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
      {!selected && !messages.length && Boolean(starters.length) && <div className="starter-questions" aria-label="Starter questions">
        {starters.map(item => <button type="button" className="secondary" key={item.id} disabled={sending || uploading || loading || Boolean(retry)}
          onClick={() => void send({ message: item.question, clientMessageId: crypto.randomUUID() })}>{item.question}</button>)}
      </div>}
      {loading && <p role="status">Loading this chat…</p>}
      <div className="message-list" aria-label="Messages">
        {messages.map(message => <article className={`message message-${message.role}`} key={message.id}>
          <h2>{message.role === 'user' ? 'You' : 'Support'}</h2>
          {message.paragraphs?.length ? message.paragraphs.map(paragraph => <div className="answer-paragraph" key={paragraph.sequence}>
            <p>{paragraph.text}</p><div className="paragraph-citations">{paragraph.citations.map((item, index) => <CitationLink key={`${item.id}-${index}`} citation={item} open={setCitation} />)}</div>
          </div>) : <>{message.content && <p>{message.content}</p>}{message.citations?.map((item, index) => <CitationLink key={`${item.id}-${index}`} citation={item} open={setCitation} />)}</>}
          {message.comparison && <ComparisonSurface surface={message.comparison} open={setCitation} />}
          {message.handoffOffer && !message.draft && <div className="handoff"><p>Unresolved question: {message.handoffOffer.unresolvedQuestion}</p>
            <button type="button" className="secondary" disabled={Boolean(draftBusy)} onClick={() => void acceptDraft(message)}>{draftBusy === message.id ? 'Preparing draft…' : 'Draft an email to support'}</button></div>}
          {message.draft && <section className="email-draft" aria-label="Support email draft"><h3>Email draft</h3><p><strong>Subject:</strong> {message.draft.subject}</p>
            <textarea aria-label="Email draft text" readOnly rows={8} value={message.draft.body} /><button type="button" className="secondary" onClick={() => void copyDraft(message.draft!)}>Copy draft</button></section>}
          {message.status === 'completed' && message.followUps?.length === 2 && <div className="follow-ups" aria-label="Suggested questions">{message.followUps.map(question =>
            <button key={question} type="button" className="secondary" disabled={sending || uploading || loading || Boolean(retry)} onClick={() => ask(question)}>{question}</button>)}</div>}
          {message.status === 'generating' && <p role="status">Preparing a reply…</p>}
          {message.role === 'assistant' && message.status === 'failed' && <p className="error">The reply could not be completed. Your question is saved.</p>}
        </article>)}
      </div>
      <p className="chat-status" role="status" aria-live="polite">{sending ? stage : copyStatus}</p>
      {problem && <div className="send-error"><p id="chat-error" className="error" role="alert">{problem}</p>
        {retry && <button type="button" className="secondary" disabled={sending} onClick={() => void send(retry)}>Retry sending</button>}</div>}
      {versions.filter(item => item.status === 'ready').length >= 2 && <fieldset className="version-picker" disabled={sending || uploading || Boolean(retry)}><legend>Choose two versions to compare (optional)</legend>
        {versions.filter(item => item.status === 'ready').map(item => <label key={item.versionId}><input type="checkbox" checked={selectedVersions.includes(item.versionId)}
          disabled={!selectedVersions.includes(item.versionId) && selectedVersions.length === 2} onChange={event => setSelectedVersions(previous => event.target.checked ? [...previous, item.versionId] : previous.filter(id => id !== item.versionId))} /> {item.filename}</label>)}
      </fieldset>}
      <form className="composer" onSubmit={submit} aria-busy={sending}>
        <label htmlFor="question">Your question</label>
        <textarea ref={textarea} id="question" name="question" value={draft} rows={3} maxLength={8000}
          aria-describedby={problem ? 'chat-error' : undefined} disabled={loading || Boolean(retry)}
          placeholder="Ask a support question…" onChange={event => setDraft(event.target.value)} />
        <button type="submit" className="primary" disabled={sending || uploading || loading || Boolean(retry)}>Send question</button>
      </form>
      <UploadPanel conversationId={selected} onSessionExpired={onSessionExpired} onVersions={setVersions} onBusy={setUploading} disabled={sending || loading || Boolean(retry)}
        ensureConversation={async () => {
          const conversation = await request<Conversation>('/conversations', {});
          setSelected(conversation.id);
          return conversation.id;
        }} onChanged={() => void loadConversations()} />
      {admin && <details className="admin-uploads"><summary>Manage shared documents</summary>
        <UploadPanel shared onSessionExpired={onSessionExpired} />
      </details>}
    </main>
    {citation && <SourceViewer citation={citation} close={() => setCitation(undefined)} onSessionExpired={onSessionExpired} />}
  </div>;
}
