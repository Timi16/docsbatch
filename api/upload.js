'use strict';
const { route, gemini, httpError, MAX_UPLOAD_CHUNK_BYTES, MAX_FILE_BYTES } = require('./_lib');

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') throw httpError(400, 'Send the file as raw bytes (application/octet-stream).');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function uploadUrlFrom(req) {
  const value = String(req.headers['x-upload-url'] || '');
  let url;
  try { url = new URL(value); } catch { throw httpError(400, 'Bad upload session. Start the upload again.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'generativelanguage.googleapis.com' || url.port
    || !/^\/upload\/v1beta\/files(?:\/|$)/.test(url.pathname) || url.username || url.password || url.hash) {
    throw httpError(400, 'Bad upload session. Start the upload again.');
  }
  return url;
}

async function waitUntilReady(file) {
  for (let i = 0; i < 10 && file.state === 'PROCESSING'; i++) {
    await sleep(1500);
    file = (await gemini(`/v1beta/${file.name}`)).data;
  }
  if (file.state === 'FAILED') throw httpError(422, 'The processing service could not process this file.');
  return file;
}

module.exports = route(async (req) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const name = String(req.body.name || 'file').slice(0, 120);
    const requestedMime = String(req.body.mime || '');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(requestedMime) ? requestedMime.slice(0, 100) : 'application/octet-stream';
    const size = Number(req.body.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
      throw httpError(413, 'Files must be 20 MB or smaller.');
    }

    const start = await gemini('/upload/v1beta/files', {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ file: { display_name: name } }),
    });
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw httpError(502, 'The processing service did not return an upload URL.');
    return { uploadUrl };
  }

  const bytes = await readBody(req);
  if (!bytes.length) throw httpError(400, 'Empty file.');
  if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) throw httpError(413, 'Upload chunks must be smaller than 4 MB.');
  const offset = Number(req.headers['x-upload-offset']);
  const command = String(req.headers['x-upload-command'] || '');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + bytes.length > MAX_FILE_BYTES
    || !['upload', 'upload, finalize'].includes(command)) {
    throw httpError(400, 'Bad upload chunk. Start the upload again.');
  }

  const up = await fetch(uploadUrlFrom(req), {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Offset': String(offset),
      'X-Goog-Upload-Command': command,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });
  const text = await up.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!up.ok) throw httpError(up.status === 429 ? 429 : 502, (data.error && data.error.message) || `Upload failed (${up.status}).`);
  if (command !== 'upload, finalize') return { uploaded: bytes.length };
  if (!data.file) throw httpError(502, 'The processing service did not finish the file upload.');

  const file = await waitUntilReady(data.file);
  return { name: file.name, uri: file.uri, mimeType: file.mimeType || 'application/octet-stream', state: file.state };
});
