export type StreamEvent = { event: string; data: unknown };

/** Incremental SSE parser. TextDecoder retains fragmented multibyte characters. */
export async function readEventStream(stream: ReadableStream<Uint8Array>, onEvent: (event: StreamEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  function line(value: string) {
    if (value === '') {
      if (data.length) onEvent({ event, data: JSON.parse(data.join('\n')) });
      event = 'message'; data = [];
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') event = content;
    if (field === 'data') data.push(content);
  }
  function drain(final = false) {
    let offset = 0;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i] !== '\n' && buffer[i] !== '\r') continue;
      if (buffer[i] === '\r' && i === buffer.length - 1 && !final) break;
      line(buffer.slice(offset, i));
      if (buffer[i] === '\r' && buffer[i + 1] === '\n') i++;
      offset = i + 1;
    }
    buffer = buffer.slice(offset);
  }
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      drain(done);
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
