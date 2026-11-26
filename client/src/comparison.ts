import type { Comparison } from './evidence';

export function validComparison(surface: Comparison) {
  try {
  if (surface?.protocolVersion !== 'v0.8' || surface.catalogVersion !== 'legal-support/1'
    || surface.component !== 'ClauseComparison' || !surface.surfaceId || !Array.isArray(surface.rows) || !surface.rows.length) return false;
  if (!Array.isArray(surface.messages) || surface.messages.length !== 2) return false;
  const [update, begin] = surface.messages as [{ surfaceUpdate?: { surfaceId?: string; components?: { id: string; component: Record<string, unknown> }[] } },
    { beginRendering?: { surfaceId?: string; root?: string; catalogId?: string } }];
  const components = update?.surfaceUpdate?.components;
  return update?.surfaceUpdate?.surfaceId === surface.surfaceId && begin?.beginRendering?.surfaceId === surface.surfaceId
    && begin.beginRendering.catalogId === 'https://legal-support.example/a2ui/catalogs/1.json'
    && begin.beginRendering.root === 'comparison' && components?.length === 1 && components[0].id === 'comparison'
    && Object.keys(components[0].component).length === 1 && Boolean(components[0].component.ClauseComparison)
    && JSON.stringify((components[0].component.ClauseComparison as { rows?: unknown }).rows) === JSON.stringify(surface.rows)
    && surface.rows.every(row => typeof row.term === 'string' && typeof row.finding === 'string'
      && [row.left, row.right].every(value => value && typeof value.versionId === 'string'
        && (value.missing === true ? !value.citation : Boolean(value.citation?.passageId && value.citation.versionId === value.versionId))));
  } catch { return false; }
}
