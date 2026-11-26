import { getEncoding } from 'js-tiktoken';

export const extractorVersion = 'pdfjs-6.5.438-utf8-v1';
export const chunkingVersion = 'clauses-cl100k-v1';
export class ProcessingError extends Error {
  readonly code: string; readonly retryable: boolean; readonly retryAfterMs: number;
  constructor(code: string, message: string, retryable = false, retryAfterMs = 0) { super(message); this.code = code; this.retryable = retryable; this.retryAfterMs = retryAfterMs; }
}
export type ExtractedPassage = { ordinal: number; text: string; page?: number; start?: number; end?: number; heading: string; clauseRef?: string; pageHeader?: boolean };
export type ChunkInput = { ordinal: number; passageIds: string[]; anchors: { passageId: string; start: number; end: number }[]; heading: string; clauseRef?: string; searchText: string; tokenCount: number };
const tokenizer = getEncoding('cl100k_base');
export const countTokens = (text: string) => tokenizer.encode(text, [], []).length;
const isHeading = (text: string) => !text.includes('\n') && text.length <= 100 && (/^(?:\d+(?:\.\d+)*[.)]\s+|[A-Z][A-Z\s-]{4,}$)/.test(text) || !/[.!?;:]$/.test(text) && text.split(/\s+/).length <= 7);

function blocks(text: string, page?: number, initialHeading = '') {
  const result: Omit<ExtractedPassage, 'ordinal'>[] = [];
  let heading = initialHeading;
  // Preserve the decoded source including CRLF and surrogate pairs. No Unicode
  // normalization or whitespace rewriting occurs before TXT locations are set.
  for (const match of text.matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/g)) {
    const parts: { raw: string; offset: number }[] = [];
    let offset = 0;
    // Split leading heading lines iteratively; untrusted thousands-of-lines TXT
    // cannot consume the JavaScript call stack.
    for (const line of match[0].matchAll(/[^\r\n]+(?:\r?\n|$)/g)) {
      const withoutBreak = line[0].replace(/\r?\n$/, '');
      if (!isHeading(withoutBreak.trim())) break;
      parts.push({ raw: withoutBreak, offset: line.index! });
      offset = line.index! + line[0].length;
    }
    if (offset < match[0].length) parts.push({ raw: match[0].slice(offset), offset });
    for (const { raw, offset: relative } of parts) {
      const left = raw.length - raw.trimStart().length, right = raw.trimEnd().length;
      const value = raw.slice(left, right);
      if (!value) continue;
      const pageHeader = Boolean(page && page > 1 && result.length === 0 && /\s-\scontinued$/i.test(value));
      if (isHeading(value) && !pageHeader) heading = value;
      const clauseRef = heading.match(/^(\d+(?:\.\d+)*)[.)]?\s/)?.[1];
      result.push({ text: value, heading, clauseRef, ...(pageHeader ? { pageHeader } : {}), ...(page ? { page } : { start: match.index! + relative + left, end: match.index! + relative + right }) });
    }
  }
  return result;
}

export async function extractOriginal(bytes: Uint8Array, mime: string): Promise<ExtractedPassage[]> {
  let passages: Omit<ExtractedPassage, 'ordinal'>[];
  if (mime === 'text/plain') {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new ProcessingError('INVALID_UTF8', 'The text file is not valid UTF-8. Save it as UTF-8 and upload it again.'); }
    if (text.includes('\0') || [...text].filter(c => /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(c)).length > 0) throw new ProcessingError('INVALID_TEXT', 'This file contains binary data, not readable UTF-8 text.');
    if (text.trimStart().startsWith('%PDF-')) throw new ProcessingError('FORMAT_MISMATCH', 'The file contains PDF bytes but was uploaded as plain text.');
    passages = blocks(text);
  } else if (mime === 'application/pdf') {
    if (new TextDecoder('ascii').decode(bytes.slice(0, 5)) !== '%PDF-') throw new ProcessingError('MALFORMED_PDF', 'This file does not contain a valid PDF.');
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(bytes), stopAtErrors: true, useSystemFonts: true, verbosity: 0 });
    try {
      const document = await task.promise;
      if (document.numPages > 50) throw new ProcessingError('PDF_PAGE_LIMIT', 'This PDF has more than 50 pages. Upload a shorter document.');
      const metadata = await document.getMetadata();
      if (metadata.info && (metadata.info as { EncryptFilterName?: string }).EncryptFilterName) throw new ProcessingError('ENCRYPTED_PDF', 'Encrypted PDFs are not supported. Upload an unencrypted copy.');
      passages = [];
      let previousHeading = '';
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        let text = '', lastY: number | undefined;
        for (const item of content.items) {
          if (!('str' in item)) continue;
          const y = item.transform[5];
          if (lastY !== undefined && Math.abs(y - lastY) > 2 && !text.endsWith('\n')) text += '\n\n';
          else if (text && !/\s$/.test(text) && item.str && !/^\s/.test(item.str)) text += ' ';
          text += item.str;
          if (item.hasEOL) text += '\n\n';
          lastY = y;
        }
        const pageBlocks = blocks(text, number, previousHeading);
        for (const block of pageBlocks) {
          if (block.heading) previousHeading = block.heading;
          else block.heading = previousHeading;
          if (!block.clauseRef) block.clauseRef = previousHeading.match(/^(\d+(?:\.\d+)*)[.)]?\s/)?.[1];
        }
        passages.push(...pageBlocks);
        page.cleanup();
      }
    } catch (error) {
      if (error instanceof ProcessingError) throw error;
      if ((error as Error).name === 'PasswordException') throw new ProcessingError('ENCRYPTED_PDF', 'Encrypted PDFs are not supported. Upload an unencrypted copy.');
      throw new ProcessingError('MALFORMED_PDF', 'This PDF could not be read. Upload a valid digital-text PDF.');
    } finally { await task.destroy(); }
  } else throw new ProcessingError('UNSUPPORTED_TYPE', 'Only PDF and UTF-8 text are supported.');
  if (!passages.length || !/[\p{L}\p{N}]/u.test(passages.map(p => p.text).join(''))) throw new ProcessingError('NO_TEXT', 'No usable digital text was found. Image-only or scanned PDFs require OCR, which is not available.');
  return passages.map((passage, ordinal) => ({ ...passage, ordinal }));
}

export function buildChunks(passages: (ExtractedPassage & { id: string })[]): ChunkInput[] {
  type Fragment = { passageId: string; text: string; start: number; end: number; heading: string; clauseRef?: string };
  const fragments: Fragment[] = [];
  for (const passage of passages) {
    if (passage.pageHeader) continue;
    // Greedy sentence-aware splitting uses real tokenizer counts and never cuts
    // through a UTF-16 surrogate pair. Offsets remain relative to the passage.
    let start = 0;
    while (start < passage.text.length) {
      let end = Math.min(passage.text.length, start + 2048);
      while (end < passage.text.length && end - start < 65536 && countTokens(passage.text.slice(start, end)) < 500) {
        end = Math.min(passage.text.length, start + Math.min(65536, (end - start) * 2));
      }
      if (countTokens(passage.text.slice(start, end)) > 500) {
        let low = start + 1, high = end;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (countTokens(passage.text.slice(start, middle)) <= 500) low = middle; else high = middle - 1;
        }
        end = low;
        if (end < passage.text.length && /[\uD800-\uDBFF]/.test(passage.text[end - 1])) end--;
        while (countTokens(passage.text.slice(start, end)) > 500) end -= /[\uDC00-\uDFFF]/.test(passage.text[end - 1]) ? 2 : 1;
        const candidate = passage.text.slice(start, end);
        const sentence = [...candidate.matchAll(/[.!?;](?:\s|$)/g)].at(-1);
        if (sentence && sentence.index! > candidate.length / 2) end = start + sentence.index! + 1;
      }
      const text = passage.text.slice(start, end);
      fragments.push({ passageId: passage.id, text, start, end, heading: passage.heading, clauseRef: passage.clauseRef });
      start = end;
    }
  }
  const chunks: ChunkInput[] = [];
  let group: Fragment[] = [];
  function emit() {
    if (!group.length) return;
    const searchText = group.map(f => f.text).join('\n\n');
    chunks.push({ ordinal: chunks.length, passageIds: [...new Set(group.map(f => f.passageId))],
      anchors: group.map(f => ({ passageId: f.passageId, start: f.start, end: f.end })),
      heading: group[0].heading, clauseRef: group[0].clauseRef, searchText, tokenCount: countTokens(searchText) });
  }
  for (const fragment of fragments) {
    const combined = [...group, fragment].map(f => f.text).join('\n\n');
    const boundary = group.length && fragment.heading && fragment.heading !== group[0].heading;
    if (group.length && (boundary || countTokens(combined) > 700 || countTokens(group.map(f => f.text).join('\n\n')) >= 350)) {
      emit();
      let overlap = !boundary ? group.at(-1) : undefined;
      if (overlap && countTokens(`${overlap.text}\n\n${fragment.text}`) > 700) {
        let low = 0, high = overlap.text.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (countTokens(`${overlap.text.slice(middle)}\n\n${fragment.text}`) <= 700) high = middle; else low = middle + 1;
        }
        let start = low;
        if (/[\uDC00-\uDFFF]/.test(overlap.text[start] ?? '')) start++;
        while (start < overlap.text.length && countTokens(`${overlap.text.slice(start)}\n\n${fragment.text}`) > 700) {
          start += (overlap.text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1;
        }
        overlap = start < overlap.text.length ? { ...overlap, text: overlap.text.slice(start), start: overlap.start + start } : undefined;
      }
      group = overlap ? [overlap] : [];
    }
    group.push(fragment);
  }
  emit();
  return chunks;
}
