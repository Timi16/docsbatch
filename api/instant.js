'use strict';
const { route, gemini, cleanTask, cleanModel, cleanItem, buildRequest, normalize, SEARCH_NOTE } = require('./_lib');

module.exports = route(async (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const useSearch = !!b.useSearch;
  let request;
  if (typeof b.message === 'string') {
    const message = cleanTask(b.message);
    request = {
      systemInstruction: { parts: [{ text: 'You are a helpful assistant. Answer the user clearly and accurately.' + (useSearch ? SEARCH_NOTE : '') }] },
      contents: [{ role: 'user', parts: [{ text: message }] }],
    };
    if (useSearch) request.tools = [{ googleSearch: {} }];
  } else {
    const task = cleanTask(b.task);
    const item = cleanItem({ key: 'f0', name: b.name, parts: b.parts });
    request = buildRequest(task, item, useSearch);
  }
  const { data } = await gemini(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    json: request,
  });
  return normalize(data);
});
