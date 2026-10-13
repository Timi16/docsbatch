'use strict';
// Shared helpers for every API route. Files starting with "_" are not exposed as routes.
const crypto = require('crypto');

const BASE = 'https://generativelanguage.googleapis.com';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const DEFAULT_MODELS = [DEFAULT_MODEL, 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'];
const MAX_UPLOAD_CHUNK_BYTES = Math.floor(4.4 * 1024 * 1024); // Vercel request bodies are capped at ~4.5 MB
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_PARTS_PER_ITEM = 45;

// Long answers are continued automatically, so the model should never stop to ask.
const FINISH = 'Complete the whole task in one answer, in full detail. Never stop partway, never shorten the result to save space, and never ask whether you should continue.';
const SYSTEM = `You process one document at a time. Do exactly what the user's task says, for this one document only. Use only what is in the document: if something is not stated, say so or leave it blank. Never invent facts, names or contact details. ${FINISH}`;
// Research on many items is spread over several turns; the model ends a turn with MORE to be called again.
const MORE = '[[CONTINUE]]';
const ITEMS_PER_TURN = 8;
const SEARCH_NOTE = `\nYou also have Google Search. Use it only when the task needs outside information, and keep it to the few searches you need. Research companies and public facts; do not dig into private individuals' personal lives. Say when you are unsure.
One turn allows only a limited number of searches, and a turn that runs out of them is lost. When the task needs research on many items, do not try to cover them all in one turn: research only the next items in order, never more than ${ITEMS_PER_TURN} in a turn however many remain, write out their finished results in the final output format, then end the turn with a last line containing only ${MORE}. You will be called again automatically with your answer so far and must carry on from the next item. Never fill in an item from memory to go faster: every item gets its own search. Do not write notes, progress reports or summaries between turns. Leave out ${MORE} only when the entire task is finished.`;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function allowedModels() {
  const env = process.env.GEMINI_MODELS;
  const list = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  return list.length ? list : DEFAULT_MODELS;
}

function apiKey() {
  const k = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!k) throw httpError(500, 'The processing service is not configured. Ask the site owner.');
  return k;
}

function checkAuth(req) {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return true;
  const got = String(req.headers['x-app-password'] || '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(pw).digest();
  return crypto.timingSafeEqual(a, b);
}

// Wraps a route: method check, optional password check, JSON in/out, clean errors.
function route(fn, { method = 'POST', auth = true } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method !== method) {
        res.setHeader('Allow', method);
        return res.status(405).json({ error: 'Method not allowed' });
      }
      if (auth && !checkAuth(req)) throw httpError(401, 'Wrong or missing password.');
      const out = await fn(req, res);
      return res.status(200).json(out);
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (status >= 500) console.error(e);
      return res.status(status).json({ error: e.message || 'Server error' });
    }
  };
}

// Calls the processing API with the server-side key.
async function gemini(path, { method = 'GET', json, headers = {}, body } = {}) {
  const h = { 'x-goog-api-key': apiKey(), ...headers };
  let payload = body;
  if (json !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const r = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw upstreamError(r.status, data);
  return { data, headers: r.headers };
}

function upstreamError(status, data) {
  const msg = (data && data.error && data.error.message) || `Processing API error (${status})`;
  // Never pass 401/403 from Google through: the browser would think the APP password is wrong.
  return httpError(status === 429 ? 429 : status >= 500 || status === 401 || status === 403 ? 502 : status, msg);
}

const hasText = (chunk) => ((chunk.candidates && chunk.candidates[0] && chunk.candidates[0].content && chunk.candidates[0].content.parts) || [])
  .some((p) => typeof p.text === 'string' && p.text && !p.thought);

// Streams one answer so a long one can be cut before the function times out. Reading stops at softMs
// once some of the answer has arrived, or at hardMs regardless. Returns one merged response.
async function geminiStream(path, json, { softMs, hardMs }) {
  const ctrl = new AbortController();
  const started = Date.now();
  const hard = setTimeout(() => ctrl.abort(), hardMs);
  const chunks = [];
  let gotText = false;
  let timedOut = false;
  try {
    const r = await fetch(`${BASE}${path}?alt=sse`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const text = await r.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* use the status */ }
      throw upstreamError(r.status, data);
    }
    const decoder = new TextDecoder();
    let buf = '';
    for await (const piece of r.body) {
      buf += decoder.decode(piece, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const chunk = JSON.parse(line.slice(5));
          chunks.push(chunk);
          gotText = gotText || hasText(chunk);
        } catch { /* ignore a malformed event */ }
      }
      if (gotText && Date.now() - started > softMs) {
        timedOut = true;
        ctrl.abort();
        break;
      }
    }
  } catch (e) {
    if (!ctrl.signal.aborted) throw e;
    timedOut = true;
  } finally {
    clearTimeout(hard);
  }

  const parts = [];
  const groundingChunks = [];
  let finishReason;
  let promptFeedback;
  for (const chunk of chunks) {
    if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback;
    const c = chunk.candidates && chunk.candidates[0];
    if (!c) continue;
    parts.push(...((c.content && c.content.parts) || []));
    if (c.finishReason) finishReason = c.finishReason;
    groundingChunks.push(...((c.groundingMetadata && c.groundingMetadata.groundingChunks) || []));
  }
  return { data: { promptFeedback, candidates: [{ content: { parts }, finishReason, groundingMetadata: { groundingChunks } }] }, finishReason, timedOut };
}

function cleanTask(task) {
  if (typeof task !== 'string' || !task.trim()) throw httpError(400, 'Type what you want done with each file.');
  return task.trim().slice(0, 8000);
}

function cleanModel(model) {
  const list = allowedModels();
  if (!model) return list.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : list[0];
  if (!list.includes(model)) throw httpError(400, 'That model is not allowed on this deployment.');
  return model;
}

function cleanItem(it) {
  if (!it || typeof it !== 'object') throw httpError(400, 'Bad item.');
  const name = String(it.name || 'file').slice(0, 200);
  const parts = Array.isArray(it.parts) ? it.parts : [];
  if (!parts.length || parts.length > MAX_PARTS_PER_ITEM) throw httpError(400, `"${name}" has no content or too many parts.`);
  const clean = parts.map((p) => {
    const uri = String((p && p.uri) || '');
    if (!uri.startsWith(BASE + '/v1beta/files/')) throw httpError(400, 'Only files uploaded through this app can be used.');
    return { uri, mimeType: String((p && p.mimeType) || 'text/plain').slice(0, 100) };
  });
  const key = String(it.key || '');
  return { key, name, parts: clean };
}

// One GenerateContentRequest for one document.
function buildRequest(task, item, useSearch) {
  const parts = [{ text: `FILE NAME: ${item.name}` }];
  for (const p of item.parts) parts.push({ fileData: { mimeType: p.mimeType, fileUri: p.uri } });
  parts.push({ text: `TASK: ${task}` });
  const req = {
    systemInstruction: { parts: [{ text: SYSTEM + (useSearch ? SEARCH_NOTE : '') }] },
    contents: [{ role: 'user', parts }],
  };
  if (useSearch) req.tools = [{ googleSearch: {} }];
  return req;
}

// Turns a GenerateContentResponse into { text, error?, warning?, sources }.
// keepSpace leaves the edges untrimmed so a continued answer joins cleanly.
function normalize(r, { keepSpace = false } = {}) {
  if (!r) return { error: 'No response' };
  const c = r.candidates && r.candidates[0];
  const parts = (c && c.content && c.content.parts) || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  const out = { text: keepSpace ? text : text.trim() };
  if (!text.trim()) {
    out.error = r.promptFeedback && r.promptFeedback.blockReason
      ? `Blocked: ${r.promptFeedback.blockReason}`
      : c && c.finishReason && c.finishReason !== 'STOP' ? `No answer (finish reason: ${c.finishReason})` : 'Empty answer';
  } else if (c && c.finishReason && c.finishReason !== 'STOP') {
    out.warning = `Stopped early: ${c.finishReason}`;
  }
  const chunks = (c && c.groundingMetadata && c.groundingMetadata.groundingChunks) || [];
  const seen = new Set();
  out.sources = chunks
    .map((g) => g && g.web)
    .filter((w) => w && w.uri && !seen.has(w.uri) && seen.add(w.uri))
    .map((w) => ({ title: w.title || w.uri, uri: w.uri }))
    .slice(0, 8);
  return out;
}

module.exports = {
  BASE, MAX_UPLOAD_CHUNK_BYTES, MAX_FILE_BYTES, SYSTEM, SEARCH_NOTE, FINISH, MORE, ITEMS_PER_TURN,
  httpError, allowedModels, apiKey, checkAuth, route, gemini, geminiStream,
  cleanTask, cleanModel, cleanItem, buildRequest, normalize,
};
