'use strict';
const { route, gemini, httpError } = require('./_lib');

module.exports = route(async (req) => {
  const name = String((req.body && req.body.name) || '');
  if (!/^batches\/[A-Za-z0-9_-]+$/.test(name)) throw httpError(400, 'Bad batch name.');
  await gemini(`/v1beta/${name}:cancel`, { method: 'POST' });
  return { ok: true };
});
