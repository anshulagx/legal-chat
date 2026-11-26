import { useEffect, useId, useRef, useState } from 'react';
import { validComparison } from './comparison';
export { validComparison } from './comparison';

export type Citation = { id: string; versionId: string; passageId: string; quote: string; filename: string; page?: number; start?: number; end?: number };
export type Paragraph = { sequence: number; text: string; citations: Citation[] };
type Side = { versionId: string; passageId?: string; missing?: boolean; citation?: Citation };
export type Comparison = { protocolVersion: string; catalogVersion: string; component: string; surfaceId: string;
  rows: { term: string; finding: string; left: Side; right: Side }[]; messages?: unknown[] };
export type EmailDraft = { subject: string; body: string };
type Source = { text: string; quote: string; filename: string; label: string; fileUrl: string; page?: number; start?: number; end?: number;
  passages?: { id: string; text: string; page?: number; start?: number; end?: number }[] };

export function CitationLink({ citation, open }: { citation: Citation; open: (citation: Citation) => void }) {
  const [preview, setPreview] = useState(false);
  const previewId = useId();
  useEffect(() => {
    if (!preview) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') setPreview(false); };
    document.addEventListener('keydown', dismiss);
    return () => document.removeEventListener('keydown', dismiss);
  }, [preview]);
  return <span className="citation-anchor" onMouseEnter={() => setPreview(true)} onMouseLeave={() => setPreview(false)}>
    <button type="button" className="citation-button" aria-label={`View source: ${citation.filename}${citation.page ? `, page ${citation.page}` : ''}`}
      aria-describedby={preview ? previewId : undefined} onFocus={() => setPreview(true)} onBlur={() => setPreview(false)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setPreview(false); } }} onClick={() => open(citation)}>
      {citation.filename}{citation.page ? ` · p. ${citation.page}` : ''}
    </button>
    {preview && <span className="citation-preview" id={previewId} role="tooltip">{citation.quote}</span>}
  </span>;
}
function ClauseComparison({ surface, open }: { surface: Comparison; open: (citation: Citation) => void }) {
  function side(value: Side, label: string) {
    return <div className="comparison-side"><h4>{label}</h4>{value.missing ? <p>No matching evidence in this version.</p>
      : value.citation ? <><blockquote>{value.citation.quote}</blockquote><CitationLink citation={value.citation} open={open} /></> : <p>Evidence unavailable.</p>}</div>;
  }
  return <section className="comparison" aria-label="Clause comparison"><h3>Agreement comparison</h3>
    {surface.rows.map((row, index) => <section className="comparison-row" key={index}><div className="comparison-term"><h4>{row.term}</h4><p>{row.finding}</p></div>
      {side(row.left, 'First version')}{side(row.right, 'Second version')}</section>)}
  </section>;
}
// The pinned catalog is intentionally closed: a model cannot register components.
export const comparisonCatalog = Object.freeze({ ClauseComparison });
export function ComparisonSurface({ surface, open }: { surface: Comparison; open: (citation: Citation) => void }) {
  if (!validComparison(surface)) return <p role="alert">This comparison uses an unsupported or invalid component.</p>;
  const Renderer = comparisonCatalog.ClauseComparison;
  const component = (surface.messages![0] as { surfaceUpdate: { components: { component: { ClauseComparison: { rows: Comparison['rows'] } } }[] } }).surfaceUpdate.components[0].component.ClauseComparison;
  return <Renderer surface={{ ...surface, rows: component.rows }} open={open} />;
}

export function SourceViewer({ citation, close, onSessionExpired }: { citation: Citation; close: () => void; onSessionExpired: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState<Source>();
  const [problem, setProblem] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    const prior = document.activeElement as HTMLElement | null;
    setSource(undefined); setProblem('');
    if (!dialog.current?.open) dialog.current?.showModal();
    void (async () => {
      try {
        const response = await fetch(`/sources/${encodeURIComponent(citation.versionId)}/passages/${encodeURIComponent(citation.passageId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (response.status === 401) onSessionExpired();
        if (!response.ok) throw new Error('This source is unavailable or you no longer have access.');
        setSource(await response.json());
      } catch (error) { if (!controller.signal.aborted) setProblem(error instanceof Error ? error.message : 'Could not open this source.'); }
    })();
    return () => { controller.abort(); prior?.focus(); };
  }, [citation.versionId, citation.passageId]);
  return <dialog ref={dialog} className="source-dialog" aria-labelledby="source-title" onCancel={close}>
    <div className="source-heading"><h2 id="source-title">{source?.filename ?? citation.filename}</h2><button type="button" className="secondary" onClick={close} autoFocus>Close source</button></div>
    {problem && <p role="alert" className="error">{problem}</p>}
    {!source && !problem && <p role="status">Opening source…</p>}
    {source && <><p>{source.label}{source.page ? ` · Page ${source.page}` : source.start !== undefined ? ` · Characters ${source.start}–${source.end}` : ''}</p>
      <h3>Exact cited passage</h3><blockquote><mark>{source.quote ?? source.text}</mark></blockquote>
      <a href={source.fileUrl} target="_blank" rel="noopener">Open original{source.page ? ` at page ${source.page}` : ''}</a>
      <details open><summary>Readable source text</summary>{source.passages?.length ? source.passages.map(passage => <p key={passage.id}>
        {passage.page && <span className="source-page">Page {passage.page}: </span>}{passage.id === citation.passageId ? <mark>{passage.text}</mark> : passage.text}</p>) : <p>{source.text}</p>}</details>
    </>}
  </dialog>;
}
