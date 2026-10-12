'use strict';
const { route, gemini, httpError, MAX_ITEMS, cleanTask, cleanModel, cleanItem, buildRequest } = require('./_lib');

// Creates ONE Gemini batch job: one request per file. The files are already uploaded,
// so this body is tiny no matter how big the documents are.
module.exports = route(async (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const task = cleanTask(b.task);
  const useSearch = !!b.useSearch;
  const items = Array.isArray(b.items) ? b.items.map(cleanItem) : [];
  if (!items.length) throw httpError(400, 'No files to process.');
  if (items.length > MAX_ITEMS) throw httpError(400, `Too many files in one batch (max ${MAX_ITEMS}).`);
  const keys = new Set();
  for (const it of items) {
    if (!/^f\d{1,4}$/.test(it.key) || keys.has(it.key)) throw httpError(400, 'Bad item key.');
    keys.add(it.key);
  }

  const requests = items.map((it) => ({ request: buildRequest(task, it, useSearch), metadata: { key: it.key } }));
  const { data } = await gemini(`/v1beta/models/${encodeURIComponent(model)}:batchGenerateContent`, {
    method: 'POST',
    json: {
      batch: {
        display_name: `docbatch-${new Date().toISOString().slice(0, 16)}`,
        input_config: { requests: { requests } },
      },
    },
  });
  if (!data.name) throw httpError(502, 'Gemini did not return a batch name.');
  return { name: data.name, count: items.length };
});
