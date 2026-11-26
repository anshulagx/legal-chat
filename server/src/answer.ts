import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { retrieveEvidence, snapshotVersions, type EvidencePassage, type EvidenceSnapshot, type SnapshotVersion } from './retrieval.ts';
import { exportAnswerTrace } from './answer-telemetry.ts';
import { openRouterGenerate, openRouterPlan } from './answer-provider.ts';

export type Citation = { id: string; versionId: string; passageId: string; quote: string; filename: string; page?: number; start?: number; end?: number };
export type Paragraph = { sequence: number; text: string; citations: Citation[] };
export type ComparisonSide = { versionId: string; passageId?: string; missing?: true; citation?: Citation };
export type ComparisonRow = { term: string; finding: string; left: ComparisonSide; right: ComparisonSide };
export const comparisonCatalogId = 'https://legal-support.example/a2ui/catalogs/1.json';
export type Comparison = { protocolVersion: 'v0.8'; catalogVersion: 'legal-support/1'; catalogId: string; component: 'ClauseComparison'; surfaceId: string; rows: ComparisonRow[];
  messages: [{ surfaceUpdate: { surfaceId: string; components: [{ id: string; component: { ClauseComparison: { rows: ComparisonRow[] } } }] } },
    { beginRendering: { surfaceId: string; root: string; catalogId: string } }] };
export type Answer = { response: string; followUps: string[]; paragraphs?: Paragraph[]; citations?: Citation[]; evidenceSnapshot?: EvidenceSnapshot;
  comparison?: Comparison; handoffOffer?: { unresolvedQuestion: string }; traceId?: string };
export type AnswerRequest = { message: string; conversationId: string; userMessageId: string; attemptId: string; ownerId?: string; selectedDocumentVersionIds?: string[]; config?: Config; signal?: AbortSignal;
  onSnapshot?: (snapshot: EvidenceSnapshot) => Promise<void>; onParagraph?: (paragraph: Paragraph) => Promise<void>; onProgress?: (stage: string) => void | Promise<void> };
type AnswerAdapter = (request: AnswerRequest) => Promise<Answer>;
export type Plan = { mode: 'answer' | 'comparison' | 'clarification'; selectedVersionIds: string[] };
export interface GroundedProvider {
  plan(request: AnswerRequest, versions: SnapshotVersion[], signal: AbortSignal): Promise<Plan>;
  generate(request: AnswerRequest, context: { passages: EvidencePassage[]; versions: SnapshotVersion[]; history: {role:string;content:string}[]; plan: Plan; correction?: string }, signal: AbortSignal,
    onParagraph?: (raw: unknown, sequence: number) => Promise<void>): Promise<unknown>;
}
let adapter: AnswerAdapter | undefined;
let testProvider: GroundedProvider | undefined;
export function setTestAnswerAdapter(value: AnswerAdapter) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Answer injection requires test execution.');
  adapter = value;
}
export function setTestGroundedProvider(value: GroundedProvider | undefined) {
  if (process.env.NODE_ENV !== 'test') throw new Error('Answer injection requires test execution.');
  testProvider = value;
}
const object = (value: unknown): Record<string, any> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid structured answer.');
  return value as Record<string, any>;
};
const bounded = (value: unknown, max = 6000): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid answer text.');
  return value.trim();
};
function citation(id: unknown, passages: EvidencePassage[]): Citation {
  const passage = passages.find(item => item.id === id);
  if (!passage) throw new Error('Citation is outside the selected evidence.');
  return { id: passage.id, passageId: passage.id, versionId: passage.versionId, quote: passage.text, filename: passage.filename,
    ...(passage.page !== undefined ? { page: passage.page } : {}), ...(passage.start !== undefined ? { start: passage.start, end: passage.end } : {}) };
}
export function validateParagraph(raw: unknown, passages: EvidencePassage[], sequence: number): Paragraph {
  const item = object(raw);
  const text = bounded(item.text);
  if (!['supported', 'gap', 'clarification'].includes(item.kind) || !Array.isArray(item.passageIds) || item.passageIds.length > 8) throw new Error('Invalid paragraph evidence.');
  if (item.kind === 'supported' && !item.passageIds.length) throw new Error('A factual paragraph must cite evidence.');
  if (item.kind !== 'supported' && item.passageIds.length) throw new Error('Only supported paragraphs carry evidence.');
  const citations = [...new Set(item.passageIds)].map(id => citation(id, passages));
  return { sequence, text, citations };
}
export function followUpQuestions(raw: unknown, comparison = false, gap = false): string[] {
  if (Array.isArray(raw) && raw.length === 2 && raw.every(item => typeof item === 'string' && item.trim() && item.length <= 240) && raw[0].trim() !== raw[1].trim()) return raw.map(item => item.trim());
  return comparison ? ['What does the notice period mean for me?', 'Which terms remain unchanged?'] : gap
    ? ['Which parts are supported by the documents?', 'What information should I ask support for?']
    : ['Which exceptions apply to this answer?', 'Where can I verify these requirements?'];
}
export function validateGroundedOutput(raw: unknown, passages: EvidencePassage[], versions: SnapshotVersion[], attemptId: string, plan?: Plan): Answer {
  const output = object(raw);
  if (!Array.isArray(output.paragraphs) || output.paragraphs.length > 12) throw new Error('Invalid answer paragraphs.');
  const paragraphs = output.paragraphs.map((item: unknown, index: number) => validateParagraph(item, passages, index));
  let comparison: Comparison | undefined;
  if (output.comparison !== null && output.comparison !== undefined) {
    const input = object(output.comparison);
    if (input.component !== 'ClauseComparison' || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 12 || versions.length !== 2 || plan && plan.mode !== 'comparison') throw new Error('Invalid comparison component.');
    const rows: ComparisonRow[] = input.rows.map((rawRow: unknown) => {
      const row = object(rawRow);
      const side = (value: unknown, version: SnapshotVersion): ComparisonSide => {
        const item = object(value);
        if (item.versionId !== version.versionId) throw new Error('Comparison side belongs to a different version.');
        if (item.missing === true) {
          if (item.passageId !== null && item.passageId !== undefined) throw new Error('A missing comparison side must not claim a source.');
          return { versionId: version.versionId, missing: true };
        }
        const anchor = citation(item.passageId, passages);
        if (anchor.versionId !== version.versionId) throw new Error('Comparison side cites a different version.');
        return { versionId: version.versionId, passageId: anchor.passageId, citation: anchor };
      };
      const left = side(row.left, versions[0]), right = side(row.right, versions[1]);
      if (left.missing && right.missing) throw new Error('A comparison must have evidence on at least one side.');
      return { term: bounded(row.term, 240), finding: bounded(row.finding, 2000), left, right };
    });
    const surfaceId = `comparison-${attemptId}`;
    comparison = { protocolVersion: 'v0.8', catalogVersion: 'legal-support/1', catalogId: comparisonCatalogId, component: 'ClauseComparison', surfaceId, rows,
      messages: [{ surfaceUpdate: { surfaceId, components: [{ id: 'comparison', component: { ClauseComparison: { rows } } }] } },
        { beginRendering: { surfaceId, root: 'comparison', catalogId: comparisonCatalogId } }] };
  }
  if (!paragraphs.length && !comparison) throw new Error('An answer must contain evidence or a clarification.');
  if (plan?.mode === 'comparison' && !comparison) throw new Error('The requested comparison surface was omitted.');
  if (plan?.mode === 'clarification' && (comparison || output.paragraphs.some((item: any) => item.kind !== 'clarification'))) throw new Error('A pair clarification must not include factual claims.');
  const unresolved = output.unresolvedQuestion == null ? undefined : bounded(output.unresolvedQuestion, 2000);
  return { response: paragraphs.map(item => item.text).join('\n\n'), paragraphs,
    citations: [...new Map(paragraphs.flatMap(item => item.citations).concat(comparison?.rows.flatMap(row => [row.left.citation, row.right.citation].filter((item): item is Citation => !!item)) ?? []).map(item => [item.id, item])).values()],
    ...(comparison ? { comparison } : {}), ...(unresolved ? { handoffOffer: { unresolvedQuestion: unresolved } } : {}),
    followUps: followUpQuestions(output.followUps, !!comparison, !!unresolved) };
}
export async function generateAnswer(request: AnswerRequest): Promise<Answer> {
  if (adapter) {
    const result = await adapter(request);
    if (typeof result.response !== 'string' || !result.response.trim() || result.response.length > 20000 || !Array.isArray(result.followUps) || result.followUps.some(value => typeof value !== 'string')) throw new Error('Invalid answer adapter output.');
    // Raw adapter anchors are never accepted without a source snapshot and validation.
    if (result.citations?.length || result.paragraphs?.some(item => item.citations.length)) throw new Error('Use the grounded provider fixture to test citations.');
    result.followUps = followUpQuestions(result.followUps);
    for (const paragraph of result.paragraphs ?? [{ sequence: 0, text: result.response, citations: [] }]) await request.onParagraph?.(paragraph);
    return result;
  }
  if (!request.config?.answer || !request.ownerId) throw new Error('Grounded answer generation is not configured.');
  const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(request.config.answer.deadlineMs)]) : AbortSignal.timeout(request.config.answer.deadlineMs);
  const traceId = randomUUID().replaceAll('-', '');
  const started = Date.now();
  const timings: Record<string, number> = {};
  let snapshot: EvidenceSnapshot | undefined;
  const provider = testProvider ?? { plan: openRouterPlan, generate: openRouterGenerate };
  let terminal = 'failed';
  try {
    await request.onProgress?.('retrieving');
    const available = await snapshotVersions(request.ownerId, request.conversationId, request.selectedDocumentVersionIds);
    await request.onSnapshot?.({ versions: available, keywordCandidateIds: [], vectorCandidateIds: [], selectedChunkIds: [] });
    const plan = await provider.plan(request, available, signal);
    if (!['answer', 'comparison', 'clarification'].includes(plan.mode) || !Array.isArray(plan.selectedVersionIds) || new Set(plan.selectedVersionIds).size !== plan.selectedVersionIds.length || plan.selectedVersionIds.some(id => !available.some(version => version.versionId === id))) throw new Error('Invalid evidence selection.');
    const requested = request.selectedDocumentVersionIds ?? [];
    if (requested.length === 2 && plan.mode === 'comparison') plan.selectedVersionIds = [...requested];
    if (plan.mode === 'clarification') plan.selectedVersionIds = [];
    if (requested.length && plan.selectedVersionIds.some(id => !requested.includes(id))) throw new Error('The agent changed the selected sources.');
    if (plan.mode === 'comparison' && (plan.selectedVersionIds.length !== 2 || new Set(plan.selectedVersionIds).size !== 2)) plan.mode = 'clarification';
    const selected = requested.length ? requested : plan.selectedVersionIds;
    const context = await retrieveEvidence({ ...request, ownerId: request.ownerId, config: request.config, selectedDocumentVersionIds: selected, signal, authorizedVersions: available });
    snapshot = context.snapshot; timings.retrievalMs = Date.now() - started;
    const versions = selected.length ? selected.map(id => available.find(version => version.versionId === id)!) : available;
    await request.onProgress?.(plan.mode === 'comparison' ? 'comparing' : 'generating');
    let validated: Answer | undefined;
    let correction: string | undefined;
    const emitted = new Map<number, string>();
    let blockedSequence: number | undefined;
    let validationMs = 0;
    const emit = async (raw: unknown, sequence: number) => {
      // Withhold invalid anchors while allowing later correction of that paragraph.
      let paragraph: Paragraph;
      if (blockedSequence !== undefined && sequence >= blockedSequence) return;
      if (plan.mode === 'clarification' && object(raw).kind !== 'clarification') { blockedSequence = sequence; return; }
      const validationStarted = Date.now();
      try { paragraph = validateParagraph(raw, context.passages, sequence); } catch { blockedSequence = sequence; return; }
      finally { validationMs += Date.now() - validationStarted; }
      if (emitted.has(sequence)) return;
      await request.onParagraph?.(paragraph); emitted.set(sequence, JSON.stringify(paragraph));
      timings.firstParagraphMs ??= Date.now() - started;
    };
    for (let trial = 0; trial < 2; trial++) {
      const raw = await provider.generate(request, { ...context, versions, plan, correction }, signal, trial === 0 ? emit : undefined);
      const validationStarted = Date.now();
      try { validated = validateGroundedOutput(raw, context.passages, versions, request.attemptId, plan); }
      catch (error) { correction = error instanceof Error ? error.message : 'Invalid citations.'; continue; }
      finally { validationMs += Date.now() - validationStarted; }
      if ([...emitted].some(([sequence, value]) => !validated!.paragraphs?.some(paragraph => paragraph.sequence === sequence && JSON.stringify(paragraph) === value))) throw new Error('The corrected answer changed an already emitted paragraph.');
      break;
    }
    if (!validated) throw new Error('The answer could not be grounded in the selected evidence.');
    timings.generationMs = Date.now() - started - timings.retrievalMs;
    timings.validationMs = validationMs;
    await request.onProgress?.('validating');
    for (const paragraph of validated.paragraphs ?? []) if (!emitted.has(paragraph.sequence)) {
      await request.onParagraph?.(paragraph); timings.firstParagraphMs ??= Date.now() - started;
    }
    terminal = 'completed';
    return { ...validated, evidenceSnapshot: snapshot, traceId };
  } finally {
    void exportAnswerTrace(request.config, { traceId, attemptId: request.attemptId, userMessageId: request.userMessageId, conversationId: request.conversationId,
      started, terminal, timings, snapshot }).catch(() => undefined);
  }
}
