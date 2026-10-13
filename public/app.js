/* app.js - UI + flow: add files -> read & upload -> live answer per file -> show results */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const MAX_FILES = 150;
  const MAX_FILE_BYTES = window.Extract.MAX_FILE;
  const UPLOAD_CHUNK_BYTES = window.Extract.MAX_CHUNK;
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
  const STATUS_LABEL = {
    queued: 'Queued', reading: 'Reading…', uploading: 'Uploading…', ready: 'Ready',
    processing: 'Processing', processed: 'Processed', cancelled: 'Cancelled', failed: 'Failed',
  };

  const state = {
    files: [],
    busy: false,
    config: null,
    cancelRequested: false,
    abort: null,
    results: [],
    lastRun: null,
    pw: sessionStorage.getItem(SS_PW) || '',
    nextId: 1,
    formatterNoticeShown: false,
  };
  const formatterLoads = {};
  const FORMATTER_SCRIPTS = {
    markdown: 'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js',
    sanitize: 'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js',
    math: 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js',
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

  async function api(path, { method = 'GET', json, body, headers = {}, signal } = {}) {
    const h = { ...headers };
    if (state.pw) h['x-app-password'] = state.pw;
    let payload = body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch('/api/' + path, { method, headers: h, body: payload, signal });
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
  const retryDelay = (attempt) => Math.min(5000 * (2 ** Math.min(attempt, 6)), 300000);
  // A long answer is fetched in several pieces; this caps how many before giving up.
  const MAX_PIECES = 40;
  const STOPPED = new Error('Stopped.');
  // Waits before a retry, ending early when the run is stopped.
  async function pause(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !state.cancelRequested) await sleep(Math.min(250, until - Date.now()));
  }
  // One live answer. Failed requests are retried, and an answer that was cut off is
  // continued from where it stopped until it is finished, with no action from the user.
  async function ask(payload, note) {
    let text = '';
    const sources = [];
    let attempt = 0;
    for (let pieces = 1; ; pieces++) {
      let result;
      while (!result) {
        if (state.cancelRequested) throw STOPPED;
        try {
          result = await api('instant', { method: 'POST', json: text ? { ...payload, prior: text } : payload, signal: state.abort.signal });
          if (result.error) throw new Error(result.error);
        } catch (e) {
          if (state.cancelRequested) throw STOPPED;
          if (e.status === 401) throw e;
          result = null;
          attempt++;
          note(`retry ${attempt}`);
          await pause(retryDelay(attempt));
        }
      }
      attempt = 0;
      text += result.text;
      for (const source of result.sources || []) {
        if (!sources.some((seen) => seen.uri === source.uri)) sources.push(source);
      }
      if (!result.incomplete) return { text: text.trim(), warning: result.warning, sources };
      if (pieces >= MAX_PIECES) return { text: text.trim(), warning: 'This answer was too long to finish and stops early.', sources };
      note('continuing a long answer');
    }
  }
  function stopRun() {
    if (!state.busy || state.cancelRequested) return;
    state.cancelRequested = true;
    if (state.abort) state.abort.abort();
    toast('Stopping…', 'info');
  }
  function loadScript(key) {
    if (!formatterLoads[key]) {
      formatterLoads[key] = new Promise((resolve, reject) => {
        if (key === 'math') {
          window.MathJax = {
            tex: {
              inlineMath: [['\\(', '\\)'], ['$', '$']],
              displayMath: [['\\[', '\\]'], ['$$', '$$']],
              processEscapes: true,
            },
            options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'] },
            startup: { typeset: false },
          };
        }
        const script = document.createElement('script');
        script.src = FORMATTER_SCRIPTS[key];
        script.onload = resolve;
        script.onerror = () => {
          delete formatterLoads[key];
          reject(new Error(`Could not load the ${key} formatter.`));
        };
        document.head.append(script);
      });
    }
    return formatterLoads[key];
  }
  async function loadMathJax() {
    await loadScript('math');
    await window.MathJax.startup.promise;
    return window.MathJax;
  }
  async function loadMarkdownFormatter() {
    await Promise.all([loadScript('markdown'), loadScript('sanitize')]);
    return { marked: window.marked, DOMPurify: window.DOMPurify };
  }
  function setStatuses(files, status) {
    files.forEach((file) => { file.status = status; });
    renderFiles();
  }
  async function uploadFile(file) {
    if (file.blob.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than the 20 MB per-file limit.`);
    const session = await api('upload', {
      method: 'POST',
      json: { name: file.name, mime: file.mime, size: file.blob.size },
    });
    for (let offset = 0; offset < file.blob.size; offset += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.blob.size);
      const final = end === file.blob.size;
      const result = await api('upload', {
        method: 'POST',
        body: file.blob.slice(offset, end),
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upload-url': session.uploadUrl,
          'x-upload-offset': String(offset),
          'x-upload-command': final ? 'upload, finalize' : 'upload',
        },
      });
      if (final) return result;
    }
    throw new Error(`Upload did not finish for ${file.name}.`);
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
    const pctLabel = $('#progPct');
    pctLabel.hidden = pct === null;
    pctLabel.textContent = pct === null ? '' : `${Math.round(pct)}%`;
    const bar = $('#progBar');
    bar.classList.toggle('indet', pct === null);
    bar.firstElementChild.style.width = pct === null ? '' : Math.max(2, Math.min(100, pct)) + '%';
  }

  function updateRunState() {
    const btn = $('#runBtn');
    btn.disabled = state.busy;
    btn.textContent = state.busy ? 'Working…' : state.files.length ? 'Run on all files' : 'Send message';
    $('#taskLabel').textContent = state.files.length ? 'What should be done with each file?' : 'Type a message or ask a question';
    $('#task').placeholder = state.files.length
      ? 'e.g. Summarize this in 3 bullets, or: extract every name, email and phone number as JSON'
      : 'Type a message or ask a question…';
    const rerunBtn = $('#rerunBtn');
    rerunBtn.hidden = !state.lastRun;
    rerunBtn.disabled = state.busy;
    $('#runHint').textContent = !state.files.length
      ? 'Messages get a live answer. Add files to process documents.'
      : 'Every file gets a live answer. Long answers are finished automatically.';
  }

  // ---- run ---------------------------------------------------------------
  async function run() {
    if (state.busy) return;
    const task = $('#task').value.trim();
    if (!task) return toast('Type what you want done with each file.');
    if (state.config && state.config.passwordRequired && !state.pw) return needPassword();
    try { localStorage.setItem(LS_TASK, task); } catch { /* ignore */ }

    state.busy = true;
    state.cancelRequested = false;
    state.abort = new AbortController();
    $('#resCard').hidden = true;
    state.results = [];
    for (const f of state.files) { if (f.status === 'failed') { f.status = 'queued'; f.error = ''; } }
    renderFiles();

    const useSearch = $('#useSearch').checked;

    try {
      if (!state.files.length) {
        await runMessage(task, useSearch);
        return;
      }
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
              const up = await withRetry(() => uploadFile(b));
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
      state.lastRun = {
        files: ready.map((f) => ({
          id: f.id,
          name: f.name,
          uploaded: f.uploaded.map((part) => ({ ...part })),
          uploadedAt: f.uploadedAt,
        })),
        task,
        useSearch,
        expiresAt: Math.min(...ready.map((f) => f.uploadedAt + 40 * 3600 * 1000)),
      };
      renderFiles();
      await runFiles(ready, failed, { task, useSearch });
    } catch (e) {
      if (e.status === 401) needPassword('Wrong or missing password.');
      else if (e === STOPPED) toast('Stopped.', 'info');
      else toast(e.message || 'Something went wrong.');
      $('#progCard').hidden = true;
    } finally {
      state.busy = false;
      renderFiles();
    }
  }

  async function runMessage(message, useSearch) {
    const progress = (sub) => showProgress({ title: 'Answering your message', sub, pct: null, cancel: true });
    progress('Getting a live answer…');
    const result = await ask({ message, useSearch }, (what) => progress(what[0].toUpperCase() + what.slice(1) + '…'));
    state.results = [{
      name: 'Message',
      text: `**You:** ${message}\n\n**Assistant:** ${result.text}`,
      warning: result.warning,
      sources: result.sources,
    }];
    showProgress({ title: 'Finished', sub: 'Your message has been answered.', pct: 100 });
    renderResults('Reply');
  }

  async function rerun() {
    const previous = state.lastRun;
    if (state.busy || !previous) return;
    if (Date.now() >= previous.expiresAt) {
      toast('The previous upload has expired. Add the files again to rerun them.');
      return;
    }
    if (state.config && state.config.passwordRequired && !state.pw) return needPassword();
    state.busy = true;
    state.cancelRequested = false;
    state.abort = new AbortController();
    $('#resCard').hidden = true;
    state.results = [];
    renderFiles();
    try {
      const files = previous.files.map((saved) => state.files.find((file) => file.id === saved.id) || saved);
      await runFiles(files, [], previous);
    } catch (e) {
      if (e.status === 401) needPassword('Wrong or missing password.');
      else if (e === STOPPED) toast('Stopped.', 'info');
      else toast(e.message || 'Something went wrong.');
      $('#progCard').hidden = true;
    } finally {
      state.busy = false;
      renderFiles();
    }
  }

  async function runFiles(ready, failed, { task, useSearch }) {
    const rows = new Array(ready.length);
    let done = 0;
    const progress = (extra) => showProgress({
      title: 'Getting answers',
      sub: `${done} of ${ready.length} answered` + (extra ? ` · ${extra}` : ''),
      pct: (done / ready.length) * 100,
      cancel: true,
    });
    setStatuses(ready, 'processing');
    progress();
    await pool(ready, 3, async (f, i) => {
      try {
        const result = await ask({ task, useSearch, name: f.name, parts: f.uploaded }, (what) => progress(`${what} for ${f.name}`));
        rows[i] = { name: f.name, ...result };
        f.status = 'processed';
      } catch (e) {
        if (e !== STOPPED) throw e;
        return;
      }
      done++;
      renderFiles();
      state.results = [...failed, ...rows.filter(Boolean)];
      progress();
      renderResults('Results');
    });
    state.results = [...failed, ...rows.filter(Boolean)];
    if (state.cancelRequested) {
      for (const f of ready) if (f.status !== 'processed') f.status = 'cancelled';
      showProgress({ title: 'Stopped', sub: `${done} of ${ready.length} files answered`, pct: (done / ready.length) * 100 });
    } else {
      showProgress({ title: 'Finished', sub: `${done} of ${ready.length} files answered`, pct: 100 });
    }
    if (state.results.length) renderResults('Results');
  }

  // ---- results -----------------------------------------------------------
  async function renderResults(title) {
    $('#resCard').hidden = false;
    $('#resTitle').textContent = title || 'Results';
    const q = $('#resFilter').value.trim().toLowerCase();
    const list = $('#resList');
    list.replaceChildren();
    const rows = state.results.filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.text || r.error || '').toLowerCase().includes(q));
    if (!rows.length) { list.append(el('div', { class: 'empty', text: 'No results match.' })); return; }
    const openAll = rows.length <= 12;
    const formatting = [];
    for (const r of rows) {
      const ok = !r.error;
      const body = ok ? r.text : r.error;
      const links = (r.sources || []).filter((s) => /^https?:\/\//i.test(s.uri)).map((s) => el('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer', text: s.title }));
      const answer = el('div', { class: 'ans' });
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
      formatting.push(renderAnswer(answer, body));
    }
    await Promise.all(formatting);
  }

  async function renderAnswer(container, text) {
    const raw = String(text || '');
    container.textContent = raw;
    if (!container.isConnected) return;
    const mathBlocks = [];
    const tokenized = raw.replace(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\]|(?<!\$)\$(?!\$)[^\n$]+?\$)/g, (math) => {
      const token = `DOCBATCHMATHPLACEHOLDER${mathBlocks.length}END`;
      mathBlocks.push({ token, math });
      return token;
    });
    let mathJaxNeeded = false;
    try {
      const { marked, DOMPurify } = await loadMarkdownFormatter();
      if (!container.isConnected) return;
      const html = marked.parse(tokenized, { gfm: true, breaks: false });
      container.innerHTML = DOMPurify.sanitize(html);
      if (mathBlocks.length) {
        const walker = container.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        for (const node of nodes) {
          if (!node.nodeValue.includes('DOCBATCHMATHPLACEHOLDER')) continue;
          const fragment = container.ownerDocument.createDocumentFragment();
          let value = node.nodeValue;
          while (value) {
            const next = mathBlocks
              .map(({ token, math }) => ({ at: value.indexOf(token), token, math }))
              .filter((part) => part.at >= 0)
              .sort((a, b) => a.at - b.at)[0];
            if (!next) { fragment.append(container.ownerDocument.createTextNode(value)); break; }
            if (next.at) fragment.append(container.ownerDocument.createTextNode(value.slice(0, next.at)));
            fragment.append(container.ownerDocument.createTextNode(next.math));
            value = value.slice(next.at + next.token.length);
          }
          node.replaceWith(fragment);
        }
        mathJaxNeeded = true;
      }
    } catch (error) {
      if (!state.formatterNoticeShown) {
        state.formatterNoticeShown = true;
        toast(`Could not load Markdown formatting: ${error.message}. Showing the original text instead.`);
      }
      if (container.isConnected) container.textContent = raw;
      return;
    }
    if (mathJaxNeeded) {
      try {
        const mathJax = await loadMathJax();
        if (container.isConnected) await mathJax.typesetPromise([container]);
      } catch (error) {
        if (!state.formatterNoticeShown) {
          state.formatterNoticeShown = true;
          toast(`Could not load math formatting: ${error.message}. Other answer formatting is still available.`);
        }
      }
    }
  }

  async function printResults() {
    if (!state.results.length) return toast('Nothing to save yet.');
    const previousTitle = document.title;
    const previousFilter = $('#resFilter').value;
    document.title = `DocBatch results ${new Date().toISOString().slice(0, 10)}`;
    document.body.classList.add('printing');
    $('#resFilter').value = '';
    await renderResults('Results');
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

    $('#pw').value = state.pw;
    $('#pw').addEventListener('input', (e) => { state.pw = e.target.value; try { sessionStorage.setItem(SS_PW, state.pw); } catch { /* ignore */ } });
    $('#pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });

    $('#runBtn').addEventListener('click', run);
    $('#rerunBtn').addEventListener('click', rerun);
    $('#cancelBtn').addEventListener('click', stopRun);
    $('#resFilter').addEventListener('input', () => renderResults($('#resTitle').textContent));
    $('#copyAll').addEventListener('click', () => copyText(state.results.map((r) => `${r.name}\n${r.error ? 'FAILED: ' + r.error : r.text}`).join('\n\n---\n\n')));
    const menu = $('#dlMenu');
    $('#dlBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => { const b = e.target.closest('button[data-fmt]'); if (b) { exportData(b.dataset.fmt); menu.hidden = true; } });
    document.addEventListener('click', () => { menu.hidden = true; });

    try { localStorage.removeItem('docbatch.job.v1'); } catch { /* ignore */ } // left over from the old batch mode
    renderFiles();
    loadConfig();
  }

  init();
})();
