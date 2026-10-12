/* app.js - UI + flow: add files -> read & upload -> create batch job -> poll -> show results */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const MAX_FILES = 150;
  const LS_JOB = 'docbatch.job.v1';
  const LS_TASK = 'docbatch.task.v1';
  const SS_PW = 'docbatch.pw';
  const PRESETS = [
    ['Summarize', 'Summarize this document in 3 short bullet points.'],
    ['Extract details', 'Extract every person, company, email address, phone number, date and amount mentioned. Return them as JSON.'],
    ['Score the lead', 'This is a sales lead. Extract the name, company, email, phone, location, what they need and their budget. Score the lead from 1 (cold) to 10 (ready to buy), give a one-sentence reason, and suggest the next follow-up.'],
    ['Classify', 'Classify this document (invoice, contract, resume, report, email, other) and explain why in one sentence.'],
    ['Translate', 'Translate this document into English. Keep the structure.'],
    ['Proofread', 'List every spelling, grammar and clarity problem in this document, with a suggested fix for each.'],
  ];
  const STATE_LABEL = {
    PENDING: 'Waiting in the processing queue',
    RUNNING: 'Processing your files',
    SUCCEEDED: 'Finished',
    FAILED: 'The job failed',
    CANCELLED: 'Cancelled',
    EXPIRED: 'Expired',
  };
  const STATUS_LABEL = { queued: 'Queued', reading: 'Reading…', uploading: 'Uploading…', ready: 'Ready', failed: 'Failed' };

  const state = {
    files: [],
    busy: false,
    config: null,
    mode: 'quick',
    job: null,
    results: [],
    pw: sessionStorage.getItem(SS_PW) || '',
    timer: null,
    nextId: 1,
  };

  // ---- small helpers -----------------------------------------------------
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c.nodeType ? c : document.createTextNode(c));
    return n;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const fmtTime = (s) => (s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's');

  let toastTimer;
  function toast(msg, kind = 'error') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (kind === 'info' ? 'info' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 5200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied', 'info');
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied', 'info');
    }
  }

  async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
    const h = { ...headers };
    if (state.pw) h['x-app-password'] = state.pw;
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch('/api/' + path, { method, headers: h, body: payload });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: res.status === 413 ? 'File too large for this deployment.' : text.slice(0, 200) }; }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  async function withRetry(fn, tries = 3) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); } catch (e) {
        last = e;
        if (e.status && e.status < 500 && e.status !== 429) throw e;
        await sleep(1500 * (i + 1));
      }
    }
    throw last;
  }
  async function pool(items, limit, worker) {
    let i = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await worker(items[idx], idx);
      }
    });
    await Promise.all(runners);
  }
  function needPassword(msg) {
    $('#pwRow').hidden = false;
    $('#pw').focus();
    toast(msg || 'Enter the access password.');
  }

  // ---- files -------------------------------------------------------------
  const COLORS = ['#7c5cff', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#8b5cf6'];
  function colorFor(ext) {
    let h = 0;
    for (const ch of ext) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  async function addItems(items) {
    items = items.filter((it) => !String(it.name).split('/').some((seg) => seg.startsWith('.')));
    items = await window.Extract.expandZips(items);
    let added = 0;
    for (const it of items) {
      if (state.files.length >= MAX_FILES) { toast(`Limit is ${MAX_FILES} files per run.`); break; }
      if (state.files.some((f) => f.name === it.name && f.size === it.file.size)) continue;
      state.files.push({ id: state.nextId++, file: it.file, name: it.name, size: it.file.size, status: 'queued', note: '', error: '', uploaded: null, uploadedAt: 0 });
      added++;
    }
    if (!added && items.length) toast('Those files are already added.', 'info');
    renderFiles();
  }

  function renderFiles() {
    const list = $('#fileList');
    list.replaceChildren();
    for (const f of state.files) {
      const ext = (window.Extract.ext(f.name) || 'file').slice(0, 5);
      const sub = f.error ? el('small', { class: 'err', text: f.error }) : f.note ? el('small', { text: f.note }) : null;
      list.append(
        el('li', { class: 'file' },
          el('span', { class: 'ext', style: 'background:' + colorFor(ext), text: ext }),
          el('div', { class: 'fname' }, el('b', { text: f.name, title: f.name }), sub),
          el('span', { class: 'fsize', text: fmtSize(f.size) }),
          el('span', { class: 'chip ' + f.status, text: STATUS_LABEL[f.status] }),
          el('button', { class: 'x', type: 'button', 'aria-label': 'Remove ' + f.name, disabled: state.busy ? '' : null, onclick: () => { state.files = state.files.filter((x) => x.id !== f.id); renderFiles(); } }, '×')
        )
      );
    }
    $('#fileBar').hidden = !state.files.length;
    $('#fileCount').textContent = state.files.length + ' file' + (state.files.length === 1 ? '' : 's');
    updateRunState();
  }
  function setStatus(f, status) { f.status = status; renderFiles(); }

  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])];
    if (items.length && items[0].webkitGetAsEntry) {
      const entries = items.map((i) => i.webkitGetAsEntry()).filter(Boolean); // must happen synchronously
      const out = [];
      for (const e of entries) await walk(e, out, '');
      return out;
    }
    return [...dt.files].map((f) => ({ file: f, name: f.name }));
  }
  async function walk(entry, out, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, name: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, out, prefix + entry.name + '/');
      } while (batch.length);
    }
  }

  // ---- progress UI -------------------------------------------------------
  function showProgress({ title, sub = '', pct = null, meta = '', cancel = false }) {
    $('#progCard').hidden = false;
    $('#progTitle').textContent = title;
    $('#progSub').textContent = sub;
    $('#progMeta').textContent = meta;
    $('#cancelBtn').hidden = !cancel;
    const bar = $('#progBar');
    bar.classList.toggle('indet', pct === null);
    bar.firstElementChild.style.width = pct === null ? '' : Math.max(2, Math.min(100, pct)) + '%';
  }
  function startTimer(getText) {
    stopTimer();
    const t0 = Date.now();
    state.timer = setInterval(() => { $('#progSub').textContent = getText(Math.floor((Date.now() - t0) / 1000)); }, 1000);
  }
  function stopTimer() { clearInterval(state.timer); state.timer = null; }

  function updateRunState() {
    const btn = $('#runBtn');
    btn.disabled = state.busy || !state.files.length;
    btn.textContent = state.busy ? 'Working…' : 'Run on all files';
    $('#runHint').textContent = state.mode === 'batch'
      ? 'Batch jobs run in the background and may take up to 24 hours.'
      : 'Quick mode returns live answers and works best for a few files.';
  }

  // ---- run ---------------------------------------------------------------
  async function run() {
    if (state.busy) return;
    const task = $('#task').value.trim();
    if (!task) return toast('Type what you want done with each file.');
    if (!state.files.length) return toast('Add at least one file.');
    if (state.config && state.config.passwordRequired && !state.pw) return needPassword();
    try { localStorage.setItem(LS_TASK, task); } catch { /* ignore */ }

    state.busy = true;
    state.job = null;
    stopTimer();
    try { localStorage.removeItem(LS_JOB); } catch { /* ignore */ }
    $('#resCard').hidden = true;
    state.results = [];
    for (const f of state.files) { if (f.status === 'failed') { f.status = 'queued'; f.error = ''; } }
    renderFiles();

    const useSearch = $('#useSearch').checked;
    const mode = state.mode;

    try {
      // Phase 1: read every file in the browser and upload it for processing.
      const total = state.files.length;
      let finished = 0;
      showProgress({ title: 'Reading and uploading files', sub: `0 of ${total} done`, pct: 0 });
      await pool(state.files, 3, async (f) => {
        try {
          const reusable = f.uploaded && Date.now() - f.uploadedAt < 40 * 3600 * 1000;
          if (!reusable) {
            setStatus(f, 'reading');
            const prep = await window.Extract.prepare(f.file, f.name);
            f.note = prep.note || '';
            setStatus(f, 'uploading');
            const parts = [];
            for (const b of prep.blobs) {
              const up = await withRetry(() => api('upload', {
                method: 'POST',
                body: b.blob,
                headers: { 'Content-Type': 'application/octet-stream', 'x-mime-type': b.mime, 'x-file-name': encodeURIComponent(b.name) },
              }));
              parts.push({ uri: up.uri, mimeType: up.mimeType || b.mime });
            }
            f.uploaded = parts;
            f.uploadedAt = Date.now();
          }
          f.error = '';
          setStatus(f, 'ready');
        } catch (e) {
          if (e.status === 401) throw e;
          f.error = e.message || 'Could not read this file.';
          setStatus(f, 'failed');
        }
        finished++;
        showProgress({ title: 'Reading and uploading files', sub: `${finished} of ${total} done`, pct: (finished / total) * 100 });
      });

      const ready = state.files.filter((f) => f.status === 'ready');
      const failed = state.files.filter((f) => f.status === 'failed').map((f) => ({ name: f.name, error: f.error }));
      if (!ready.length) throw new Error('None of the files could be read. See the red messages above.');

      if (mode === 'quick') {
        await runQuick(ready, failed, { task, useSearch });
      } else {
        const items = ready.map((f, i) => ({ key: 'f' + i, name: f.name, parts: f.uploaded }));
        showProgress({ title: 'Creating the batch job…', pct: null });
        const created = await withRetry(() => api('submit', { method: 'POST', json: { task, useSearch, items } }));
        state.job = { name: created.name, task, items: items.map(({ key, name }) => ({ key, name })), failed, createdAt: Date.now() };
        try { localStorage.setItem(LS_JOB, JSON.stringify(state.job)); } catch { /* ignore */ }
        await pollJob();
      }
    } catch (e) {
      if (e.status === 401) needPassword('Wrong or missing password.');
      else toast(e.message || 'Something went wrong.');
      $('#progCard').hidden = true;
    } finally {
      state.busy = false;
      renderFiles();
    }
  }

  async function runQuick(ready, failed, { task, useSearch }) {
    const rows = new Array(ready.length);
    let done = 0;
    showProgress({ title: 'Getting quick answers', sub: `0 of ${ready.length} answered`, pct: 0 });
    await pool(ready, 3, async (f, i) => {
      try {
        const result = await withRetry(() => api('instant', {
          method: 'POST',
          json: { task, useSearch, name: f.name, parts: f.uploaded },
        }), 4);
        rows[i] = { name: f.name, ...result };
      } catch (e) {
        if (e.status === 401) throw e;
        rows[i] = { name: f.name, error: e.message || 'Could not process this file.' };
      }
      done++;
      state.results = [...failed, ...rows.filter(Boolean)];
      showProgress({ title: 'Getting quick answers', sub: `${done} of ${ready.length} answered`, pct: (done / ready.length) * 100 });
      renderResults('Results');
    });
    state.results = [...failed, ...rows];
    showProgress({ title: 'Finished', sub: `${ready.length - rows.filter((r) => r.error).length} of ${ready.length} files answered`, pct: 100 });
    renderResults('Results');
  }

  // ---- batch polling -----------------------------------------------------
  async function pollJob() {
    const job = state.job;
    if (!job) return;
    let delay = 5000;
    const t0 = job.createdAt || Date.now();
    startTimer((s) => `Running for ${fmtTime(s)}`);
    $('#progTitle').textContent = 'Batch job submitted';
    while (state.job === job) {
      let st;
      try {
        st = await api('status?name=' + encodeURIComponent(job.name));
      } catch (e) {
        if (e.status === 401) { stopTimer(); needPassword('Enter the access password to continue.'); return; }
        showProgress({ title: 'Connection hiccup, retrying…', sub: e.message, pct: null, cancel: true });
        await sleep(delay);
        continue;
      }
      const label = STATE_LABEL[st.stateName] || st.stateName || 'Waiting';
      const s = st.stats;
      const pct = s && s.total ? (((s.ok || 0) + (s.failed || 0)) / s.total) * 100 : null;
      const count = s && s.total ? `${(s.ok || 0) + (s.failed || 0)} of ${s.total} files done` : '';
      showProgress({ title: label, sub: count, pct: st.terminal ? 100 : pct, meta: 'Safe to close this tab; reopen it to get the results.', cancel: !st.terminal });
      if (!count) startTimer((sec) => `Running for ${fmtTime(Math.max(sec, Math.floor((Date.now() - t0) / 1000)))}`);
      else stopTimer();
      if (st.terminal) { stopTimer(); finishJob(st); return; }
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.25), 30000);
    }
  }

  function finishJob(st) {
    const job = state.job;
    if (st.stateName !== 'SUCCEEDED' || !st.results) {
      showProgress({ title: STATE_LABEL[st.stateName] || 'Finished', sub: st.error || '', pct: 100 });
      if (st.error) toast(st.error);
      return;
    }
    const byKey = new Map(job.items.map((it, i) => [it.key, { ...it, i }]));
    const rows = [];
    for (const r of st.results) {
      const it = (r.key && byKey.get(r.key)) || job.items[r.index] || { name: 'file ' + (r.index + 1) };
      rows.push({ name: it.name, text: r.text, error: r.error, warning: r.warning, sources: r.sources, _o: (byKey.get(r.key) || {}).i ?? r.index });
    }
    rows.sort((a, b) => a._o - b._o);
    state.results = [...(job.failed || []).map((x) => ({ name: x.name, error: x.error })), ...rows];
    const ok = rows.filter((r) => !r.error).length;
    showProgress({ title: 'Finished', sub: `${ok} of ${rows.length} files answered`, pct: 100 });
    renderResults('Results · ' + new Date(job.createdAt).toLocaleString());
  }

  async function cancelJob() {
    if (!state.job) return;
    try {
      await api('cancel', { method: 'POST', json: { name: state.job.name } });
      toast('Cancel requested. Waiting for confirmation…', 'info');
    } catch (e) { toast(e.message); }
  }

  // ---- results -----------------------------------------------------------
  function renderResults(title) {
    $('#resCard').hidden = false;
    $('#resTitle').textContent = title || 'Results';
    const q = $('#resFilter').value.trim().toLowerCase();
    const list = $('#resList');
    list.replaceChildren();
    const rows = state.results.filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.text || r.error || '').toLowerCase().includes(q));
    if (!rows.length) { list.append(el('div', { class: 'empty', text: 'No results match.' })); return; }
    const openAll = rows.length <= 12;
    for (const r of rows) {
      const ok = !r.error;
      const body = ok ? r.text : r.error;
      const links = (r.sources || []).filter((s) => /^https?:\/\//i.test(s.uri)).map((s) => el('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer', text: s.title }));
      const answer = el('div', { class: 'ans' });
      renderAnswer(answer, body);
      list.append(
        el('details', { class: 'res' + (ok ? '' : ' bad'), open: openAll ? '' : null },
          el('summary', {},
            el('span', { class: 'rname', text: r.name, title: r.name }),
            el('span', { class: 'badge', text: ok ? 'Done' : 'Failed' }),
            el('button', { class: 'mini', type: 'button', onclick: (e) => { e.preventDefault(); copyText(body); } }, 'Copy')
          ),
          answer,
          r.warning ? el('p', { class: 'warn', text: r.warning }) : null,
          links.length ? el('div', { class: 'srcs' }, 'Sources:', links) : null
        )
      );
    }
  }

  function renderAnswer(container, text) {
    const doc = container.ownerDocument;
    container.replaceChildren();
    const lines = String(text || '').split(/\r?\n/);
    let i = 0;

    function inline(parent, value) {
      const parts = value.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);
      for (const part of parts) {
        let node;
        if (/^`[^`]+`$/.test(part)) {
          node = doc.createElement('code');
          node.textContent = part.slice(1, -1);
        } else if (/^\*\*[^*]+\*\*$/.test(part)) {
          node = doc.createElement('strong');
          node.textContent = part.slice(2, -2);
        } else if (/^\*[^*]+\*$/.test(part)) {
          node = doc.createElement('em');
          node.textContent = part.slice(1, -1);
        } else {
          node = doc.createTextNode(part);
        }
        parent.append(node);
      }
    }

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const fence = line.match(/^```/);
      if (fence) {
        i++;
        const code = [];
        while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = doc.createElement('pre');
        pre.className = 'code-block';
        pre.textContent = code.join('\n');
        container.append(pre);
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        const node = doc.createElement(`h${Math.min(4, heading[1].length)}`);
        inline(node, heading[2]);
        container.append(node);
        i++;
        continue;
      }
      const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
      if (item) {
        const ordered = /^\d/.test(item[1]);
        const list = doc.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length) {
          const match = lines[i].match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
          if (!match || /^\d/.test(match[1]) !== ordered) break;
          const li = doc.createElement('li');
          inline(li, match[2]);
          list.append(li);
          i++;
        }
        container.append(list);
        continue;
      }
      const paragraph = doc.createElement('p');
      const textLines = [];
      while (i < lines.length && lines[i].trim()
        && !/^```/.test(lines[i])
        && !/^(#{1,6})\s+/.test(lines[i])
        && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        textLines.push(lines[i++]);
      }
      inline(paragraph, textLines.join(' '));
      container.append(paragraph);
    }
  }

  function printResults() {
    if (!state.results.length) return toast('Nothing to save yet.');
    const previousTitle = document.title;
    const previousFilter = $('#resFilter').value;
    document.title = `DocBatch results ${new Date().toISOString().slice(0, 10)}`;
    document.body.classList.add('printing');
    $('#resFilter').value = '';
    renderResults('Results');
    const details = [...$('#resList').querySelectorAll('details')];
    const previousOpen = details.map((node) => node.open);
    details.forEach((node) => { node.open = true; });
    const cleanup = () => {
      document.body.classList.remove('printing');
      document.title = previousTitle;
      $('#resFilter').value = previousFilter;
      renderResults('Results');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    window.print();
    if (!('onafterprint' in window)) {
      details.forEach((node, i) => { node.open = previousOpen[i]; });
      cleanup();
    }
  }

  function exportData(fmt) {
    const rows = state.results;
    if (!rows.length) return toast('Nothing to download yet.');
    const stamp = new Date().toISOString().slice(0, 10);
    const sources = (r) => (r.sources || []).map((s) => s.uri).join(' ');
    if (fmt === 'csv') {
      const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['file', 'status', 'answer', 'sources'].join(',')];
      for (const r of rows) lines.push([esc(r.name), esc(r.error ? 'failed' : 'done'), esc(r.error || r.text), esc(sources(r))].join(','));
      download(`docbatch-${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    } else if (fmt === 'json') {
      download(`docbatch-${stamp}.json`, JSON.stringify(rows.map((r) => ({ file: r.name, status: r.error ? 'failed' : 'done', answer: r.text || null, error: r.error || null, sources: r.sources || [] })), null, 2), 'application/json');
    } else if (fmt === 'pdf') {
      printResults();
    } else if (fmt === 'md') {
      download(`docbatch-${stamp}.md`, rows.map((r) => `## ${r.name}\n\n${r.error ? '**Failed:** ' + r.error : r.text}\n`).join('\n'), 'text/markdown');
    } else {
      download(`docbatch-${stamp}.txt`, rows.map((r) => `=== ${r.name} ===\n${r.error ? 'FAILED: ' + r.error : r.text}\n`).join('\n'), 'text/plain');
    }
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- setup -------------------------------------------------------------
  async function loadConfig() {
    try {
      const c = await api('config');
      state.config = c;
      if (!c.hasKey) {
        const p = $('#statusPill');
        p.hidden = false;
        p.textContent = 'Processing unavailable';
        toast('The server is not configured to process files. Ask the site owner.');
      }
      if (c.passwordRequired && !c.authorized) $('#pwRow').hidden = false;
    } catch (e) {
      toast('Could not reach the API: ' + e.message);
    }
  }

  function resumeSavedJob() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_JOB) || 'null'); } catch { /* ignore */ }
    if (!saved || !saved.name || !Array.isArray(saved.items)) return;
    state.job = saved;
    state.busy = true;
    renderFiles();
    showProgress({ title: 'Restoring your last job…', pct: null, cancel: true });
    pollJob().finally(() => { state.busy = false; renderFiles(); });
  }

  function init() {
    const taskBox = $('#task');
    try { taskBox.value = localStorage.getItem(LS_TASK) || ''; } catch { /* ignore */ }
    for (const [label, text] of PRESETS) {
      $('#presets').append(el('button', { type: 'button', onclick: () => { taskBox.value = text; taskBox.focus(); } }, label));
    }

    const drop = $('#drop');
    drop.addEventListener('click', () => $('#fileInput').click());
    drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } });
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
    drop.addEventListener('drop', async (e) => { if (!state.busy) addItems(await filesFromDrop(e.dataTransfer)); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    $('#fileInput').addEventListener('change', (e) => { addItems([...e.target.files].map((f) => ({ file: f, name: f.name }))); e.target.value = ''; });
    $('#folderInput').addEventListener('change', (e) => { addItems([...e.target.files].map((f) => ({ file: f, name: f.webkitRelativePath || f.name }))); e.target.value = ''; });
    $('#addFolder').addEventListener('click', () => $('#folderInput').click());
    $('#clearFiles').addEventListener('click', () => { if (!state.busy) { state.files = []; renderFiles(); } });

    $('#modeSeg').addEventListener('click', (e) => {
      const button = e.target.closest('button[data-mode]');
      if (!button) return;
      state.mode = button.dataset.mode;
      for (const option of $('#modeSeg').children) option.classList.toggle('on', option === button);
      updateRunState();
    });

    $('#pw').value = state.pw;
    $('#pw').addEventListener('input', (e) => { state.pw = e.target.value; try { sessionStorage.setItem(SS_PW, state.pw); } catch { /* ignore */ } });
    $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

    $('#runBtn').addEventListener('click', run);
    $('#cancelBtn').addEventListener('click', cancelJob);
    $('#resFilter').addEventListener('input', () => renderResults($('#resTitle').textContent));
    $('#copyAll').addEventListener('click', () => copyText(state.results.map((r) => `${r.name}\n${r.error ? 'FAILED: ' + r.error : r.text}`).join('\n\n---\n\n')));
    const menu = $('#dlMenu');
    $('#dlBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-fmt]'); if (b) { exportData(b.dataset.fmt); menu.hidden = true; } });
    document.addEventListener('click', () => { menu.hidden = true; });

    renderFiles();
    loadConfig().then(resumeSavedJob);
  }

  init();
})();
