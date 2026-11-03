'use strict';
// Lead research engine: finds the current top executive of a company (from a lead's email domain).
// It is a budgeted best-first search: research moves (company website, common pages, sitemap, searches on your SearXNG) are tried most-promising first; after each round a judge (the model, reading only the
// evidence) names a candidate, and code decides whether it counts. Each round's findings (the real company name,
// its location, a VP instead of the boss, a suggested search) unlock better moves for the next round, until the
// executive is verified or the company's budget is spent (at most 3 judge rounds and 4 searches). Companies still
// unsolved then get one last round of Google searches (Serper, paid) when SERPER_KEY is set. Outcome: verified, likely (a strong candidate that
// narrowly failed a check, for a person to confirm) or not found, always with the reason and what was tried.
const { openai, searxngSearch, searchConfigured, serperAllowed, serperSearch, normalize } = require('./_lib');

const UA = 'Mozilla/5.0 (compatible; DocBatch/1.0; company research)';
const ROLE = /\b(chief executive officer|ceo|co-?founder|founder|co-?owner|owner|president|managing director|managing partner|managing member|principal|executive director|general manager|proprietor|commodore|chairman|chairwoman|chairperson)\b/i;
const PAGE_HINT = /(about|team|leadership|management|our-?story|who-?we-?are|company|founder|people|staff|executive|board|contact|meet|history|officers|owner)/i;
const COMMON_PATHS = ['/about', '/about-us', '/team', '/our-team', '/leadership', '/company', '/who-we-are', '/our-story', '/management', '/people', '/staff', '/contact', '/contact-us'];
const NONPROFIT = /\b(association|foundation|society|institute|chamber|club|church|school|academy|alliance|council|federation|coalition|charity|ministries|union|league|museum|orchestra|nonprofit)\b/i;
const PAGE_RANK = ['leadership', 'team', 'about', 'founder', 'management', 'people', 'our-story', 'who-we-are', 'executive', 'board', 'company', 'staff', 'meet', 'officers', 'history', 'owner', 'contact'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// For matching names against evidence: case, accents, punctuation and spacing do not matter.
const fold = (s) => squash(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ')).toLowerCase();

async function fetchPage(url, ms = 6000, maxBytes = 1500000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    if (!r.ok || !/html/i.test(r.headers.get('content-type') || '')) return null;
    const reader = r.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      size += value.length;
      if (size > maxBytes) { reader.cancel().catch(() => {}); break; }
    }
    return { url: r.url, html: Buffer.concat(chunks).toString('utf8') };
  } catch {
    return null;
  }
}

// Visible text with line breaks at block elements, so a name and its title stay on nearby lines.
function htmlToText(html) {
  return decode(html
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/td|\/dd|\/dt)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map(squash).filter(Boolean).join('\n');
}

// Founder / employee names from schema.org data, which many small-business sites include.
function structuredPeople(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (node, key) => {
      if (!node || typeof node !== 'object' || out.length > 10) return;
      if (Array.isArray(node)) { node.forEach((n) => walk(n, key)); return; }
      if (/founder|employee|member|ceo|owner|president|author/i.test(key || '') && typeof node.name === 'string') {
        out.push(`${key}: ${squash(node.name)}${node.jobTitle ? ` (${squash(node.jobTitle)})` : ''}`);
      }
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') walk(v, k);
    };
    walk(data, '');
  }
  return [...new Set(out)];
}

function companyNameFrom(html, domain) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i);
  if (og) return squash(decode(og[1])).slice(0, 80);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title) {
    const pieces = squash(decode(title[1])).split(/\s[|–—:-]\s|\s\|\s|\|/).map(squash).filter((p) => p.length > 1);
    const stem = domain.split('.')[0].replace(/[^a-z0-9]/gi, '').toLowerCase();
    const match = pieces.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, '').includes(stem.slice(0, 5)));
    if (match || pieces[0]) return (match || pieces[0]).slice(0, 80);
  }
  return null;
}

function stemName(domain) {
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Links on the same site that look like About / Team / Leadership / Contact pages, best first.
function candidateLinks(html, base, host) {
  const seen = new Set();
  const links = [];
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(decode(m[1]), base); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || url.hostname.replace(/^www\./, '') !== host) continue;
    if (/\.(pdf|jpe?g|png|gif|zip|docx?)$/i.test(url.pathname)) continue;
    const text = squash(htmlToText(m[2])).slice(0, 60);
    const key = url.origin + url.pathname.replace(/\/+$/, '');
    if (seen.has(key) || !(PAGE_HINT.test(url.pathname) || PAGE_HINT.test(text))) continue;
    seen.add(key);
    const hay = `${url.pathname} ${text}`.toLowerCase();
    const rank = PAGE_RANK.findIndex((w) => hay.includes(w));
    links.push({ url: url.href, rank: rank < 0 ? 99 : rank });
  }
  return links.sort((a, b) => a.rank - b.rank).map((l) => l.url);
}

// Lines that mention a leadership role, with one line of context either side.
function roleLines(text, limit) {
  const lines = text.split('\n');
  const keep = new Set();
  lines.forEach((line, i) => { if (ROLE.test(line) && line.length < 400) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j); });
  let out = [...keep].sort((a, b) => a - b).map((i) => lines[i].slice(0, 300)).join('\n');
  const copyright = text.match(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]?\s*\d{0,4}\s*)?([^\n|]{3,80})/i);
  if (copyright) out = `Footer: © ${squash(copyright[1])}\n${out}`;
  return out.slice(0, limit);
}

// ---- research moves --------------------------------------------------------------------------

// The home page: company name, footer legal name, links to About / Team pages, and leadership lines.
// The bare and www addresses are tried at once; plain http only if neither answers.
async function moveHome(st, emit) {
  const both = await Promise.all([`https://${st.domain}`, `https://www.${st.domain}`].map((u) => fetchPage(u)));
  const home = both.find(Boolean) || await fetchPage(`http://${st.domain}`);
  if (!home) return;
  st.reachable = true;
  st.pages++;
  emit({ type: 'open', url: home.url });
  const fromSite = companyNameFrom(home.html, st.domain);
  if (fromSite) { st.company = fromSite; st.nameFromSite = true; }
  st.links = candidateLinks(home.html, home.url, st.domain);
  st.base = new URL(home.url).origin;
  addPage(st, home);
}

// Reads pages not read yet, in parallel.
async function readPages(st, urls, emit) {
  const fresh = [...new Set(urls)].filter((u) => !st.read.has(u.replace(/\/+$/, ''))).slice(0, 5);
  fresh.forEach((u) => st.read.add(u.replace(/\/+$/, '')));
  const pages = await Promise.all(fresh.map((u) => fetchPage(u)));
  for (const p of pages) if (p) { st.pages++; emit({ type: 'open', url: p.url }); addPage(st, p); }
}

// Leadership-looking pages listed in the sitemap, best first (both usual sitemap addresses are asked at once).
async function sitemapLinks(base) {
  const lists = await Promise.all(['/sitemap.xml', '/sitemap_index.xml'].map(async (path) => {
    const r = await fetch(base + path, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (!r || !r.ok) return [];
    const xml = (await r.text().catch(() => '')).slice(0, 400000);
    const out = [];
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) { try { if (PAGE_HINT.test(new URL(m[1], base).pathname)) out.push(m[1]); } catch {} }
    return out;
  }));
  const ranked = (u) => { const i = PAGE_RANK.findIndex((w) => u.toLowerCase().includes(w)); return i < 0 ? 99 : i; };
  return (lists.find((l) => l.length) || []).sort((a, b) => ranked(a) - ranked(b));
}

// The whole website in two parallel steps: the home page, then its best linked pages together with the
// sitemap, then the next pages (more links, sitemap pages, common addresses like /about-us).
async function moveSite(st, emit) {
  await moveHome(st, emit);
  if (!st.reachable) return;
  const [, fromSitemap] = await Promise.all([readPages(st, st.links.slice(0, 4), emit), sitemapLinks(st.base)]);
  await readPages(st, [...st.links.slice(4, 8), ...fromSitemap, ...COMMON_PATHS.map((p) => st.base + p)], emit);
}

// ---- searching ------------------------------------------------------------------------------------
// Each query goes to all engines at once and SearXNG merges their results. (Asking one engine per query was
// tried and lost most results: blocked engines left many queries with a single source.) Searches are paced
// across all companies, so the engines never see a burst.
const PACE_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextSearchAt = 0;
const blocked = new Map(); // engine -> last time SearXNG reported it unresponsive

async function pacedSearch(query) {
  const wait = nextSearchAt - Date.now();
  nextSearchAt = Math.max(Date.now(), nextSearchAt) + PACE_MS;
  if (wait > 0) await sleep(wait);
  try {
    const res = await searxngSearch(query, 8);
    for (const e of res.unresponsive || []) blocked.set(e, Date.now());
    return res.results || [];
  } catch {
    return [];
  }
}

// One query, no automatic re-try (every extra search adds to the load that gets the server blocked).
// With `google`, it is a paid Serper search, counted separately and labelled in the progress trail.
async function moveSearch(st, query, emit, google = false) {
  (google ? st.triedGoogle : st.tried).add(query.toLowerCase());
  const results = google ? ((await serperSearch(query, 8).catch(() => ({}))).results || []) : await pacedSearch(query);
  if (google) st.google++; else st.searches++;
  emit({ type: 'search', queries: [query], urls: results.map((x) => x.url).slice(0, 5), ...(google ? { engine: 'google' } : {}) });
  if (results.length) addEvidence(st, `${google ? 'GOOGLE' : 'SEARCH'} "${query}"`, results.map((x) => `- ${x.title} — ${x.content} (${x.url})`).join('\n'));
}

// ---- evidence -------------------------------------------------------------------------------------

function addPage(st, page) {
  const people = structuredPeople(page.html);
  const text = htmlToText(page.html);
  if (!st.legal) {
    const c = text.match(/(?:©|copyright)\s*(?:\d{4}\s*[-–]?\s*\d{0,4}\s*)?([^\n|]{3,80})/i);
    if (c) st.legal = squash(c[1]).replace(/\.?\s*all rights reserved.*$/i, '').slice(0, 80) || null;
  }
  const lines = roleLines(text, 1800);
  if (people.length || lines) addEvidence(st, `WEBSITE ${page.url}`, `${people.map((x) => `Structured data — ${x}`).join('\n')}${people.length ? '\n' : ''}${lines}`, true);
}

function addEvidence(st, label, text, site = false) {
  if (!text || st.labels.has(label)) return;
  st.labels.add(label);
  st.evidence.push({ label, text, site });
}

// What the judge reads: the company's own pages first, then the search results with the most leadership
// mentions, within a size cap.
function evidenceText(st, cap = 14000) {
  const score = (e) => (e.site ? 1000 : 0) + (e.text.match(new RegExp(ROLE.source, 'gi')) || []).length;
  const chosen = [];
  let size = 0;
  for (const e of [...st.evidence].sort((a, b) => score(b) - score(a))) {
    const chunk = `${e.label}\n${e.text}`;
    if (size + chunk.length > cap) continue;
    chosen.push(e);
    size += chunk.length + 2;
  }
  return st.evidence.filter((e) => chosen.includes(e)).map((e) => `${e.label}\n${e.text}`).join('\n\n');
}

// ---- the plan: which searches to try next, best first, from what is known so far ----------------

function nextQueries(st, contacts, n, tried = st.tried) {
  if (n <= 0) return [];
  const name = st.legal && st.legal.split(/\s+/).length >= 2 && st.legal.length < 60 ? st.legal.replace(/,?\s*(inc|llc|ltd|corp|co)\.?$/i, '') : st.company;
  // A short or one-word name ("Emerge") matches many companies, so the web address stands in for it.
  const generic = name.split(/\s+/).length < 2 || name.length < 9;
  const who = generic ? st.domain : name;
  const nonprofit = /\.org$/.test(st.domain) || NONPROFIT.test(name);
  const yacht = /yacht|sailing|boat club/i.test(name);
  // Clubs and nonprofits are led by a Commodore or Executive Director, so those titles go first for them.
  const plan = [
    ...(yacht ? [`${name} commodore`] : []),
    ...(nonprofit ? [`${name} executive director`, `${name} president`] : []),
    `${who} CEO`,
    `${who} owner`,
    ...st.suggested,
    `${who} president`,
    nonprofit ? `${name} executive director` : `${name} founder`,
    st.location ? `${name} ${st.location} owner` : null,
    `${st.domain} CEO`,
    ...contacts.filter((c) => /\p{L}{2,}/u.test(c)).slice(0, 2).map((c) => `${c} ${who}`),
    st.sawDeputy ? `${who} president CEO` : null,
    nonprofit ? `${name} 990 officers` : `${who} linkedin CEO`,
    nonprofit ? `${name} board president` : `${who} managing director`,
    `${who} principal`,
  ];
  const out = [];
  for (const q of plan) {
    if (!q || tried.has(q.toLowerCase()) || out.includes(q)) continue;
    out.push(q);
    if (out.length >= n) break;
  }
  return out;
}

// ---- the judge ------------------------------------------------------------------------------------

const PICK = `You identify the CURRENT top executive of one company, using only the evidence given.
Top executive means, in order of preference: CEO / Chief Executive Officer; else President; else Owner / Proprietor; else Founder or Co-founder who still runs it; else Managing Director, Managing Partner, Managing Member or Principal; for nonprofits, associations and chambers the Executive Director (or President); for yacht clubs the Commodore; else General Manager.
Rules:
- Use only the evidence. Never use outside knowledge and never guess.
- The person must hold the role now. Skip anyone described as former, ex-, retired, interim-ended, or who has left; when evidence conflicts, prefer the company's own website and the most recent dated source.
- Several companies can share a name: only use evidence that matches this domain or clearly this company (location, industry).
- evidence_quote must be copied exactly from the evidence and must contain the person's name.
- If the evidence only names someone below the top (e.g. a Vice President), return them with is_top_executive false.
- If the evidence does not name anyone, return name null.
- confidence: 0.9 when the company's own site or an official source names them with the title; 0.7 for a clear reliable third-party source (a LinkedIn title "CEO at <company>", a press release); lower when unsure.
- If the evidence shows one of the lead-list people is this company's owner, founder, president or CEO, they count.
- name: the person's full name only, without titles like Mr, Dr or CEO. A shortened surname (e.g. "Melissa B.") is not a full name: return name null.
- Also report what helps the next search: the company's real name and location if the evidence shows them, and next_search: the single short web search most likely to find the current top executive (null if already found).`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'is_top_executive', 'evidence_url', 'evidence_quote', 'confidence', 'company_name', 'location', 'next_search'],
  properties: {
    name: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    is_top_executive: { type: 'boolean' },
    evidence_url: { type: ['string', 'null'] },
    evidence_quote: { type: ['string', 'null'] },
    confidence: { type: 'number' },
    company_name: { type: ['string', 'null'] },
    location: { type: ['string', 'null'] },
    next_search: { type: ['string', 'null'] },
  },
};

async function judge(st, model, usage, contacts) {
  const evidence = evidenceText(st);
  if (!evidence) return null;
  st.judges++;
  const ask = () => openai('/responses', {
    method: 'POST',
    json: {
      model,
      instructions: PICK,
      input: `Company domain: ${st.domain}\nCompany name (best guess): ${st.company}${st.legal ? ` (legal name on site: ${st.legal})` : ''}${contacts.length ? `\nPeople at this company in the lead list: ${contacts.slice(0, 3).join(', ')}` : ''}\n\nEVIDENCE\n${evidence}`,
      text: { format: { type: 'json_schema', name: 'executive', schema: SCHEMA, strict: true } },
    },
  });
  // A rate limit or a hiccup at OpenAI gets one more try before the company counts as failed.
  let data;
  try { data = await ask(); } catch (e) { if (![429, 502].includes(e.status)) throw e; await sleep(2500); data = await ask(); }
  if (data.usage) {
    usage.input += data.usage.input_tokens || 0;
    usage.output += data.usage.output_tokens || 0;
  }
  let pick = null;
  try { pick = JSON.parse(normalize(data).text); } catch { return null; }
  // What this round learned unlocks better moves for the next one.
  // A name read from the company's own site is only replaced by one that shares a word with it, so one wrong
  // guess cannot send every later search after a different company.
  const newName = pick.company_name && pick.company_name.length < 80 ? squash(pick.company_name) : null;
  const shares = (a, b) => fold(a).split(' ').some((w) => w.length > 2 && fold(b).split(' ').includes(w));
  if (newName && fold(newName) !== fold(st.company) && (!st.nameFromSite || shares(newName, st.company))) st.company = newName;
  if (pick.location && pick.location.length < 60) st.location = squash(pick.location);
  if (pick.next_search && pick.next_search.length < 120) st.suggested.unshift(squash(pick.next_search));
  if (pick.name && !pick.is_top_executive) st.sawDeputy = true;
  return { pick, evidence };
}

// ---- deciding: code, not the model, says what counts --------------------------------------------

const BUSINESS_WORD = /\b(inc|llc|ltd|llp|plc|corp|corporation|company|co|group|systems|solutions|services|consulting|technologies|technology|partners|holdings|industries|international|global|enterprises|aerospace|labs|software|agency|studio|foundation|association|club|university|bank|team|staff|office)\b/i;
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

// verified: a person, word for word in the evidence, the top role, confident enough (a stricter bar when the
// only source is a third-party data site). likely: a real candidate that narrowly failed. Otherwise a reason.
function accept(pick, evidence, company = '', domain = '') {
  if (!pick || !pick.name) return { ok: false, code: 'none', reason: 'No current top executive named in the evidence found' };
  const name = squash(pick.name).replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '');
  const words = name.split(' ');
  const looksLikeCompany = BUSINESS_WORD.test(name) || (company && (fold(company).includes(fold(name)) || fold(name).includes(fold(company))));
  if (words.length < 2 || words.length > 5 || ROLE.test(name) || /\d/.test(name) || looksLikeCompany) return { ok: false, code: 'not_person', reason: `"${name}" does not look like a person's full name` };
  if (!fold(evidence).includes(fold(name))) return { ok: false, code: 'not_in_evidence', reason: `"${name}" is not in the evidence, so it was not trusted` };
  const tidy = name === name.toLowerCase() ? name.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : name;
  if (pick.is_top_executive === false) return { ok: false, code: 'not_top', name: tidy, reason: `Only found ${tidy}${pick.title ? ` (${squash(pick.title)})` : ''}, not the top executive` };
  const official = domain && host(pick.evidence_url || '').endsWith(domain);
  const bar = official ? 0.6 : 0.75;
  if (!(pick.confidence >= bar)) return { ok: false, code: 'weak', name: tidy, likely: pick.confidence >= 0.45, reason: `Not certain enough (${tidy}${official ? '' : ', only a third-party source'})` };
  return { ok: true, name: tidy };
}

// ---- the search loop ------------------------------------------------------------------------------

// Budget per company: rounds of moves, each ending with the judge. Most companies are verified in the
// first round; the budget only runs out on companies that publish their leader nowhere we can reach.
// Website first: the whole site (home, linked pages, sitemap, common pages) is read and judged before any
// search. Searches are capped at 4 per company, because heavy searching is what gets a search server blocked.
// The last round is Google (paid): only for companies still unsolved, only while Serper has credits left, at
// most SERPER_PER_COMPANY (default 2) searches. The free rounds stop at FREE_MS so it always has time left.
const ROUNDS = [
  { site: true, searches: 0 },
  { searches: 2 },
  { searches: 2 },
  { google: true },
];
const FREE_MS = 90000;
const MAX_MS = 120000;
const googlePerCompany = () => Math.max(0, Math.min(4, Number(process.env.SERPER_PER_COMPANY ?? 2) || 0));

// siteOnly: just the website round (the page's first pass over a whole list); searching comes in a later call.
async function researchDomain(domain, model, emit, usage, contacts = [], { siteOnly = false } = {}) {
  const st = {
    domain, company: stemName(domain), nameFromSite: false, legal: null, location: null, base: null, links: [], read: new Set(),
    evidence: [], labels: new Set(), tried: new Set(), triedGoogle: new Set(), suggested: [], sawDeputy: false,
    reachable: false, searches: 0, google: 0, pages: 0, judges: 0,
  };
  const started = Date.now();
  const canSearch = searchConfigured();
  let best = null;
  let last = { ok: false, code: 'none', reason: 'Nothing found' };
  for (const round of siteOnly ? ROUNDS.slice(0, 1) : ROUNDS) {
    if (Date.now() - started > (round.google ? MAX_MS : FREE_MS)) continue;
    const before = st.evidence.length;
    if (round.site) await moveSite(st, emit);
    if (round.google) {
      if (!googlePerCompany() || !(await serperAllowed())) break;
      for (const q of nextQueries(st, contacts, googlePerCompany(), st.triedGoogle)) await moveSearch(st, q, emit, true);
    } else if (canSearch) for (const q of nextQueries(st, contacts, round.searches)) await moveSearch(st, q, emit);
    if (st.evidence.length === before && st.judges) continue; // nothing new to judge
    const judged = await judge(st, model, usage, contacts);
    if (!judged) continue;
    last = accept(judged.pick, judged.evidence, st.company, domain);
    if (last.ok) {
      const p = judged.pick;
      return { domain, company: st.company, status: 'verified', name: last.name, title: squash(p.title).slice(0, 80) || null, url: p.evidence_url || null, quote: squash(p.evidence_quote).slice(0, 240) || null, searches: st.searches, google: st.google, pages: st.pages, rounds: st.judges };
    }
    if (last.likely || (last.code === 'weak' && last.name)) best = { ...judged.pick, name: last.name, reason: last.reason };
  }
  const tried = `tried ${st.pages} page${st.pages === 1 ? '' : 's'} and ${st.searches} search${st.searches === 1 ? '' : 'es'}${st.google ? ` + ${st.google} Google` : ''}`;
  if (best) {
    return { domain, company: st.company, status: 'likely', name: best.name, title: squash(best.title).slice(0, 80) || null, url: best.evidence_url || null, quote: squash(best.evidence_quote).slice(0, 240) || null, reason: `${best.reason}; ${tried}`, searches: st.searches, google: st.google, pages: st.pages, rounds: st.judges };
  }
  const reason = !st.reachable && !st.evidence.length ? 'Website not reachable and nothing found in search'
    : !st.evidence.length ? 'No leader named on the website or in search'
      : last.reason;
  return { domain, company: st.company, status: 'review', code: last.code, reason: `${reason} (${tried})`, searches: st.searches, google: st.google, pages: st.pages, rounds: st.judges };
}

// Engines SearXNG reported as blocked in the last 10 minutes (for the progress trail).
const engineHealth = () => Object.fromEntries([...blocked].filter(([, t]) => Date.now() - t < 10 * 60 * 1000).map(([e]) => [e, 'blocked']));

module.exports = { researchDomain, accept, fold, engineHealth, nextQueries };
