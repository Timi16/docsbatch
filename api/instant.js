'use strict';
const { route, openaiStream, httpError, cleanTask, cleanModel, cleanItem, buildRequest, normalize, SEARCH_NOTE, FINISH, MORE, ITEMS_PER_TURN } = require('./_lib');

const MESSAGE_SYSTEM = 'You are a precise, thorough assistant. Follow the user’s instructions and requested output format exactly. Preserve all requested details; do not replace a requested result with a generic summary. Use supplied information and enabled search, distinguish verified facts from uncertainty, and never invent facts or claim access to files that were not provided. If essential input is missing, say exactly what is missing and ask only for that input. Be concise only when requested or when the task calls for it. ' + FINISH;
const CONTINUE = 'Your answer so far is above and is not finished. Continue it from the exact character where it stops. Do not repeat anything already written, do not add an introduction, a note about continuing, or any status line or count between items, and keep the same format. Carry on until the whole task is finished.';
const PACE = ` If the task is research on many items, search for each of the next items before writing it, cover no more than ${ITEMS_PER_TURN} this turn, and end with ${MORE} unless the whole task is then finished.`;
const SLOWER = ' Your last turn ran out of time before it wrote anything. This turn, research only the next 3 items, write their results, and end with ' + MORE + '.';
// The function is limited to 300 s (vercel.json), so stop reading before that and let the page ask for the rest.
const SOFT_MS = 200000;
const HARD_MS = 280000;

const MAX_HISTORY_CHARS = 60000;

// Earlier turns of the chat, newest kept first when they do not all fit.
function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  const out = [];
  let room = MAX_HISTORY_CHARS;
  for (const turn of history.slice(-40).reverse()) {
    const role = turn && turn.role === 'assistant' ? 'assistant' : 'user';
    const text = String((turn && turn.text) || '').trim();
    if (!text) continue;
    if (text.length > room) break;
    room -= text.length;
    out.unshift({ role, content: text });
  }
  return out;
}

// Models asked to continue sometimes repeat the end of the text first; drop that overlap.
function dropOverlap(prior, next) {
  const max = Math.min(prior.length, next.length, 600);
  for (let k = max; k >= 20; k--) {
    if (next.startsWith(prior.slice(-k))) return next.slice(k);
  }
  return next;
}

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
      instructions: MESSAGE_SYSTEM + (useSearch ? SEARCH_NOTE : ''),
      input: [{ role: 'user', content: message }],
    };
    if (useSearch) request.tools = [{ type: 'web_search' }];
  } else {
    const task = cleanTask(b.task);
    const item = cleanItem({ key: 'f0', name: b.name, parts: b.parts });
    request = buildRequest(task, item, useSearch);
  }
  request.input.unshift(...cleanHistory(b.history));
  if (prior.trim()) {
    request.input.push({ role: 'assistant', content: prior }, { role: 'user', content: CONTINUE + (useSearch ? PACE : '') + (b.slower ? SLOWER : '') });
  } else if (b.slower) {
    request.input.push({ role: 'user', content: SLOWER.trim() });
  }

  const { response, text: streamed, timedOut } = await openaiStream({ model, ...request }, { softMs: SOFT_MS, hardMs: HARD_MS });
  const out = response ? normalize(response) : { text: streamed, sources: [], cut: false };
  if (prior.trim()) out.text = dropOverlap(prior, out.text);
  const cut = out.cut;
  delete out.cut;
  const marker = out.text.lastIndexOf(MORE);
  if (marker >= 0 && !out.text.slice(marker + MORE.length).trim()) {
    // The model paced itself: keep this turn's results and ask for the next ones.
    out.text = out.text.slice(0, marker).trimEnd() + '\n\n';
    out.incomplete = true;
    delete out.warning;
  } else if (out.text.trim()) {
    // Cut by our own deadline or by the output limit: there is more to fetch.
    if (timedOut || cut) out.incomplete = true;
  } else if (timedOut && useSearch) {
    // Research overran the turn before writing anything: ask for smaller steps.
    return { text: '', sources: [], incomplete: true, slower: true };
  } else if (timedOut) {
    throw httpError(504, 'The answer took too long to start.');
  } else if (prior.trim() && !out.error?.startsWith('Refused')) {
    delete out.error; // nothing left to add: the answer was already finished
  }
  return out;
});
