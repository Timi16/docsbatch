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
  const LS_SIDE = 'docbatch.side';
  const MAX_TRACE = 300;
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
    openTraces: new Set(),
    openSources: new Set(),
    recFilter: new Map(),
    renamingId: null,
    menuChatId: null,
    sideCollapsed: localStorage.getItem(LS_SIDE) === 'closed',
  };
  const formatterLoads = {};
  const FORMATTER_SCRIPTS = {
    markdown: 'https://cdn.jsdelivr.net/npm/marked@15.0.7/marked.min.js',
    sanitize: 'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js',
    math: 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-chtml.js',
    pdf: 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
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
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return String(url).slice(0, 40); } };
  const fmtDur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
  // A small letter badge per site, coloured from its name, instead of fetching favicons from a third party.
  function face(h) {
    let n = 0;
    for (const ch of h) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
    return el('span', { class: 'face', style: `background:hsl(${n % 360} 42% 42%)`, 'aria-hidden': 'true', text: h.replace(/^www\./, '')[0] || '?' });
  }
  // Hides the pacing marker, including a half-streamed one at the very end.
  function tidy(text) {
    const t = String(text || '').replace(/\[\[CONTINUE\]\]/g, '');
    const i = t.lastIndexOf('[[');
    return i >= 0 && '[[CONTINUE]]'.startsWith(t.slice(i)) ? t.slice(0, i) : t;
  }

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
  // Sends one request and reads its progress events as they arrive; resolves with the final result.
  async function streamInstant(json, onEvent) {
    const h = { 'Content-Type': 'application/json' };
    if (state.pw) h['x-app-password'] = state.pw;
    const res = await fetch('/api/instant', { method: 'POST', headers: h, body: JSON.stringify(json), signal: state.abort.signal });
    if (!res.ok) {
      let data = null;
      try { data = await res.json(); } catch { /* use the status */ }
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'done') return event;
        if (event.type === 'error') {
          const err = new Error(event.error || 'Server error');
          err.status = event.status;
          throw err;
        }
        onEvent(event);
      }
    }
    throw new Error('The connection closed before the answer finished.');
  }

  // One live answer. Failed requests are retried, and an answer that was cut off is continued
  // from where it stopped until it is finished, with no action from the user. Progress events
  // (thinking, searches) go to onEvent; the text so far goes to onText as it streams.
  async function ask(payload, { note, onEvent, onText, prior = '' }) {
    let text = prior;
    const sources = [];
    let attempt = 0;
    let slower = false; // set when a turn ran out of time, so the next ones take smaller steps
    for (let pieces = 1; ; pieces++) {
      let result;
      while (!result) {
        if (state.cancelRequested) throw STOPPED;
        let live = '';
        try {
          result = await streamInstant({ ...payload, ...(text ? { prior: text } : {}), ...(slower ? { slower } : {}) }, (event) => {
            if (event.type === 'text') { live += event.delta; onText(text + live, sources, true); }
            else if (event.type !== 'ping') onEvent(event);
          });
          if (result.error) throw new Error(result.error);
        } catch (e) {
          if (state.cancelRequested) throw STOPPED;
          if (e.status === 401) throw e;
          if (live) onText(text, sources, false); // drop the half-streamed piece; it is asked for again
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
      onText(text, sources, false);
      if (!result.incomplete) return { text: text.trim(), warning: result.warning, sources };
      if (pieces >= MAX_PIECES) return { text: text.trim(), warning: 'This answer was too long to finish and stops early.', sources };
      onEvent({ type: 'part', n: pieces + 1 });
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
      list.append(el('div', { class: 'side-empty', text: q ? 'No chats match.' : 'No chats yet. Start one, or drop files anywhere to begin.' }));
      return;
    }
    const day = 86400000;
    const today = new Date().setHours(0, 0, 0, 0);
    const groupOf = (t) => (t >= today ? 'Today' : t >= today - day ? 'Yesterday' : t >= today - 7 * day ? 'Previous 7 days' : t >= today - 30 * day ? 'Previous 30 days' : 'Older');
    let group = '';
    for (const chat of chats) {
      const g = groupOf(chat.updatedAt);
      if (g !== group) { group = g; list.append(el('div', { class: 'chat-group', text: g })); }
      const item = el('div', { class: 'chat-item' + (chat.id === state.activeId ? ' on' : '') });
      if (state.renamingId === chat.id) {
        const input = el('input', { class: 'chat-rename', value: chat.title, 'aria-label': 'Chat name', maxlength: '120' });
        const finish = (keep) => {
          if (state.renamingId !== chat.id) return;
          state.renamingId = null;
          const title = input.value.replace(/\s+/g, ' ').trim();
          if (keep && title) { chat.title = title; save(true); }
          renderAll();
        };
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
        item.append(input);
        list.append(item);
        requestAnimationFrame(() => { input.focus(); input.select(); });
        continue;
      }
      item.append(
        el('button', { type: 'button', class: 'chat-open', title: chat.title, onclick: () => openChat(chat.id) },
          state.runChatId === chat.id ? el('span', { class: 'mini-spin', 'aria-label': 'working' }) : null,
          el('span', { class: 'chat-title', text: chat.title })),
        el('button', {
          type: 'button', class: 'chat-more', 'aria-label': 'Options for ' + chat.title, 'aria-haspopup': 'menu',
          'aria-expanded': String(state.menuChatId === chat.id),
          onclick: (e) => { e.stopPropagation(); openChatMenu(chat.id, e.currentTarget); },
        }, el('span', { 'aria-hidden': 'true', text: '⋯' })));
      list.append(item);
    }
  }
  function openChatMenu(id, button) {
    const menu = $('#chatMenu');
    if (state.menuChatId === id && !menu.hidden) return closeChatMenu();
    state.menuChatId = id;
    const r = button.getBoundingClientRect();
    menu.hidden = false;
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8) + 'px';
    renderSidebar();
  }
  function closeChatMenu() {
    if (!state.menuChatId) return;
    state.menuChatId = null;
    $('#chatMenu').hidden = true;
    renderSidebar();
  }
  const mobile = () => window.matchMedia('(max-width: 860px)').matches;
  function openSide() {
    if (mobile()) { $('#app').classList.add('side-open'); $('#scrim').hidden = false; return; }
    setCollapsed(false);
  }
  function closeSide() {
    $('#app').classList.remove('side-open');
    $('#scrim').hidden = true;
  }
  function setCollapsed(collapsed) {
    state.sideCollapsed = collapsed;
    $('#app').classList.toggle('side-collapsed', collapsed);
    try { localStorage.setItem(LS_SIDE, collapsed ? 'closed' : 'open'); } catch { /* ignore */ }
  }

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
    msg.results.forEach((r, i) => node.append(renderResult(chat, msg, i)));
    return node;
  }

  // The line above the answers: upload and overall progress, or how the run ended.
  function paintStatus(node, msg) {
    const total = msg.results.length;
    const finished = msg.results.filter((r) => r.state === 'done' || r.state === 'failed').length;
    node.className = 'status' + (msg.status === 'working' ? '' : ' done') + (msg.status === 'stopped' ? ' stopped' : '');
    node.replaceChildren();
    let text = '';
    if (msg.status === 'working') text = msg.note || (msg.kind === 'files' && total > 1 ? `Answering · ${finished} of ${total} files done` : '');
    else if (msg.status === 'stopped') text = msg.note || 'Stopped.';
    else if (msg.status === 'failed') text = msg.note || 'Something went wrong.';
    else if (msg.kind === 'files' && total > 1) text = `${msg.results.filter((r) => r.state === 'done').length} of ${total} files answered`;
    node.hidden = !text;
    if (!text) return;
    node.append(el('span', { class: 'spin' }), el('span', { text }));
    if (msg.status === 'working' && msg.kind === 'files' && total > 1) {
      node.append(el('span', { class: 'bar-mini' }, el('i', { style: `width:${Math.max(3, (finished / total) * 100)}%` })));
    }
  }

  // What the model is doing or did: a one-line summary that opens into every step.
  function renderTrace(chat, msg, i) {
    const r = msg.results[i];
    const working = r.state === 'working';
    const steps = r.trace || [];
    if (!working && !steps.length) return null;
    const key = `${msg.id}:${i}`;
    const open = state.openTraces.has(key);
    const searches = steps.filter((s) => s.k === 'search').length;
    const reused = (steps.find((s) => s.k === 'known') || {}).n || 0;
    const sites = new Set(steps.flatMap((s) => s.urls || (s.url ? [s.url] : [])).map(host)).size;
    const secs = Math.max(0, Math.round(((r.t1 || Date.now()) - (r.t0 || Date.now())) / 1000));
    const label = working
      ? r.phase || 'Thinking'
      : (searches ? `Searched the web ${searches} time${searches === 1 ? '' : 's'} · ${sites} site${sites === 1 ? '' : 's'}` : 'Thought it through') + (reused ? ` · reused ${reused} from earlier` : '');
    const head = el('button', {
      type: 'button', class: 'trace-head', 'aria-expanded': String(open),
      onclick: () => { if (open) state.openTraces.delete(key); else state.openTraces.add(key); paintResult(chat, msg, i); },
    },
      el('span', { class: 't-icon' }, working ? el('span', { class: 'spin' }) : el('svg', {}, '')),
      el('span', { class: 'label', text: label }),
      el('span', { class: 'time', 'data-t0': working ? String(r.t0 || Date.now()) : null, text: fmtDur(secs) }),
      el('span', { class: 'chev', 'aria-hidden': 'true', text: '›' }));
    if (!working) head.querySelector('.t-icon').replaceChildren(svgIcon('M5 12.5l4.5 4.5L19 7.5'));
    const box = el('div', { class: 'trace' + (working ? ' working' : '') + (working && r.retrying ? ' retrying' : '') }, head);
    if (open) {
      box.append(el('ol', { class: 'trace-steps' }, steps.map((s) => {
        if (s.k === 'search') {
          return el('li', { class: 'step search' },
            el('div', {}, 'Searched ', el('span', { class: 'q', text: `“${s.q[0]}”` })),
            s.q.length > 1 ? el('div', { class: 'q-more', text: s.q.slice(1).map((q) => `“${q}”`).join(' · ') }) : null,
            s.urls && s.urls.length ? el('div', { class: 'sites' }, s.urls.filter((u, n, all) => all.findIndex((v) => host(v) === host(u)) === n).map((u) => el('a', { class: 'site', href: u, target: '_blank', rel: 'noopener noreferrer', title: u }, face(host(u)), el('span', { text: host(u) })))) : null);
        }
        if (s.k === 'open') return el('li', { class: 'step' }, 'Read ', el('a', { class: 'site', href: s.url, target: '_blank', rel: 'noopener noreferrer', title: s.url }, face(host(s.url)), el('span', { text: host(s.url) })));
        if (s.k === 'find') return el('li', { class: 'step' }, `Looked for “${s.pattern}” on `, el('span', { class: 'q', text: host(s.url) }));
        if (s.k === 'part') return el('li', { class: 'step part', text: `Part ${s.n}` });
        if (s.k === 'known') return el('li', { class: 'step known', text: `Reused ${s.n} ${s.n === 1 ? 'company' : 'companies'} already found in earlier chats` });
        return el('li', { class: 'step', text: 'Thinking' });
      })));
      if (working) box.querySelector('.trace-steps').append(el('li', { class: 'step', text: r.phase || 'Thinking…' }));
    }
    return box;
  }
  function svgIcon(d) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '15'); svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.4');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  }

  function renderSources(chat, msg, i) {
    const list = (msg.results[i].sources || []).filter((s) => /^https?:\/\//i.test(s.uri));
    if (!list.length) return [null, null];
    const key = `${msg.id}:${i}`;
    const open = state.openSources.has(key);
    const button = el('button', {
      type: 'button', class: 'sources-btn', 'aria-expanded': String(open),
      onclick: () => { if (open) state.openSources.delete(key); else state.openSources.add(key); paintResult(chat, msg, i); },
    }, el('span', { class: 'faces' }, [...new Set(list.map((s) => host(s.uri)))].slice(0, 4).map(face)), `Sources · ${list.length}`);
    const panel = open
      ? el('ul', { class: 'sources-list' }, list.map((s) => el('li', {}, el('a', { href: s.uri, target: '_blank', rel: 'noopener noreferrer', title: s.uri },
        face(host(s.uri)), el('span', { class: 's-text' }, el('span', { class: 's-title', text: s.title || host(s.uri) }), el('span', { class: 's-host', text: host(s.uri) }))))))
      : null;
    return [button, panel];
  }

  // Lead-style answers are shown as a table instead of plain lines. A record is "Name email Executive" on
  // one line, or the same split over three lines. When a later pass lists a lead again (e.g. a REVIEW pass),
  // its newer result replaces the earlier one in place, so the table is always the merged, final list.
  const EMAIL = /^[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}$/i;
  function parseRecords(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '')).filter(Boolean);
    const found = [];
    const other = [];
    for (let k = 0; k < lines.length; k++) {
      const tokens = lines[k].split(/\s+/);
      const at = tokens.findIndex((t) => EMAIL.test(t));
      const rest = at > 0 ? tokens.slice(at + 1).join(' ').replace(/^[-–—:|,]\s*/, '').trim() : '';
      if (at > 0 && at <= 3 && rest) {
        found.push({ name: tokens.slice(0, at).join(' '), email: tokens[at], exec: rest });
      } else if (k + 2 < lines.length && tokens.length <= 3 && !lines[k].includes('@') && EMAIL.test(lines[k + 1]) && !lines[k + 2].includes('@')) {
        found.push({ name: lines[k], email: lines[k + 1], exec: lines[k + 2] });
        k += 2;
      } else other.push(lines[k]);
    }
    if (found.length < 3 || found.length * 3 < (found.length + other.length) * 1.5) return null;
    const rows = [];
    const byEmail = new Map();
    for (const f of found) {
      const row = { ...f, domain: f.email.split('@')[1].toLowerCase(), review: /^review\b/i.test(f.exec) };
      const key = f.email.toLowerCase();
      const seen = byEmail.get(key);
      if (!seen) { byEmail.set(key, row); rows.push(row); } else if (!row.review || seen.review) Object.assign(seen, row);
    }
    return { rows, other };
  }

  function renderRecords(chat, msg, i, parsed) {
    const key = `${msg.id}:${i}`;
    const filter = state.recFilter.get(key) || 'all';
    const { rows, other } = parsed;
    const review = rows.filter((r) => r.review).length;
    const verified = rows.length - review;
    const working = msg.results[i].state === 'working';
    const setFilter = (f) => { state.recFilter.set(key, f); paintResult(chat, msg, i); };
    const tab = (f, label, n) => el('button', { type: 'button', class: 'rec-tab' + (filter === f ? ' on' : ''), 'aria-pressed': String(filter === f), onclick: () => setFilter(f) }, label, el('span', { text: String(n) }));
    const shown = rows.map((r, n) => ({ ...r, n: n + 1 })).filter((r) => filter === 'all' || (filter === 'rev' ? r.review : !r.review));
    const line = (r) => `${r.name} ${r.email} ${r.review ? 'REVIEW' : r.exec}`;
    const copyRows = () => copyText(shown.map(line).join('\n\n'));
    const copySheets = () => copyText(['Name\tEmail\tCompany\tTop executive\tStatus', ...shown.map((r) => [r.name, r.email, r.domain, r.review ? '' : r.exec, r.review ? 'Review' : 'Verified'].join('\t'))].join('\n'));
    const cell = (cls, value, kids) => el('td', { class: cls + ' copyable', title: `${value} · click to copy`, onclick: () => copyText(value) }, kids);
    return el('div', { class: 'records' },
      el('div', { class: 'rec-head' },
        el('div', { class: 'rec-stats' },
          el('b', { text: String(rows.length) }), el('span', { text: rows.length === 1 ? ' lead' : ' leads' }),
          working ? el('span', { class: 'rec-live', text: 'filling in…' }) : null),
        el('div', { class: 'rec-actions' },
          el('div', { class: 'rec-tabs', role: 'group', 'aria-label': 'Filter rows' }, tab('all', 'All', rows.length), tab('ok', 'Verified', verified), tab('rev', 'Review', review)),
          el('button', { type: 'button', class: 'rec-copy', title: 'Copy the rows shown, one lead per line', onclick: copyRows }, 'Copy rows'),
          el('button', { type: 'button', class: 'rec-copy', title: 'Copy the rows shown as columns for Excel or Google Sheets', onclick: copySheets }, 'Copy for Sheets'))),
      el('div', { class: 'rec-bar', title: `${verified} verified, ${review} to review` },
        el('i', { class: 'ok', style: `width:${(verified / rows.length) * 100}%` }),
        el('i', { class: 'rev', style: `width:${(review / rows.length) * 100}%` })),
      el('div', { class: 'rec-scroll' },
        el('table', { class: 'rec-table' },
          el('colgroup', {}, ['n', 'name', 'exec', 'co', 'email', 'copy'].map((c) => el('col', { class: 'c-' + c }))),
          el('thead', {}, el('tr', {}, [['#', 'n'], ['Name', 'name'], ['Top executive', 'exec'], ['Company', 'co'], ['Email', 'email'], ['', 'copy']].map(([h, c]) => el('th', { class: c, text: h })))),
          el('tbody', {}, shown.length ? shown.map((r) => el('tr', { class: r.review ? 'is-rev' : '' },
            el('td', { class: 'n', text: String(r.n) }),
            cell('name', r.name, [el('span', { text: r.name }), el('small', { class: 'dom', text: r.domain })]),
            r.review ? el('td', { class: 'exec', title: 'Not verified yet' }, el('span', { class: 'rev-tag', text: 'Review' })) : cell('exec', r.exec, el('span', { text: r.exec })),
            cell('co', r.domain, el('span', { class: 'co-chip' }, face(r.domain), el('span', { text: r.domain }))),
            cell('email', r.email, r.email),
            el('td', { class: 'copy' }, el('button', { type: 'button', class: 'row-copy', 'aria-label': `Copy ${r.name}'s row`, title: 'Copy this lead', onclick: () => copyText(line(r)) }, svgIcon('M9 9h10v10H9zM5 15V5h10'))))) :
            el('tr', {}, el('td', { class: 'empty-row', colspan: '6', text: 'Nothing here.' }))))),
      other.length ? el('div', { class: 'rec-notes' }, other.map((line) => el('p', { text: line.replace(/\*\*/g, '') }))) : null);
  }
  // Executives already verified in earlier answers in any chat (newest wins), so a new list can reuse
  // them instead of searching again. Free-mail domains say nothing about a company and are skipped.
  const FREE_MAIL = new Set('gmail.com googlemail.com yahoo.com ymail.com outlook.com hotmail.com live.com msn.com icloud.com me.com aol.com proton.me protonmail.com gmx.com zoho.com'.split(' '));
  function knownExecutives(skipMsgId) {
    const known = new Map();
    for (const chat of [...state.chats].sort((a, b) => a.updatedAt - b.updatedAt)) {
      for (const msg of chat.messages) {
        if (msg.role !== 'bot' || msg.id === skipMsgId) continue;
        for (const r of msg.results) {
          const parsed = r.text ? parseRecords(tidy(r.text)) : null;
          if (!parsed) continue;
          for (const row of parsed.rows) if (!row.review && !FREE_MAIL.has(row.domain)) known.set(row.domain, { exec: row.exec, at: r.t1 || chat.updatedAt });
        }
      }
    }
    return known;
  }

  function recordsCsv(name, parsed) {
    const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = ['name,email,company,top_executive,status'];
    for (const r of parsed.rows) lines.push([r.name, r.email, r.domain, r.review ? '' : r.exec, r.review ? 'review' : 'verified'].map(esc).join(','));
    download(`${String(name || 'leads').replace(/[^\w-]+/g, '-').slice(0, 60)}.csv`, '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function renderResult(chat, msg, i) {
    const r = msg.results[i];
    const multi = msg.kind === 'files';
    const body = el('div', { class: 'md' });
    const ok = !r.error;
    const text = r.error ? r.error : tidy(r.text);
    const records = !r.error && text ? parseRecords(text) : null;
    const [sourcesBtn, sourcesPanel] = renderSources(chat, msg, i);
    const tools = el('div', { class: 'answer-tools' });
    if (r.state !== 'working' && (r.text || r.error)) tools.append(el('button', { type: 'button', onclick: () => copyText(r.text || r.error) }, 'Copy'));
    if (r.state !== 'working' && r.text) tools.append(el('button', { type: 'button', title: 'Download this answer as a PDF', onclick: () => downloadPdf(multi ? r.name : chat.title, [{ text: r.text, sources: r.sources }]) }, 'PDF'));
    if (records && r.state !== 'working') tools.append(el('button', { type: 'button', title: 'Download this table as CSV', onclick: () => recordsCsv(multi ? r.name : chat.title, records) }, 'CSV'));
    if ((r.state === 'stopped' || r.state === 'failed') && !state.busy && canResume(msg, r)) {
      tools.append(el('button', { type: 'button', onclick: () => resume(chat.id, msg.id, i) }, r.text ? 'Continue' : 'Retry'));
    }
    if (sourcesBtn && r.state !== 'working') tools.append(sourcesBtn);
    const parts = [
      renderTrace(chat, msg, i),
      records ? renderRecords(chat, msg, i, records) : text ? body : null,
      r.warning ? el('p', { class: 'warn', text: r.warning }) : null,
      tools.childElementCount ? tools : null,
      r.state !== 'working' ? sourcesPanel : null,
    ];
    if (text && !records) renderAnswer(body, text);
    const key = `${msg.id}:${i}`;
    if (!multi) return el('div', { class: 'answer' + (ok ? '' : ' bad'), 'data-key': key }, parts);

    const label = { wait: 'Queued', working: 'Working', done: 'Done', failed: 'Failed', stopped: 'Stopped' }[r.state] || '';
    const tagClass = r.state === 'done' ? 'tag' : r.state === 'failed' ? 'tag bad' : 'tag wait';
    const open = msg.results.length <= 6 || r.state === 'working';
    return el('details', { class: 'answer multi' + (ok ? '' : ' bad'), 'data-key': key, open: open ? '' : null },
      el('summary', { class: 'answer-head' }, el('span', { class: 'name', title: r.name, text: r.name }), el('span', { class: tagClass, text: label })),
      r.state === 'wait' ? el('p', { class: 'warn', text: 'Waiting for its turn.' }) : null,
      parts);
  }

  // Re-draws one answer in place (and the progress line above it), if its chat is on screen.
  function paintResult(chat, msg, i) {
    save();
    if (chat.id !== state.activeId) { renderSidebar(); return; }
    const node = document.querySelector(`.msg[data-id="${msg.id}"]`);
    if (!node) return renderAll();
    const keep = nearBottom();
    paintStatus(node.querySelector('.status'), msg);
    const old = node.querySelector(`[data-key="${msg.id}:${i}"]`);
    const fresh = renderResult(chat, msg, i);
    if (old) {
      if (old.tagName === 'DETAILS' && msg.results[i].state !== 'working') fresh.open = old.open;
      old.replaceWith(fresh);
    }
    $('#exportMenuWrap').hidden = !chatRows(chat).length;
    if (keep) scrollToEnd(true);
  }
  // Streaming text arrives many times a second; draw at most every 120 ms per answer.
  const paintTimers = new Map();
  function paintSoon(chat, msg, i) {
    const key = `${msg.id}:${i}`;
    if (paintTimers.has(key)) return;
    paintTimers.set(key, setTimeout(() => { paintTimers.delete(key); paintResult(chat, msg, i); }, 120));
  }
  function paint(chat, msg) {
    save();
    if (chat.id !== state.activeId) { renderSidebar(); return; }
    const node = document.querySelector(`.msg[data-id="${msg.id}"]`);
    if (!node) return renderAll();
    paintStatus(node.querySelector('.status'), msg);
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
      // Email addresses would all become underlined mailto links; keep them as plain text.
      for (const a of container.querySelectorAll('a[href^="mailto:"]')) a.replaceWith(document.createTextNode(a.textContent));
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
    for (const r of msg.results) if (r.state === 'working' || r.state === 'wait') { r.state = 'stopped'; r.t1 = r.t1 || Date.now(); r.phase = ''; }
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

  // Gets one result's answer, writing progress into it as it goes.
  async function answerOne(chat, msg, i, payload) {
    const r = msg.results[i];
    r.state = 'working';
    r.phase = 'Thinking';
    r.retrying = false;
    r.t0 = Date.now();
    delete r.t1;
    delete r.error;
    r.trace = r.trace || [];
    const step = (s) => {
      const last = r.trace[r.trace.length - 1];
      if (s.k === 'think' && last && last.k === 'think') return;
      r.trace.push(s);
      if (r.trace.length > MAX_TRACE) r.trace.splice(0, r.trace.length - MAX_TRACE);
    };
    if (payload.known && payload.known.length && !r.trace.some((s) => s.k === 'known')) step({ k: 'known', n: payload.known.length });
    paintResult(chat, msg, i);
    try {
      const out = await ask(payload, {
        prior: r.text || '',
        note: (n) => { r.phase = n; r.retrying = true; paintSoon(chat, msg, i); },
        onEvent: (ev) => {
          r.retrying = false;
          if (ev.type === 'think') { step({ k: 'think' }); r.phase = 'Thinking'; }
          else if (ev.type === 'searching') r.phase = 'Searching the web';
          else if (ev.type === 'search') { step({ k: 'search', q: ev.queries, urls: (ev.urls || []).slice(0, 5) }); r.phase = `Searching “${ev.queries[0]}”`; }
          else if (ev.type === 'open') { step({ k: 'open', url: ev.url }); r.phase = `Reading ${host(ev.url)}`; }
          else if (ev.type === 'find') { step({ k: 'find', url: ev.url, pattern: ev.pattern }); r.phase = `Looking through ${host(ev.url)}`; }
          else if (ev.type === 'part') { step({ k: 'part', n: ev.n }); r.phase = `Continuing · part ${ev.n}`; }
          paintSoon(chat, msg, i);
        },
        onText: (text, sources, live) => {
          r.retrying = false;
          r.text = text;
          if (!live) r.sources = sources;
          else r.phase = 'Writing';
          paintSoon(chat, msg, i);
        },
      });
      Object.assign(r, { state: 'done', text: out.text, warning: out.warning, sources: out.sources });
    } catch (e) {
      if (e === STOPPED) { r.state = 'stopped'; throw e; }
      if (e.status === 401) throw e;
      r.state = 'failed';
      if (!r.text) r.error = e.message || 'Could not get an answer.';
      else r.warning = `Stopped before the end: ${e.message}`;
      if (msg.kind !== 'files') throw e;
    } finally {
      r.t1 = Date.now();
      r.phase = '';
      clearTimeout(paintTimers.get(`${msg.id}:${i}`));
      paintTimers.delete(`${msg.id}:${i}`);
      paintResult(chat, msg, i);
    }
  }

  async function runFiles(chat, msg, files, history) {
    // Read every file in the browser and upload it, three at a time.
    let uploaded = 0;
    const fileDomains = [];
    await pool(files, 3, async (f, i) => {
      const r = msg.results[i];
      if (state.cancelRequested) return;
      try {
        const prep = await window.Extract.prepare(f.file, f.name);
        const parts = [];
        const domains = new Set();
        for (const b of prep.blobs) {
          if (b.mime === 'text/plain') {
            for (const m of (await b.blob.text()).matchAll(/[\w.%+-]+@([\w-]+(?:\.[\w-]+)*\.[a-z]{2,})/gi)) domains.add(m[1].toLowerCase());
          }
          const up = await withRetry(() => uploadFile(b));
          parts.push({ uri: up.uri, mimeType: up.mimeType || b.mime });
        }
        r.parts = parts;
        r.uploadedAt = Date.now();
        fileDomains[i] = [...domains];
      } catch (e) {
        if (e.status === 401) throw e;
        r.state = 'failed';
        r.error = e.message || 'Could not read this file.';
      }
      uploaded++;
      msg.note = `Reading and uploading files · ${uploaded} of ${files.length}`;
      paint(chat, msg);
    });
    if (state.cancelRequested) throw STOPPED;
    msg.note = '';
    msg.results.forEach((r, i) => { if (r.state === 'failed') paintResult(chat, msg, i); });
    paint(chat, msg);
    const todo = msg.results.map((r, i) => i).filter((i) => msg.results[i].parts);
    if (!todo.length) throw new Error('None of the files could be read.');
    const known = knownExecutives(msg.id);
    await pool(todo, 3, async (i) => {
      if (state.cancelRequested) return;
      const r = msg.results[i];
      const reuse = (fileDomains[i] || []).filter((d) => known.has(d)).slice(0, 1000)
        .map((d) => ({ domain: d, exec: known.get(d).exec, found: new Date(known.get(d).at).toISOString().slice(0, 10) }));
      try {
        await answerOne(chat, msg, i, { task: msg.task, useSearch: msg.useSearch, name: r.name, parts: r.parts, history, ...(reuse.length ? { known: reuse } : {}) });
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
    if (fmt === 'pdf') return downloadPdf(chat.title, chatForPdf(chat));
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
  // The whole conversation for a PDF: your messages, then each answer under its file name.
  function chatForPdf(chat) {
    const out = [];
    for (const msg of chat.messages) {
      if (msg.role === 'user') {
        const files = msg.files && msg.files.length ? `\n[Attached: ${msg.files.map((f) => f.name).join(', ')}]` : '';
        out.push({ you: true, text: msg.text + files });
      } else {
        for (const r of msg.results) if (r.text || r.error) out.push({ name: msg.kind === 'files' ? r.name : '', text: r.error ? `Failed: ${r.error}` : r.text, sources: r.sources });
      }
    }
    return out;
  }
  // Markdown to readable plain text for the PDF.
  const mdToText = (t) => String(t || '')
    .replace(/```[\w-]*\n?/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '$1 ($2)')
    .replace(/^(\s*)[-*+]\s+/gm, '$1• ');

  // Builds a real PDF file in the browser and downloads it.
  async function downloadPdf(title, blocks) {
    try {
      await loadScript('pdf');
    } catch (e) {
      return toast(e.message);
    }
    const doc = new window.jspdf.jsPDF({ unit: 'pt', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const M = 54;
    let y = M;
    const write = (text, { size = 10.5, bold = false, color = [29, 28, 25], after = 0, indent = 0 } = {}) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal');
      doc.setFontSize(size);
      doc.setTextColor(...color);
      for (const line of doc.splitTextToSize(text || ' ', W - 2 * M - indent)) {
        if (y + size > H - M) { doc.addPage(); y = M; }
        doc.text(line, M + indent, y + size);
        y += size * 1.4;
      }
      y += after;
    };
    write(title, { size: 17, bold: true, after: 2 });
    write(`DocBatch · ${new Date().toLocaleString()}`, { size: 8.5, color: [138, 134, 123], after: 16 });
    for (const b of blocks) {
      if (b.you) {
        write('You', { size: 9, bold: true, color: [31, 95, 58], after: 1 });
        write(b.text, { color: [87, 84, 76], after: 12 });
        continue;
      }
      if (b.name) write(b.name, { size: 12, bold: true, after: 4 });
      for (const para of mdToText(b.text).split('\n')) write(para, { after: para.trim() ? 0 : -6 });
      const sources = (b.sources || []).filter((s) => /^https?:\/\//i.test(s.uri));
      if (sources.length) {
        y += 6;
        write('Sources', { size: 8.5, bold: true, color: [138, 134, 123], after: 1 });
        for (const s of sources) write(`${s.title || host(s.uri)} — ${s.uri}`, { size: 8, color: [138, 134, 123] });
      }
      y += 16;
    }
    const pages = doc.getNumberOfPages();
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(138, 134, 123);
      doc.text(`${p} / ${pages}`, W - M, H - 28, { align: 'right' });
    }
    const safe = String(title || 'docbatch').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'docbatch';
    doc.save(`${safe}.pdf`);
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
      if (c.model) $('#modelName').textContent = c.model;
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
    $('#barNewChat').addEventListener('click', newChat);
    $('#chatSearch').addEventListener('input', renderSidebar);
    $('#openSide').addEventListener('click', openSide);
    $('#collapseSide').addEventListener('click', () => (mobile() ? closeSide() : setCollapsed(true)));
    $('#scrim').addEventListener('click', closeSide);
    $('#chatMenu').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      const id = state.menuChatId;
      if (!b || !id) return;
      e.stopPropagation();
      closeChatMenu();
      if (b.dataset.act === 'rename') { state.renamingId = id; renderSidebar(); } else deleteChat(id);
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#chatMenu')) closeChatMenu(); });
    $('#chatList').addEventListener('scroll', closeChatMenu);
    // Keeps the elapsed time on working answers ticking between events.
    setInterval(() => {
      for (const n of document.querySelectorAll('.time[data-t0]')) n.textContent = fmtDur(Math.round((Date.now() - Number(n.dataset.t0)) / 1000));
    }, 1000);
    $('#app').classList.toggle('side-collapsed', state.sideCollapsed);
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); newChat(); }
      if (e.key === 'Escape') { closeSide(); closeChatMenu(); attachMenu.hidden = true; exportMenu.hidden = true; }
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
