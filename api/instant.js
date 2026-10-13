'use strict';
const { route, gemini, cleanTask, cleanModel, cleanItem, buildRequest, normalize, SEARCH_NOTE } = require('./_lib');

const MESSAGE_SYSTEM = 'You are a precise, thorough assistant. Follow the user’s instructions and requested output format exactly. Preserve all requested details; do not replace a requested result with a generic summary. Use supplied information and enabled search, distinguish verified facts from uncertainty, and never invent facts or claim access to files that were not provided. If essential input is missing, say exactly what is missing and ask only for that input. Be concise only when requested or when the task calls for it.';

module.exports = route(async (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const useSearch = !!b.useSearch;
  let request;
  if (typeof b.message === 'string') {
    const message = cleanTask(b.message);
    request = {
      systemInstruction: { parts: [{ text: MESSAGE_SYSTEM + (useSearch ? SEARCH_NOTE : '') }] },
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
