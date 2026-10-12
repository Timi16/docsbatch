'use strict';
const { route, gemini, cleanTask, cleanModel, cleanItem, buildRequest, normalize } = require('./_lib');

module.exports = route(async (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const task = cleanTask(b.task);
  const item = cleanItem({ key: 'f0', name: b.name, parts: b.parts });
  const { data } = await gemini(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    json: buildRequest(task, item, !!b.useSearch),
  });
  return normalize(data);
});
