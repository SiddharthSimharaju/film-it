// Runs inside the sandboxed iframe. Accepts one message shape from its parent only, and answers with a PNG buffer.
window.addEventListener('message', async e => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || m.type !== 'convert' || typeof m.id !== 'number' || !(m.buffer instanceof ArrayBuffer)) return;
  try {
    const out = await heic2any({ blob: new Blob([m.buffer]), toType: 'image/png' });
    const buf = await (Array.isArray(out) ? out[0] : out).arrayBuffer();
    parent.postMessage({ type: 'done', id: m.id, buffer: buf }, '*', [buf]);
  } catch (err) {
    parent.postMessage({ type: 'error', id: m.id }, '*');
  }
});
parent.postMessage({ type: 'ready' }, '*');
