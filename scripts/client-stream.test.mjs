import assert from 'node:assert/strict';
import test from 'node:test';
import { readEventStream } from '../client/src/sse.ts';

async function parse(text, fragmentSize) {
  const bytes = new TextEncoder().encode(text);
  const result = [];
  await readEventStream(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += fragmentSize) controller.enqueue(bytes.slice(offset, offset + fragmentSize));
    controller.close();
  } }), event => result.push(event));
  return result;
}
test('SSE preserves fragmented UTF-8 and delimiters across every byte boundary', async () => {
  const text = ': heartbeat\r\nevent: paragraph\r\ndata: {"text":"契約 😀 café"}\r\n\r\nevent: complete\ndata: {"status":"completed"}\n\n';
  for (let size = 1; size <= 16; size++) assert.deepEqual(await parse(text, size), [
    { event: 'paragraph', data: { text: '契約 😀 café' } }, { event: 'complete', data: { status: 'completed' } },
  ]);
});
test('SSE handles multiline data, comments and CR delimiters', async () => {
  assert.deepEqual(await parse('event: paragraph\rdata: {\r: ignored\rdata: "text":"hello"}\r\r', 1), [
    { event: 'paragraph', data: { text: 'hello' } },
  ]);
});
test('SSE rejects malformed payloads and does not dispatch unfinished frames', async () => {
  await assert.rejects(parse('event: paragraph\ndata: broken\n\n', 1), SyntaxError);
  assert.deepEqual(await parse('event: paragraph\ndata: {"text":"unfinished"}', 1), []);
});

const { validComparison } = await import('../client/src/comparison.ts');
function comparison() {
  const rows = [{ term: 'Notice', finding: 'Changed', left: { versionId: 'v1', citation: { passageId: 'p1', versionId: 'v1' } }, right: { versionId: 'v2', missing: true } }];
  return { protocolVersion: 'v0.8', catalogVersion: 'legal-support/1', component: 'ClauseComparison', surfaceId: 'surface', rows,
    messages: [{ surfaceUpdate: { surfaceId: 'surface', components: [{ id: 'comparison', component: { ClauseComparison: { rows } } }] } },
      { beginRendering: { surfaceId: 'surface', root: 'comparison', catalogId: 'https://legal-support.example/a2ui/catalogs/1.json' } }] };
}
test('A2UI renderer accepts registered pinned ClauseComparison and explicit missing side', () => {
  assert.equal(validComparison(comparison()), true);
});
test('A2UI renderer rejects unknown component, protocol, catalog, inconsistent rows and invalid anchors', () => {
  for (const [key, value] of [['component', 'RawHTML'], ['protocolVersion', 'v0.9'], ['catalogVersion', 'evil/1']]) {
    assert.equal(validComparison({ ...comparison(), [key]: value }), false);
  }
  const unknownCatalog = comparison(); unknownCatalog.messages[1].beginRendering.catalogId = 'https://evil.example/catalog';
  assert.equal(validComparison(unknownCatalog), false);
  const mismatched = comparison(); mismatched.messages[0].surfaceUpdate.components[0].component.ClauseComparison.rows = [];
  assert.equal(validComparison(mismatched), false);
  const invalidAnchor = comparison(); invalidAnchor.rows[0].left.citation.versionId = 'v3';
  assert.equal(validComparison(invalidAnchor), false);
});
test('A2UI malformed surfaces fail closed without crashing the renderer', () => {
  for (const value of [null, {}, { ...comparison(), rows: [null] }, { ...comparison(), messages: [null, null] }]) {
    assert.equal(validComparison(value), false);
  }
  const badComponent = comparison(); badComponent.messages[0].surfaceUpdate.components = [null];
  assert.equal(validComparison(badComponent), false);
});
