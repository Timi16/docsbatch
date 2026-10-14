/* app.js - chat UI: chats in the sidebar, a message box with attachments, one live answer per file. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const MAX_FILES = 150;
  const MAX_FILE_BYTES = window.Extract.MAX_FILE;
  const UPLOAD_CHUNK_BYTES = window.Extract.MAX_CHUNK;
  const UPLOAD_REUSE_MS = 40 * 3600 * 1000; // uploads delete themselves after 48 h
  const LS_CHATS = 'docbatch.chats.v2';
  const LS_SEARCH = 'docbatch.search';
  const SS_PW = 'docbatch.pw';
  const MAX_CHATS = 200;
  const SUGGESTIONS = [
    ['Summarize', 'each attached file in 3 bullets', 'Summarize this document in 3 short bullet points.'],
    ['Extract details', 'people, companies, emails, dates', 'Extract every person, company, email address, phone number, date and amount mentioned. Return them as JSON.'],
    ['Score the lead', 'needs, budget, next step', 'This is a sales lead. Extract the name, company, email, phone, location, what they need and their budget. Score the lead from 1 (cold) to 10 (ready to buy), give a one-sentence reason, and suggest the next follow-up.'],
    ['Find the top executive', 'for every company in a lead list', 'For every lead in this file, find the current top executive (CEO, president, owner or founder) of the company behind the email domain. Research each unique domain once. Return every lead in the original order as: First name, email, executive name, with a blank line between records. Write REVIEW when you cannot verify it.'],
  ];

  const state = {
    chats: [],
    activeId: null,
    attachments: [],
    busy: false,
    runChatId: null,
    cancelRequested: false,
    abort: null,
    config: null,
    pw: sessionStorage.getItem(SS_PW) || '',
    useSearch: localStorage.getItem(LS_SEARCH) !== 'off',
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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtSize = (n) => (n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
  const extOf = (name) => (window.Extract.ext(name) || 'file').slice(0, 4);

  let toastTimer;
  function toast(msg, kind = 'error') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show ' + (kind === 'info' ? '' : 'error');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), 5200);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('Copied', 'info');
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
  const MAX_PIECES = 100;
  const STOPPED = new Error('Stopped.');
  // Waits before a retry, ending early when the run is stopped.
  async function pause(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !state.cancelRequested) await sleep(Math.min(250, until - Date.now()));
  }
  // One live answer. Failed requests are retried, and an answer that was cut off is continued
  // from where it stopped until it is finished, with no action from the user. onText gets the
  // text so far after every piece, so a stopped answer keeps what it had.
  async function ask(payload, { note, onText, prior = '' }) {
    let text = prior;
    const sources = [];
    let attempt = 0;
    let slower = false; // set when a turn ran out of time, so the next ones take smaller steps
    for (let pieces = 1; ; pieces++) {
      let result;
      while (!result) {
        if (state.cancelRequested) throw STOPPED;
        try {
          result = await api('instant', { method: 'POST', json: { ...payload, ...(text ? { prior: text } : {}), ...(slower ? { slower } : {}) }, signal: state.abort.signal });
          if (result.error) throw new Error(result.error);
        } catch (e) {
          if (state.cancelRequested) throw STOPPED;
          if (e.status === 401) throw e;
          // Retrying cannot fix a rejected request (bad input, no credit left): keep what was written and stop.
          if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
            if (!text.trim()) throw e;
            return { text: text.trim(), warning: `Stopped before the end: ${e.message}`, sources };
          }
          result = null;
          attempt++;
          note(`Retrying (${attempt}) · ${String(e.message || 'no answer').slice(0, 120)}`);
          await pause(retryDelay(attempt));
        }
      }
      attempt = 0;
      if (result.slower) slower = true;
      text += result.text;
      for (const source of result.sources || []) {
        if (!sources.some((seen) => seen.uri === source.uri)) sources.push(source);
      }
      onText(text, sources);
      if (!result.incomplete) return { text: text.trim(), warning: result.warning, sources };
      if (pieces >= MAX_PIECES) return { text: text.trim(), warning: 'This answer was too long to finish and stops early.', sources };
      note('Working through a long task…');
    }
  }
  function stopRun() {
    if (!state.busy || state.cancelRequested) return;
    state.cancelRequested = true;
    if (state.abort) state.abort.abort();
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

  async function uploadFile(file) {
    if (file.blob.size > MAX_FILE_BYTES) throw new Error(`${file.name} is larger than the 20 MB per-file limit.`);
    const session = await api('upload', {
      method: 'POST',
      json: { name: file.name, mime: file.mime, size: file.blob.size },
    });
    const parts = [];
    for (let offset = 0; offset < file.blob.size; offset += UPLOAD_CHUNK_BYTES) {
      const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.blob.size);
      const final = end === file.blob.size;
      const result = await api('upload', {
        method: 'POST',
        body: file.blob.slice(offset, end),
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-upload-id': session.uploadId,
          'x-upload-parts': final ? parts.join(',') : '',
          'x-upload-command': final ? 'upload, finalize' : 'upload',
        },
      });
      if (final) return result;
      parts.push(result.part);
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

  // ---- chats: stored in this browser -------------------------------------
  function loadChats() {
    try { state.chats = JSON.parse(localStorage.getItem(LS_CHATS) || '[]'); } catch { state.chats = []; }
    if (!Array.isArray(state.chats)) state.chats = [];
    for (const chat of state.chats) {
      for (const msg of chat.messages || []) {
        if (msg.role !== 'bot' || msg.status !== 'working') continue;
        // The page closed mid-run: whatever was written is kept and can be continued.
        msg.status = 'stopped';
        msg.note = 'Interrupted when the page closed. Press Continue to pick up where it left off.';
        for (const r of msg.results) if (r.state === 'working' || r.state === 'wait') r.state = 'stopped';
      }
    }
  }
  let saveTimer = null;
  function save(now = false) {
    clearTimeout(saveTimer);
    const write = () => {
      state.chats = state.chats.slice(0, MAX_CHATS);
      for (let tries = 0; tries < 50; tries++) {
        try {
          localStorage.setItem(LS_CHATS, JSON.stringify(state.chats));
          return;
        } catch {
          // Storage is full: drop the oldest chat that is not in use and try again.
          const victim = [...state.chats].reverse().find((c) => c.id !== state.activeId && c.id !== state.runChatId);
          if (!victim) return;
          state.chats = state.chats.filter((c) => c !== victim);
        }
      }
    };
    if (now) write();
    else saveTimer = setTimeout(write, 400);
  }
  const activeChat = () => state.chats.find((c) => c.id === state.activeId) || null;

  function newChat() {
    state.activeId = null;
    renderAll();
    closeSide();
    $('#input').focus();
  }
  function openChat(id) {
    state.activeId = id;
    renderAll();
    closeSide();
    scrollToEnd(true);
  }
  function deleteChat(id) {
    const chat = state.chats.find((c) => c.id === id);
    if (!chat || !confirm(`Delete “${chat.title}”?`)) return;
    if (state.runChatId === id) stopRun();
    state.chats = state.chats.filter((c) => c.id !== id);
    if (state.activeId === id) state.activeId = null;
    save(true);
    renderAll();
  }

  // ---- sidebar -----------------------------------------------------------
  function renderSidebar() {
    const list = $('#chatList');
    list.replaceChildren();
    const q = $('#chatSearch').value.trim().toLowerCase();
    const chats = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q));
    if (!chats.length) {
      list.append(el('div', { class: 'side-empty', text: q ? 'No chats match.' : 'Your chats will show up here.' }));
      return;
    }
    const day = 86400000;
    const today = new Date().setHours(0, 0, 0, 0);
    const groupOf = (t) => (t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'Previous 7 days' : t >= today - 30 * day ? 'Previous 30 days' : 'Older');
    let group = '';
    for (const chat of chats) {
      const g = groupOf(chat.updatedAt);
      if (g !== group) { group = g; list.append(el('div', { class: 'chat-group', text: g })); }
      list.append(
        el('div', { class: 'chat-item' + (chat.id === state.activeId ? ' on' : '') },
          el('button', { type: 'button', class: 'chat-open', title: chat.title, onclick: () => openChat(chat.id) },
            state.runChatId === chat.id ? el('span', { class: 'dot', 'aria-label': 'working' }) : null,
            chat.title),
          el('button', { type: 'button', class: 'chat-del', 'aria-label': 'Delete ' + chat.title, title: 'Delete chat', onclick: () => deleteChat(chat.id) },
            el('span', { 'aria-hidden': 'true', text: '×' }))
        )
      );
    }
  }
  function openSide() { $('#app').classList.add('side-open'); $('#scrim').hidden = false; }
  function closeSide() { $('#app').classList.remove('side-open'); $('#scrim').hidden = true; }

  // ---- thread ------------------------------------------------------------
  function nearBottom() {
    const t = $('#thread');
    return t.scrollHeight - t.scrollTop - t.clientHeight < 160;
  }
  function scrollToEnd(force) {
    const t = $('#thread');
    if (force || nearBottom()) requestAnimationFrame(() => { t.scrollTop = t.scrollHeight; });
  }

  function renderAll() {
    renderSidebar();
    const chat = activeChat();
    $('#chatTitle').textContent = chat ? chat.title : 'New chat';
    $('#exportMenuWrap').hidden = !chat || !chatRows(chat).length;
    $('#hello').hidden = !!chat;
    const msgs = $('#msgs');
    msgs.replaceChildren();
    if (chat) for (const msg of chat.messages) msgs.append(renderMsg(chat, msg));
    renderComposer();
  }

  function renderMsg(chat, msg) {
    if (msg.role === 'user') {
      return el('div', { class: 'msg user', 'data-id': msg.id },
        msg.files && msg.files.length
          ? el('div', { class: 'msg-files' }, msg.files.slice(0, 12).map((f) => el('span', { class: 'file-pill', title: f.name }, el('span', { class: 'ext', text: extOf(f.name) }), el('span', { text: f.name }))),
            msg.files.length > 12 ? el('span', { class: 'file-pill', text: `+${msg.files.length - 12} more` }) : null)
          : null,
        el('div', { class: 'bubble', text: msg.text }));
    }
    const node = el('div', { class: 'msg bot', 'data-id': msg.id });
    const status = el('div', { class: 'status' });
    node.append(status);
    paintStatus(status, msg);
    const multi = msg.kind === 'files';
    msg.results.forEach((r, i) => node.append(renderResult(chat, msg, r, i, multi)));
    return node;
  }

  function paintStatus(node, msg) {
    const total = msg.results.length;
    const finished = msg.results.filter((r) => r.state === 'done' || r.state === 'failed').length;
    node.className = 'status' + (msg.status === 'working' ? '' : ' done') + (msg.status === 'stopped' ? ' stopped' : '');
    node.replaceChildren();
    let text = '';
    if (msg.status === 'working') text = msg.note || (msg.kind === 'files' ? `Answering · ${finished} of ${total} files done` : (msg.results[0].text ? '' : 'Thinking…'));
    else if (msg.status === 'stopped') text = msg.note || 'Stopped.';
    else if (msg.status === 'failed') text = msg.note || 'Something went wrong.';
    else if (msg.kind === 'files') text = `${msg.results.filter((r) => r.state === 'done').length} of ${total} files answered`;
    if (!text && msg.status !== 'working') { node.hidden = true; return; }
    node.hidden = false;
    node.append(el('span', { class: 'spin' }), el('span', { text: text || 'Writing…' }));
    if (msg.status === 'working' && msg.kind === 'files' && total > 1) {
      node.append(el('span', { class: 'bar-mini' }, el('i', { style: `width:${Math.max(3, (finished / total) * 100)}%` })));
    }
  }

  function renderResult(chat, msg, r, i, multi) {
    const body = el('div', { class: 'md' });
    const ok = !r.error;
    const tools = el('div', { class: 'answer-tools' });
    if (r.text || r.error) tools.append(el('button', { type: 'button', onclick: () => copyText(r.text || r.error) }, 'Copy'));
    if ((r.state === 'stopped' || r.state === 'failed') && !state.busy && canResume(msg, r)) {
      tools.append(el('button', { type: 'button', onclick: () => resume(chat.id, msg.id, i) }, r.text ? 'Continue' : 'Retry'));
    }
    const extras = [
      r.warning ? el('p', { class: 'warn', text: r.warning }) : null,
      (r.sources || []).length
        ? el('div', { class: 'srcs' }, r.sources.filter((s) => /^https?:\/\//i.test(s.uri)).slice(0, 12).map((s) => el('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer', title: s.title, text: s.title })))
        : null,
      tools.childElementCount ? tools : null,
    ];
    const text = r.error ? r.error : r.text;
    if (text) renderAnswer(body, text);
    if (!multi) return el('div', { class: 'answer' + (ok ? '' : ' bad') }, body, extras);

    const label = { wait: 'Queued', working: 'Working', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[r.state] || '';
    const tagClass = r.state === 'done' ? 'tag' : r.state === 'failed' ? 'tag bad' : 'tag wait';
    const open = msg.results.length <= 6 || r.state === 'working';
    return el('details', { class: 'answer multi' + (ok ? '' : ' bad'), open: open ? '' : null },
      el('summary', { class: 'answer-head' }, el('span', { class: 'name', title: r.name, text: r.name }), el('span', { class: tagClass, text: label })),
      text ? body : el('p', { class: 'warn', text: r.state === 'working' ? 'Working on it…' : r.state === 'wait' ? 'Waiting for its turn.' : '' }),
      extras);
  }

  // Re-draws one bot message in place, if its chat is on screen.
  function paint(chat, msg, { status = false } = {}) {
    save();
    if (chat.id !== state.activeId) { renderSidebar(); return; }
    const node = document.querySelector(`.msg[data-id="${msg.id}"]`);
    if (!node) return renderAll();
    const keep = nearBottom();
    if (status) paintStatus(node.querySelector('.status'), msg);
    else {
      const openState = [...node.querySelectorAll('details.answer')].map((d) => d.open);
      const fresh = renderMsg(chat, msg);
      [...fresh.querySelectorAll('details.answer')].forEach((d, i) => { if (openState[i] !== undefined && msg.results[i].state !== 'working') d.open = openState[i]; });
      node.replaceWith(fresh);
    }
    $('#exportMenuWrap').hidden = !chatRows(chat).length;
    if (keep) scrollToEnd(true);
  }

  async function renderAnswer(container, text) {
    const raw = String(text || '');
    container.textContent = raw;
    container.classList.add('plain');
    const mathBlocks = [];
    const tokenized = raw.replace(/(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\$)\$(?!\$)[^\n$]+?\$)/g, (math) => {
      const token = `DOCBATCHMATHPLACEHOLDER${mathBlocks.length}END`;
      mathBlocks.push({ token, math });
      return token;
    });
    let mathJaxNeeded = false;
    try {
      const { marked, DOMPurify } = await loadMarkdownFormatter();
      const html = marked.parse(tokenized, { gfm: true, breaks: false });
      container.innerHTML = DOMPurify.sanitize(html);
      container.classList.remove('plain');
      for (const a of container.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
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
      container.textContent = raw;
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

  // ---- composer & attachments --------------------------------------------
  function renderComposer() {
    const list = $('#attachList');
    list.replaceChildren();
    for (const a of state.attachments.slice(0, 40)) {
      list.append(el('li', { class: 'attach-item', title: a.name },
        el('span', { class: 'ext', text: extOf(a.name) }),
        el('span', { class: 'meta' }, el('b', { text: a.name.split('/').pop() }), el('small', { text: a.name.includes('/') ? a.name : fmtSize(a.size) })),
        el('button', { type: 'button', class: 'x', 'aria-label': 'Remove ' + a.name, onclick: () => { state.attachments = state.attachments.filter((x) => x.id !== a.id); renderComposer(); } }, '×')));
    }
    if (state.attachments.length > 40) list.append(el('li', { class: 'attach-more', text: `+${state.attachments.length - 40} more` }));
    list.hidden = !state.attachments.length;
    $('#input').placeholder = state.attachments.length
      ? `What should be done with ${state.attachments.length === 1 ? 'this file' : `each of these ${state.attachments.length} files`}?`
      : 'Message DocBatch';
    const toggle = $('#searchToggle');
    toggle.classList.toggle('on', state.useSearch);
    toggle.setAttribute('aria-pressed', String(state.useSearch));
    $('#sendBtn').hidden = state.busy;
    $('#stopBtn').hidden = !state.busy;
    $('#sendBtn').disabled = !$('#input').value.trim();
  }
  function autoGrow() {
    const t = $('#input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px';
    $('#sendBtn').disabled = !t.value.trim();
  }

  async function addItems(items) {
    items = items.filter((it) => !String(it.name).split('/').some((seg) => seg.startsWith('.')));
    items = await window.Extract.expandZips(items);
    let added = 0;
    for (const it of items) {
      if (state.attachments.length >= MAX_FILES) { toast(`You can attach up to ${MAX_FILES} files per message.`); break; }
      if (state.attachments.some((f) => f.name === it.name && f.size === it.file.size)) continue;
      state.attachments.push({ id: state.nextId++, file: it.file, name: it.name, size: it.file.size });
      added++;
    }
    if (!added && items.length) toast('Those files are already attached.', 'info');
    renderComposer();
    $('#input').focus();
  }

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

  // ---- sending -----------------------------------------------------------
  // Earlier turns of a chat, as plain text, so follow-up questions have context.
  function historyBefore(chat, msgId) {
    const out = [];
    for (const msg of chat.messages) {
      if (msg.id === msgId) break;
      if (msg.role === 'user') {
        const files = msg.files && msg.files.length ? `\n[Attached: ${msg.files.map((f) => f.name).join(', ')}]` : '';
        out.push({ role: 'user', text: msg.text + files });
      } else {
        const text = msg.results.filter((r) => r.text).map((r) => (msg.kind === 'files' ? `### ${r.name}\n${r.text}` : r.text)).join('\n\n');
        if (text) out.push({ role: 'assistant', text });
      }
    }
    return out;
  }

  function beginRun(chat) {
    state.busy = true;
    state.runChatId = chat.id;
    state.cancelRequested = false;
    state.abort = new AbortController();
    renderAll();
  }
  function endRun(chat, msg, e) {
    const stoppedNote = 'Stopped. Finished answers are kept; press Continue to pick up where it left off.';
    if (e === STOPPED || (e && state.cancelRequested)) {
      msg.status = 'stopped';
      msg.note = stoppedNote;
    } else if (e) {
      if (e.status === 401) needPassword('Wrong or missing password.');
      msg.status = 'failed';
      msg.note = e.message || 'Something went wrong.';
    } else {
      msg.status = msg.results.some((r) => r.state === 'stopped') ? 'stopped' : 'done';
      msg.note = msg.status === 'stopped' ? stoppedNote : '';
    }
    for (const r of msg.results) if (r.state === 'working' || r.state === 'wait') r.state = 'stopped';
    state.busy = false;
    state.runChatId = null;
    state.abort = null;
    chat.updatedAt = Date.now();
    save(true);
    renderAll();
  }

  async function send() {
    const text = $('#input').value.trim();
    if (state.busy) return;
    if (!text) return toast(state.attachments.length ? 'Say what should be done with the files.' : 'Type a message.');
    if (state.config && state.config.passwordRequired && !state.pw) return needPassword();

    let chat = activeChat();
    if (!chat) {
      chat = { id: uid(), title: text.replace(/\s+/g, ' ').slice(0, 60), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      state.chats.unshift(chat);
      state.activeId = chat.id;
    } else {
      state.chats = [chat, ...state.chats.filter((c) => c.id !== chat.id)];
    }
    const files = state.attachments;
    state.attachments = [];
    $('#input').value = '';
    autoGrow();

    const userMsg = { id: uid(), role: 'user', text, files: files.map((f) => ({ name: f.name, size: f.size })) };
    const history = historyBefore(chat, null);
    const bot = {
      id: uid(), role: 'bot', kind: files.length ? 'files' : 'message', task: text, useSearch: state.useSearch,
      status: 'working', note: files.length ? 'Reading and uploading files…' : '',
      results: files.length ? files.map((f) => ({ name: f.name, state: 'wait', text: '' })) : [{ name: 'Reply', state: 'working', text: '' }],
    };
    chat.messages.push(userMsg, bot);
    chat.updatedAt = Date.now();
    beginRun(chat);
    scrollToEnd(true);
    try {
      if (files.length) await runFiles(chat, bot, files, history);
      else await answerOne(chat, bot, 0, { message: text, useSearch: bot.useSearch, history });
      endRun(chat, bot);
    } catch (e) {
      endRun(chat, bot, e);
    }
  }

  // Gets one result's answer, writing progress into the message as it goes.
  async function answerOne(chat, msg, i, payload) {
    const r = msg.results[i];
    r.state = 'working';
    delete r.error;
    paint(chat, msg);
    try {
      const out = await ask(payload, {
        prior: r.text || '',
        note: (n) => { msg.note = msg.kind === 'files' ? `${r.name}: ${n}` : n; paint(chat, msg, { status: true }); },
        onText: (text, sources) => { r.text = text; r.sources = sources; msg.note = ''; paint(chat, msg); },
      });
      Object.assign(r, { state: 'done', text: out.text, warning: out.warning, sources: out.sources });
      msg.note = '';
    } catch (e) {
      if (e === STOPPED) { r.state = 'stopped'; throw e; }
      if (e.status === 401) throw e;
      r.state = 'failed';
      if (!r.text) r.error = e.message || 'Could not get an answer.';
      else r.warning = `Stopped before the end: ${e.message}`;
      if (msg.kind !== 'files') throw e;
    } finally {
      paint(chat, msg);
    }
  }

  async function runFiles(chat, msg, files, history) {
    // Read every file in the browser and upload it, three at a time.
    let uploaded = 0;
    await pool(files, 3, async (f, i) => {
      const r = msg.results[i];
      if (state.cancelRequested) return;
      try {
        const prep = await window.Extract.prepare(f.file, f.name);
        const parts = [];
        for (const b of prep.blobs) {
          const up = await withRetry(() => uploadFile(b));
          parts.push({ uri: up.uri, mimeType: up.mimeType || b.mime });
        }
        r.parts = parts;
        r.uploadedAt = Date.now();
      } catch (e) {
        if (e.status === 401) throw e;
        r.state = 'failed';
        r.error = e.message || 'Could not read this file.';
      }
      uploaded++;
      msg.note = `Reading and uploading files · ${uploaded} of ${files.length}`;
      paint(chat, msg, { status: true });
    });
    if (state.cancelRequested) throw STOPPED;
    msg.note = '';
    paint(chat, msg);
    const todo = msg.results.map((r, i) => i).filter((i) => msg.results[i].parts);
    if (!todo.length) throw new Error('None of the files could be read.');
    await pool(todo, 3, async (i) => {
      if (state.cancelRequested) return;
      const r = msg.results[i];
      try {
        await answerOne(chat, msg, i, { task: msg.task, useSearch: msg.useSearch, name: r.name, parts: r.parts, history });
      } catch (e) {
        if (e !== STOPPED) throw e;
      }
    });
    if (state.cancelRequested) throw STOPPED;
  }

  function canResume(msg, r) {
    if (msg.kind !== 'files') return true;
    return !!(r.parts && Date.now() - (r.uploadedAt || 0) < UPLOAD_REUSE_MS);
  }
  // Continues a stopped answer from where it ended, or retries a failed one.
  async function resume(chatId, msgId, i) {
    if (state.busy) return;
    const chat = state.chats.find((c) => c.id === chatId);
    const msg = chat && chat.messages.find((m) => m.id === msgId);
    if (!msg) return;
    const r = msg.results[i];
    if (!canResume(msg, r)) return toast('The uploaded copy has expired. Attach the file again.');
    msg.status = 'working';
    msg.note = '';
    beginRun(chat);
    const history = historyBefore(chat, chat.messages[chat.messages.indexOf(msg) - 1]?.id);
    try {
      await answerOne(chat, msg, i, msg.kind === 'files'
        ? { task: msg.task, useSearch: msg.useSearch, name: r.name, parts: r.parts, history }
        : { message: msg.task, useSearch: msg.useSearch, history });
      endRun(chat, msg);
    } catch (e) {
      endRun(chat, msg, e);
    }
  }

  // ---- export ------------------------------------------------------------
  function chatRows(chat) {
    return chat.messages.filter((m) => m.role === 'bot').flatMap((m) => m.results.filter((r) => r.text || r.error));
  }
  function exportChat(fmt) {
    const chat = activeChat();
    if (!chat) return;
    const rows = chatRows(chat);
    if (!rows.length) return toast('Nothing to download yet.');
    if (fmt === 'pdf') return window.print();
    const stamp = new Date().toISOString().slice(0, 10);
    const sources = (r) => (r.sources || []).map((s) => s.uri).join(' ');
    const status = (r) => (r.error ? 'failed' : r.state === 'done' ? 'done' : 'unfinished');
    if (fmt === 'csv') {
      const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = [['file', 'status', 'answer', 'sources'].join(',')];
      for (const r of rows) lines.push([esc(r.name), esc(status(r)), esc(r.error || r.text), esc(sources(r))].join(','));
      download(`docbatch-${stamp}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    } else if (fmt === 'json') {
      download(`docbatch-${stamp}.json`, JSON.stringify(rows.map((r) => ({ file: r.name, status: status(r), answer: r.text || null, error: r.error || null, sources: r.sources || [] })), null, 2), 'application/json');
    } else if (fmt === 'md') {
      download(`docbatch-${stamp}.md`, rows.map((r) => `## ${r.name}\n\n${r.error ? '**Failed:** ' + r.error : r.text}\n`).join('\n'), 'text/markdown');
    } else {
      download(`docbatch-${stamp}.txt`, rows.map((r) => (rows.length > 1 ? `=== ${r.name} ===\n` : '') + (r.error ? 'FAILED: ' + r.error : r.text) + '\n').join('\n'), 'text/plain');
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
      if (!c.hasKey) toast('The server is not configured to answer yet. Ask the site owner.');
      if (c.passwordRequired && !c.authorized) $('#pwRow').hidden = false;
    } catch (e) {
      toast('Could not reach the server: ' + e.message);
    }
  }

  function init() {
    try { localStorage.removeItem('docbatch.job.v1'); localStorage.removeItem('docbatch.task.v1'); } catch { /* ignore */ }
    loadChats();

    for (const [title, sub, text] of SUGGESTIONS) {
      $('#suggest').append(el('button', { type: 'button', onclick: () => { $('#input').value = text; autoGrow(); $('#input').focus(); } }, el('b', { text: title }), el('span', { text: sub })));
    }

    const input = $('#input');
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('#composerForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    $('#stopBtn').addEventListener('click', stopRun);
    $('#searchToggle').addEventListener('click', () => {
      state.useSearch = !state.useSearch;
      try { localStorage.setItem(LS_SEARCH, state.useSearch ? 'on' : 'off'); } catch { /* ignore */ }
      renderComposer();
    });

    const attachMenu = $('#attachMenu');
    const exportMenu = $('#exportMenu');
    $('#attachBtn').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = true; attachMenu.hidden = !attachMenu.hidden; });
    $('#pickFiles').addEventListener('click', () => { attachMenu.hidden = true; $('#fileInput').click(); });
    $('#pickFolder').addEventListener('click', () => { attachMenu.hidden = true; $('#folderInput').click(); });
    $('#fileInput').addEventListener('change', (e) => { addItems([...e.target.files].map((f) => ({ file: f, name: f.name }))); e.target.value = ''; });
    $('#folderInput').addEventListener('change', (e) => { addItems([...e.target.files].map((f) => ({ file: f, name: f.webkitRelativePath || f.name }))); e.target.value = ''; });
    $('#exportBtn').addEventListener('click', (e) => { e.stopPropagation(); attachMenu.hidden = true; exportMenu.hidden = !exportMenu.hidden; });
    exportMenu.addEventListener('click', (e) => { const b = e.target.closest('button[data-fmt]'); if (b) { exportMenu.hidden = true; exportChat(b.dataset.fmt); } });
    document.addEventListener('click', () => { attachMenu.hidden = true; exportMenu.hidden = true; });

    // Drop files anywhere on the page.
    let dragDepth = 0;
    const veil = $('#dropVeil');
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; veil.hidden = false; } });
    window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; veil.hidden = true; } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragDepth = 0;
      veil.hidden = true;
      if (hasFiles(e)) addItems(await filesFromDrop(e.dataTransfer));
    });

    $('#newChat').addEventListener('click', newChat);
    $('#chatSearch').addEventListener('input', renderSidebar);
    $('#openSide').addEventListener('click', openSide);
    $('#closeSide').addEventListener('click', closeSide);
    $('#scrim').addEventListener('click', closeSide);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
      if (e.key === 'Escape') { closeSide(); attachMenu.hidden = true; exportMenu.hidden = true; }
    });
    window.addEventListener('beforeunload', (e) => { save(true); if (state.busy) e.preventDefault(); });

    $('#pw').value = state.pw;
    $('#pw').addEventListener('input', (e) => { state.pw = e.target.value; try { sessionStorage.setItem(SS_PW, state.pw); } catch { /* ignore */ } });

    renderAll();
    loadConfig();
    input.focus();
  }

  init();
})();
