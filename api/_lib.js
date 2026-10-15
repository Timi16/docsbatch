'use strict';
// Shared helpers for every API route. Files starting with "_" are not exposed as routes.
const crypto = require('crypto');

const BASE = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_MODELS = [DEFAULT_MODEL, 'gpt-5.6-luna'];
const MAX_UPLOAD_CHUNK_BYTES = Math.floor(4.4 * 1024 * 1024); // Vercel request bodies are capped at ~4.5 MB
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FILE_TTL_SECONDS = 48 * 3600; // uploaded files delete themselves after 48 hours
const MAX_PARTS_PER_ITEM = 45;

// Long answers are continued automatically, so the model should never stop to ask.
const FINISH = 'Complete the whole task in one answer, in full detail. Never stop partway, never shorten the result to save space, and never ask whether you should continue.';
const SYSTEM = `You process one document at a time. Do exactly what the user's task says, for this one document only. Use only what is in the document: if something is not stated, say so or leave it blank. Never invent facts, names or contact details. ${FINISH}`;
// Research on many items is spread over several turns; the model ends a turn with MORE to be called again.
const MORE = '[[CONTINUE]]';
const ITEMS_PER_TURN = 8;
const SEARCH_NOTE = `\nYou also have web search. Use it only when the task needs outside information, and keep it to the few searches you need. Research companies and public facts; do not dig into private individuals' personal lives. Say when you are unsure.
One turn has a limited time, and a turn that runs out of it is lost. When the task needs research on many items, do not try to cover them all in one turn: research only the next items in order, never more than ${ITEMS_PER_TURN} in a turn however many remain, write out their finished results in the final output format, then end the turn with a last line containing only ${MORE}. You will be called again automatically with your answer so far and must carry on from the next item. Never fill in an item from memory to go faster: every item gets its own search. Do not write notes, progress reports or summaries between turns. Leave out ${MORE} only when the entire task is finished.`;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function allowedModels() {
  const env = process.env.OPENAI_MODELS;
  const list = env ? env.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS;
  return list.length ? list : DEFAULT_MODELS;
}

function apiKey() {
  const k = process.env.OPENAI_API_KEY;
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

// Like route(), but the result streams back as one JSON event per line, so the page can show progress
// while the model works. The last line is {type: 'done', ...result} or {type: 'error', status, error}.
function streamRoute(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!checkAuth(req)) return res.status(401).json({ error: 'Wrong or missing password.' });
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit = (event) => res.write(JSON.stringify(event) + '\n');
    const ping = setInterval(() => emit({ type: 'ping' }), 15000); // keeps quiet stretches of research alive
    try {
      emit({ type: 'done', ...(await fn(req, emit)) });
    } catch (e) {
      const status = Number.isInteger(e.status) ? e.status : 500;
      if (status >= 500) console.error(e);
      emit({ type: 'error', status, error: e.message || 'Server error' });
    } finally {
      clearInterval(ping);
      res.end();
    }
  };
}

// The progress worth showing from one Responses stream event, or null.
function progressOf(event) {
  if (event.type === 'response.output_text.delta') return { type: 'text', delta: event.delta || '' };
  if (event.type === 'response.reasoning_summary_text.delta') return { type: 'think', delta: event.delta || '' };
  if (event.type === 'response.output_item.added' && event.item && event.item.type === 'reasoning') return { type: 'think' };
  if (event.type === 'response.web_search_call.searching') return { type: 'searching' };
  if (event.type === 'response.output_item.done' && event.item && event.item.type === 'web_search_call') {
    const a = event.item.action || {};
    const urls = (a.sources || []).map((s) => s && s.url).filter((u) => /^https?:\/\//.test(u || '')).slice(0, 8);
    if (a.type === 'open_page' && a.url) return { type: 'open', url: a.url };
    if (a.type === 'find_in_page' && a.url) return { type: 'find', url: a.url, pattern: String(a.pattern || '').slice(0, 120) };
    const queries = (a.queries && a.queries.length ? a.queries : [a.query]).filter(Boolean).map((q) => String(q).slice(0, 200)).slice(0, 4);
    return queries.length ? { type: 'search', queries, urls } : null;
  }
  return null;
}

function upstreamError(status, data) {
  const err = (data && data.error) || {};
  const msg = err.message || `Processing API error (${status})`;
  // No credit left will not fix itself, so it must not look like a rate limit the page keeps retrying.
  if (status === 429 && err.code === 'insufficient_quota') return httpError(402, msg);
  // Never pass 401/403 from OpenAI through: the browser would think the APP password is wrong.
  return httpError(status === 429 ? 429 : status >= 500 || status === 401 || status === 403 ? 502 : status, msg);
}

// Calls the processing API with the server-side key.
async function openai(path, { method = 'GET', json, body } = {}) {
  const h = { Authorization: `Bearer ${apiKey()}` };
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
  return data;
}

// Streams one response so a long one can be cut before the function times out. Reading stops at softMs
// once some of the answer has arrived, or at hardMs regardless. Returns the final response when it
// arrived, plus the text streamed so far for when it did not.
async function openaiStream(json, { softMs, hardMs, onProgress = () => {} }) {
  const ctrl = new AbortController();
  const started = Date.now();
  const hard = setTimeout(() => ctrl.abort(), hardMs);
  let text = '';
  let response = null;
  let timedOut = false;
  try {
    const r = await fetch(`${BASE}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...json, stream: true }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const body = await r.text();
      let data = {};
      try { data = body ? JSON.parse(body) : {}; } catch { /* use the status */ }
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
        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; }
        const progress = progressOf(event);
        if (progress) onProgress(progress);
        if (event.type === 'response.output_text.delta') text += event.delta || '';
        else if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) response = event.response;
        else if (event.type === 'error') throw upstreamError(event.code === 'insufficient_quota' ? 429 : 502, { error: event });
      }
      if (text && !response && Date.now() - started > softMs) {
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
  if (response && response.status === 'failed') {
    const err = response.error || {};
    throw upstreamError(err.code === 'rate_limit_exceeded' ? 429 : 502, { error: err });
  }
  return { response, text, timedOut: timedOut && !response };
}

// Web search runs only through your own SearXNG server (SEARXNG_URL), which is free. No paid search
// service is used: not OpenAI's built-in search, not Tavily. The model calls this as a function tool.
const SEARCH_TOOL = {
  type: 'function',
  name: 'web_search',
  description: 'Search the web. Returns up to 5 results with title, url and a text snippet. Use one short, specific query per company or fact; one search per company is usually enough. Do not repeat a search.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'The search query' } }, required: ['query'], additionalProperties: false },
  strict: true,
};
const searxngUrl = () => String(process.env.SEARXNG_URL || '').trim().replace(/\/+$/, '');
const searchConfigured = () => !!searxngUrl();
const trimResult = (x) => ({
  title: String(x.title || '').slice(0, 150),
  url: String(x.url || ''),
  content: String(x.content || '').replace(/\s+/g, ' ').slice(0, 500),
});

// One query to your SearXNG server. The X-Search-Key header is what your reverse proxy checks.
async function searxngSearch(query) {
  const params = new URLSearchParams({ q: String(query).slice(0, 300), format: 'json', language: 'en', safesearch: '0' });
  const r = await fetch(`${searxngUrl()}/search?${params}`, {
    headers: { Accept: 'application/json', 'X-Search-Key': process.env.SEARXNG_KEY || '' },
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) return { error: `Search server answered ${r.status}` };
  const data = await r.json();
  return { results: (data.results || []).filter((x) => /^https?:\/\//.test(x.url || '')).slice(0, 5).map(trimResult) };
}

// Web search goes only to your SearXNG server. A failed or empty search goes back to the model as such
// (it then marks the item unverified); nothing else is ever asked, so search never costs credits.
async function webSearch(query) {
  try {
    return { ...(await searxngSearch(query)), via: 'searxng' };
  } catch (e) {
    return { error: `Search server unreachable: ${e.message}`, via: 'searxng' };
  }
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
    if (!/^file-[A-Za-z0-9_-]{1,100}$/.test(uri)) throw httpError(400, 'Only files uploaded through this app can be used.');
    return { uri, mimeType: String((p && p.mimeType) || 'text/plain').slice(0, 100) };
  });
  const key = String(it.key || '');
  return { key, name, parts: clean };
}

// One Responses API request for one document.
function buildRequest(task, item, useSearch) {
  const content = [{ type: 'input_text', text: `FILE NAME: ${item.name}` }];
  for (const p of item.parts) {
    content.push(p.mimeType.startsWith('image/') ? { type: 'input_image', file_id: p.uri } : { type: 'input_file', file_id: p.uri });
  }
  content.push({ type: 'input_text', text: `TASK: ${task}` });
  const req = {
    instructions: SYSTEM + (useSearch ? SEARCH_NOTE : ''),
    input: [{ role: 'user', content }],
  };
  if (useSearch) req.tools = [SEARCH_TOOL];
  return req;
}

// Turns a Responses API response into { text, error?, warning?, sources, cut }.
// cut is true when the output limit stopped it. Edges are left untrimmed so a continued answer joins cleanly.
function normalize(r) {
  if (!r) return { text: '', error: 'No response', sources: [] };
  let text = '';
  let refusal = '';
  const sources = [];
  for (const item of r.output || []) {
    if (item.type !== 'message') continue;
    for (const c of item.content || []) {
      if (c.type === 'output_text') text += c.text || '';
      else if (c.type === 'refusal') refusal += c.refusal || '';
      for (const a of c.annotations || []) {
        if (a.type === 'url_citation' && a.url && !sources.some((s) => s.uri === a.url)) sources.push({ title: a.title || a.url, uri: a.url });
      }
    }
  }
  // Web search answers carry inline citation links like " ([site](url))"; they break a requested
  // format, and the page already shows the sources under the answer, so take them out of the text.
  const cited = new Set(sources.map((s) => s.uri));
  text = text.replace(/[ \t]*\(\[[^\]\n]*\]\(([^)\s]+)\)\)|[ \t]*\[[^\]\n]*\]\(([^)\s]+)\)(?=[ \t]*(?:\n|$))/g, (m, a, b) => (cited.has(a || b) ? '' : m));
  const reason = r.status === 'incomplete' && r.incomplete_details ? r.incomplete_details.reason : '';
  const out = { text, sources: sources.slice(0, 8), cut: reason === 'max_output_tokens' };
  if (!text.trim()) {
    out.error = refusal ? `Refused: ${refusal.slice(0, 300)}` : reason ? `No answer (${reason})` : 'Empty answer';
  } else if (reason && !out.cut) {
    out.warning = `Stopped early: ${reason}`;
  }
  return out;
}

module.exports = {
  BASE, MAX_UPLOAD_CHUNK_BYTES, MAX_FILE_BYTES, FILE_TTL_SECONDS, SYSTEM, SEARCH_NOTE, FINISH, MORE, ITEMS_PER_TURN,
  httpError, allowedModels, apiKey, checkAuth, route, streamRoute, openai, openaiStream, SEARCH_TOOL, searchConfigured, webSearch,
  cleanTask, cleanModel, cleanItem, buildRequest, normalize,
};
