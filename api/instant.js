'use strict';
const { route, geminiStream, httpError, cleanTask, cleanModel, cleanItem, buildRequest, normalize, SEARCH_NOTE, FINISH } = require('./_lib');

const MESSAGE_SYSTEM = 'You are a precise, thorough assistant. Follow the user’s instructions and requested output format exactly. Preserve all requested details; do not replace a requested result with a generic summary. Use supplied information and enabled search, distinguish verified facts from uncertainty, and never invent facts or claim access to files that were not provided. If essential input is missing, say exactly what is missing and ask only for that input. Be concise only when requested or when the task calls for it. ' + FINISH;
const CONTINUE = 'Your previous answer was cut off before it was finished. Continue it from the exact character where it stops. Do not repeat anything already written, do not add an introduction or a note about continuing, and keep the same format. Finish the whole task.';
// The function is limited to 60 s (vercel.json), so stop reading before that and let the page ask for the rest.
const SOFT_MS = 40000;
const HARD_MS = 52000;

// One live answer for a message or a file. A long answer comes back with incomplete: true;
// the page then sends what it has as `prior` and gets the next piece.
module.exports = route(async (req) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const useSearch = !!b.useSearch;
  const prior = typeof b.prior === 'string' ? b.prior : '';
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
  if (prior.trim()) {
    request.contents.push({ role: 'model', parts: [{ text: prior }] }, { role: 'user', parts: [{ text: CONTINUE }] });
  }

  const { data, finishReason, timedOut } = await geminiStream(
    `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent`,
    request,
    { softMs: SOFT_MS, hardMs: HARD_MS }
  );
  const out = normalize(data, { keepSpace: true });
  if (out.text.trim()) {
    // Cut by our own deadline, by the output limit, or by a dropped stream: there is more to fetch.
    if (timedOut || finishReason === 'MAX_TOKENS' || !finishReason) {
      out.incomplete = true;
      delete out.warning;
    }
  } else if (timedOut) {
    throw httpError(504, 'The answer took too long to start.');
  } else if (prior.trim() && finishReason === 'STOP') {
    delete out.error; // nothing left to add: the answer was already finished
  }
  return out;
});
