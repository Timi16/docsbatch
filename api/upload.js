'use strict';
const { route, openai, httpError, MAX_UPLOAD_CHUNK_BYTES, MAX_FILE_BYTES, FILE_TTL_SECONDS } = require('./_lib');

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (req.body && typeof req.body === 'object') throw httpError(400, 'Send the file as raw bytes (application/octet-stream).');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

function uploadIdFrom(req) {
  const id = String(req.headers['x-upload-id'] || '');
  if (!/^upload_[A-Za-z0-9]{1,100}$/.test(id)) throw httpError(400, 'Bad upload session. Start the upload again.');
  return id;
}

function partIdsFrom(req) {
  const value = String(req.headers['x-upload-parts'] || '');
  const ids = value ? value.split(',') : [];
  if (ids.length > 10 || ids.some((id) => !/^part_[A-Za-z0-9]{1,100}$/.test(id))) throw httpError(400, 'Bad upload chunk. Start the upload again.');
  return ids;
}

// A file goes up in chunks below Vercel's body limit: a JSON request starts an upload session,
// each raw chunk becomes one part, and the final chunk also joins the parts into a file.
module.exports = route(async (req) => {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    const name = String(req.body.name || 'file').slice(0, 120);
    const requestedMime = String(req.body.mime || '');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(requestedMime) ? requestedMime.slice(0, 100) : 'application/octet-stream';
    const size = Number(req.body.size);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_BYTES) {
      throw httpError(413, 'Files must be 20 MB or smaller.');
    }
    const upload = await openai('/uploads', {
      method: 'POST',
      json: { filename: name, purpose: 'user_data', bytes: size, mime_type: mime, expires_after: { anchor: 'created_at', seconds: FILE_TTL_SECONDS } },
    });
    if (!upload.id) throw httpError(502, 'The processing service did not start the upload.');
    return { uploadId: upload.id };
  }

  const id = uploadIdFrom(req);
  const bytes = await readBody(req);
  if (!bytes.length) throw httpError(400, 'Empty file.');
  if (bytes.length > MAX_UPLOAD_CHUNK_BYTES) throw httpError(413, 'Upload chunks must be smaller than 4 MB.');
  const command = String(req.headers['x-upload-command'] || '');
  if (!['upload', 'upload, finalize'].includes(command)) throw httpError(400, 'Bad upload chunk. Start the upload again.');

  const form = new FormData();
  form.append('data', new Blob([bytes]), 'chunk');
  const part = await openai(`/uploads/${id}/parts`, { method: 'POST', body: form });
  if (!part.id) throw httpError(502, 'The processing service did not accept the upload chunk.');
  if (command !== 'upload, finalize') return { part: part.id };

  const done = await openai(`/uploads/${id}/complete`, { method: 'POST', json: { part_ids: [...partIdsFrom(req), part.id] } });
  if (!done.file || !done.file.id) throw httpError(502, 'The processing service did not finish the file upload.');
  return { name: done.file.id, uri: done.file.id };
});
