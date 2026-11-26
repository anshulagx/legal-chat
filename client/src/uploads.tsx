import { useEffect, useRef, useState } from 'react';

export type Upload = { uploadId: string; versionId: string; documentId: string; filename: string; size: number; status: string; indexingStatus?: string; revision?: number; isActive?: boolean; archivedAt?: string | null; failureReason?: string; form?: { url: string; fields: Record<string, string> } };
type Pending = { file: File; clientUploadId: string; conversationId?: string; targetDocumentId?: string; reservation?: Upload; reconcile: boolean };
class ApiError extends Error { constructor(message: string, readonly code: string) { super(message); } }

export function UploadPanel({ conversationId, ensureConversation, onChanged, onBusy, onSessionExpired, shared = false, disabled = false, onVersions }: {
  conversationId?: string; ensureConversation?: () => Promise<string>; onChanged?: () => void;
  onBusy?: (busy: boolean) => void; onVersions?: (items: Upload[]) => void; onSessionExpired: () => void; shared?: boolean; disabled?: boolean;
}) {
  const [items, setItems] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState('');
  const [retry, setRetry] = useState(false);
  const [replacement, setReplacement] = useState<string>();
  const pending = useRef<Pending | undefined>(undefined);
  const active = useRef(false);
  const xhr = useRef<XMLHttpRequest | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const lifetime = useRef(new AbortController());
  const listGeneration = useRef(0);
  const path = (id?: string, target?: string) => shared ? target ? `/admin/documents/${target}/versions` : '/admin/documents' : `/conversations/${id}/attachments`;
  useEffect(() => () => { lifetime.current.abort(); xhr.current?.abort(); }, []);

  async function request<T>(url: string, body?: unknown, method?: string): Promise<T> {
    const result = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: lifetime.current.signal,
      ...(method ? { method } : {}),
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (result.status === 401) onSessionExpired();
    const payload = result.status === 204 ? {} : await result.json();
    if (!result.ok) throw new ApiError(payload.message + (payload.retryAfterSeconds ? ` Retry in ${payload.retryAfterSeconds} seconds.` : ''), payload.code);
    return payload;
  }
  async function load(id = conversationId) {
    const generation = ++listGeneration.current;
    if (!shared && !id) { setItems([]); onVersions?.([]); return; }
    try {
      const response = await request<{ items: Upload[] }>(path(id));
      if (!lifetime.current.signal.aborted && generation === listGeneration.current) { setItems(response.items); onVersions?.(response.items); }
    } catch (error) {
      if (!lifetime.current.signal.aborted && generation === listGeneration.current) setProblem(error instanceof Error ? error.message : 'Could not load files.');
    }
  }
  useEffect(() => {
    if (!active.current) { pending.current = undefined; setRetry(false); setProblem(''); }
    setItems([]);
    void load();
  }, [conversationId, shared]);
  useEffect(() => {
    if (!items.some(item => ['queued', 'indexing'].includes(item.indexingStatus ?? item.status))) return;
    const timer = setInterval(() => { if (!active.current) void load(); }, 2000);
    return () => clearInterval(timer);
  }, [items, conversationId, shared]);

  function upload(file: File, form: NonNullable<Upload['form']>) {
    return new Promise<void>((resolve, reject) => {
      const transfer = new XMLHttpRequest();
      xhr.current = transfer;
      transfer.open('POST', form.url);
      transfer.timeout = 120000;
      transfer.upload.onprogress = event => { if (event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
      transfer.onload = () => transfer.status >= 200 && transfer.status < 300 ? resolve() : reject(new Error('The file upload was rejected. Check the file or try again.'));
      transfer.onerror = () => reject(new Error('The file transfer was interrupted. Retry to check the saved upload.'));
      transfer.onabort = () => reject(new Error('The file transfer was cancelled.'));
      transfer.ontimeout = () => reject(new Error('The file transfer timed out. Retry to check the saved upload.'));
      const data = new FormData();
      for (const [key, value] of Object.entries(form.fields)) data.append(key, value);
      data.append('file', file);
      transfer.send(data);
    });
  }
  async function perform() {
    const current = pending.current;
    if (!current || active.current) return;
    active.current = true;
    setBusy(true); onBusy?.(true); setProblem(''); setProgress(0);
    try {
      if (!shared && !current.conversationId) current.conversationId = conversationId ?? await ensureConversation!();
      if (!current.reservation) current.reservation = await request<Upload>(path(current.conversationId, current.targetDocumentId), {
        filename: current.file.name, mime: current.file.type || (current.file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : 'application/pdf'),
        size: current.file.size, clientUploadId: current.clientUploadId,
      });
      let completed = ['queued', 'indexing', 'ready', 'failed'].includes(current.reservation.status);
      if (!completed && current.reconcile) {
        try { await request(`/uploads/${current.reservation.uploadId}/complete`, {}); completed = true; }
        catch (error) { if (!(error instanceof ApiError) || error.code !== 'UPLOAD_NOT_RECEIVED') throw error; }
      }
      if (!completed) {
        // Refresh the same reservation, without extending its original deadline.
        const reservation = await request<Upload>(path(current.conversationId, current.targetDocumentId), {
          filename: current.file.name, mime: current.file.type || (current.file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : 'application/pdf'),
          size: current.file.size, clientUploadId: current.clientUploadId,
        });
        current.reservation = reservation;
        if (!['queued', 'indexing', 'ready', 'failed'].includes(reservation.status)) {
          if (!reservation.form) throw new Error('This upload expired. Choose the file again to start a new upload.');
          current.reconcile = true;
          await upload(current.file, reservation.form);
          await request(`/uploads/${reservation.uploadId}/complete`, {});
        }
      }
      if (lifetime.current.signal.aborted) return;
      pending.current = undefined; setRetry(false);
      setReplacement(undefined);
      if (input.current) input.current.value = '';
      await load(current.conversationId);
      onChanged?.();
    } catch (error) {
      if (!lifetime.current.signal.aborted) { setProblem(error instanceof Error ? error.message : 'The upload could not be completed.'); setRetry(true); }
    } finally {
      active.current = false;
      if (!lifetime.current.signal.aborted) { setBusy(false); onBusy?.(false); }
    }
  }
  function choose(file?: File) {
    if (!file || active.current || disabled) return;
    const mime = file.type || (file.name.toLowerCase().endsWith('.txt') ? 'text/plain' : file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : '');
    if (!file.size || file.size > 5 * 1024 * 1024 || !['application/pdf', 'text/plain'].includes(mime)) {
      setProblem('Choose a nonempty PDF or plain text file of at most 5 MiB.'); return;
    }
    pending.current = { file, clientUploadId: crypto.randomUUID(), conversationId, targetDocumentId: replacement, reconcile: false };
    setRetry(false);
    void perform();
  }
  async function action(item: Upload, kind: 'retry' | 'archive') {
    if (active.current) return;
    active.current = true; setBusy(true); setProblem('');
    try {
      if (kind === 'archive') await request(`/admin/documents/${item.documentId}`, undefined, 'DELETE');
      else await request(shared ? `/admin/document-versions/${item.versionId}/retry` : `/conversations/${conversationId}/attachments/${item.versionId}/retry`, {});
      await load();
    } catch (error) { if (!lifetime.current.signal.aborted) setProblem(error instanceof Error ? error.message : 'The action could not be completed.'); }
    finally { active.current = false; if (!lifetime.current.signal.aborted) setBusy(false); }
  }
  const labels: Record<string, string> = { reserved: 'Waiting for upload', queued: 'Queued for processing', indexing: 'Indexing', ready: 'Ready', failed: 'Failed', expired: 'Expired' };
  return <section className="upload-panel" aria-label={shared ? 'Shared documents' : 'Chat files'}>
    <h2>{shared ? 'Shared documents' : 'Files in this chat'}</h2>
    <p>{shared ? 'Add a support document for the shared knowledge base.' : 'Attach up to five PDF or text files, each at most 5 MiB.'}</p>
    {shared && replacement && <p>Uploading a replacement. The current published revision stays available until this file is ready.
      <button type="button" className="secondary" disabled={busy} onClick={() => setReplacement(undefined)}>Add a separate document instead</button></p>}
    <label htmlFor={shared ? 'shared-file' : 'chat-file'}>{shared ? replacement ? 'Upload replacement' : 'Add shared document' : 'Attach a file'}</label>
    <input ref={input} id={shared ? 'shared-file' : 'chat-file'} type="file" accept="application/pdf,text/plain,.pdf,.txt" disabled={busy || disabled}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; choose(file); }} />
    {busy && <div role="status"><p>Uploading file… {progress}%</p><progress max={100} value={progress} aria-label="File upload progress" /></div>}
    {problem && <p className="error" role="alert">{problem}</p>}
    {retry && <button type="button" className="secondary" disabled={busy || disabled} onClick={() => void perform()}>Retry upload</button>}
    <ul>{items.map(item => <li key={item.uploadId}><strong>{item.filename}</strong> · {labels[item.status] ?? item.status}
      {shared && <> · Revision {item.revision ?? 1}{item.isActive ? ' · Published' : ''}{item.archivedAt ? ' · Archived' : ''}</>}
      {item.status === 'ready' && item.indexingStatus === 'indexing' && !item.archivedAt && <p>Rebuilding search while the published search version stays available.</p>}
      {item.failureReason && <p>{item.failureReason}</p>}
      {(item.status === 'failed' || item.indexingStatus === 'failed') && !item.archivedAt && <button type="button" className="secondary" disabled={busy} onClick={() => void action(item, 'retry')}>Retry indexing</button>}
      {shared && !item.archivedAt && <><button type="button" className="secondary" disabled={busy} onClick={() => { setReplacement(item.documentId); input.current?.focus(); }}>Replace document</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void action(item, 'archive')}>Archive document</button></>}
      </li>)}</ul>
    <p className="fixture-links">Fictional examples: <a href="/fixtures/agreement.pdf" download>Agreement (30 days)</a> · <a href="/fixtures/amendment.txt" download>Amendment (60 days)</a></p>
  </section>;
}
