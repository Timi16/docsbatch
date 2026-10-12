'use strict';
const { route, gemini, httpError, MAX_UPLOAD_BYTES } = require('./_lib');

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') throw httpError(400, 'Send the file as raw bytes (application/octet-stream).');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser -> here (raw bytes, < 4.4 MB) -> Files API. Returns a file URI the batch can reference.
module.exports = route(async (req) => {
  const bytes = await readBody(req);
  if (!bytes.length) throw httpError(400, 'Empty file.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw httpError(413, 'File is too large for this deployment (limit about 4 MB per upload).');

  const mime = String(req.headers['x-mime-type'] || 'application/octet-stream').slice(0, 100);
  let name = 'file';
  try { name = decodeURIComponent(String(req.headers['x-file-name'] || 'file')).slice(0, 120); } catch { /* keep default */ }

  // 1) start a resumable upload session
  const start = await gemini('/upload/v1beta/files', {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw httpError(502, 'The processing service did not return an upload URL.');

  // 2) send the bytes and finalize
  const up = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: bytes,
  });
  const text = await up.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!up.ok || !data.file) throw httpError(502, (data.error && data.error.message) || `Upload failed (${up.status}).`);

  let file = data.file;
  // Audio/video can take a moment to become ACTIVE.
  for (let i = 0; i < 10 && file.state === 'PROCESSING'; i++) {
    await sleep(1500);
    file = (await gemini(`/v1beta/${file.name}`)).data;
  }
  if (file.state === 'FAILED') throw httpError(422, 'The processing service could not process this file.');
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || mime, state: file.state };
});
