'use strict';
// Lead research engine: finds the current top executive of a company (from a lead's email domain) using the
// company's own website and your SearXNG server, then has the model pick a name from that evidence only.
// Code, not the model, decides what counts as verified: the name must appear word for word in the evidence.
const { openai, searxngSearch, searchConfigured, normalize } = require('./_lib');

const UA = 'Mozilla/5.0 (compatible; DocBatch/1.0; company research)';
const ROLE = /\b(chief executive officer|ceo|co-?founder|founder|co-?owner|owner|president|managing director|managing partner|managing member|principal|executive director|general manager|proprietor|commodore|chairman|chairwoman|chairperson)\b/i;
const PAGE_HINT = /(about|team|leadership|management|our-?story|who-?we-?are|company|founder|people|staff|executive|board|contact|meet|history|officers|owner)/i;
const PAGE_RANK = ['leadership', 'team', 'about', 'founder', 'management', 'people', 'our-story', 'who-we-are', 'executive', 'board', 'company', 'staff', 'meet', 'officers', 'history', 'owner', 'contact'];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// For matching names against evidence: case, accents, punctuation and spacing do not matter.
const fold = (s) => squash(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ')).toLowerCase();

async function fetchPage(url, ms = 8000, maxBytes = 1500000) {
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

// Reads the company site: the home page plus its most promising About / Team pages. With `links`, reads just
// those pages (used by the second pass for pages the first pass did not get to).
async function readWebsite(domain, { maxPages, links: given }, emit) {
  const pages = [];
  let company = null;
  let links = given || [];
  let reachable = !!given;
  if (!given) {
    let home = null;
    for (const url of [`https://${domain}`, `https://www.${domain}`, `http://${domain}`]) {
      home = await fetchPage(url);
      if (home) break;
    }
    if (home) {
      reachable = true;
      company = companyNameFrom(home.html, domain);
      links = candidateLinks(home.html, home.url, domain);
      pages.push(home);
      emit({ type: 'open', url: home.url });
    }
  }
  const fetched = await Promise.all((given || links).slice(0, maxPages).map((u) => fetchPage(u)));
  for (const p of fetched) if (p) { pages.push(p); emit({ type: 'open', url: p.url }); }
  const evidence = [];
  for (const p of pages) {
    const people = structuredPeople(p.html);
    const lines = roleLines(htmlToText(p.html), 1800);
    if (people.length || lines) evidence.push(`WEBSITE ${p.url}\n${people.map((x) => `Structured data — ${x}`).join('\n')}${people.length ? '\n' : ''}${lines}`);
  }
  return { company, links, evidence, reachable, pages: pages.length };
}

async function searchAll(queries, emit) {
  const evidence = [];
  let count = 0;
  for (const q of queries) {
    let res;
    try { res = await searxngSearch(q, 8); } catch { res = { error: 'unreachable' }; }
    count++;
    const results = res.results || [];
    emit({ type: 'search', queries: [q], urls: results.map((x) => x.url).slice(0, 5) });
    if (results.length) evidence.push(`SEARCH "${q}"\n${results.map((x) => `- ${x.title} — ${x.content} (${x.url})`).join('\n')}`);
  }
  return { evidence, count };
}

const PICK = `You identify the CURRENT top executive of one company, using only the evidence given.
Top executive means, in order of preference: CEO / Chief Executive Officer; else President; else Owner / Proprietor; else Founder or Co-founder who still runs it; else Managing Director, Managing Partner, Managing Member or Principal; for nonprofits, associations and chambers the Executive Director (or President); for yacht clubs the Commodore; else General Manager.
Rules:
- Use only the evidence. Never use outside knowledge and never guess.
- The person must hold the role now. Skip anyone described as former, ex-, retired, interim-ended, or who has left; when evidence conflicts, prefer the company's own website and the most recent dated source.
- The evidence must be about this company (match the domain or company name), not a similarly named one.
- evidence_quote must be copied exactly from the evidence and must contain the person's name.
- If the evidence does not clearly name the current top executive, return name null.
- confidence: 0.9 when the company's own site or an official source names them with the title; 0.7 for a clear reliable third-party source (e.g. a LinkedIn title "CEO at <company>", a press release); below 0.6 means you are not sure.
- If the evidence shows one of the lead-list people is this company's owner, founder, president or CEO, they count.
- Several companies can share a name: only use evidence that matches this domain or clearly this company (location, industry).
- name: the person's full name only, without titles like Mr, Dr or CEO. If the evidence only gives a shortened surname (e.g. "Melissa B."), return name null.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'title', 'evidence_url', 'evidence_quote', 'confidence'],
  properties: {
    name: { type: ['string', 'null'] },
    title: { type: ['string', 'null'] },
    evidence_url: { type: ['string', 'null'] },
    evidence_quote: { type: ['string', 'null'] },
    confidence: { type: 'number' },
  },
};

async function pickExecutive(model, domain, company, evidence, usage, contacts = []) {
  const data = await openai('/responses', {
    method: 'POST',
    json: {
      model,
      instructions: PICK,
      input: `Company domain: ${domain}\nCompany name (best guess): ${company}${contacts.length ? `\nPeople at this company in the lead list: ${contacts.slice(0, 3).join(', ')}` : ''}\n\nEVIDENCE\n${evidence}`,
      text: { format: { type: 'json_schema', name: 'executive', schema: SCHEMA, strict: true } },
    },
  });
  if (data.usage) {
    usage.input += data.usage.input_tokens || 0;
    usage.output += data.usage.output_tokens || 0;
  }
  try { return JSON.parse(normalize(data).text); } catch { return null; }
}

// The anti-guessing check: a pick only counts if the name is really in the evidence and looks like a person.
const BUSINESS_WORD = /\b(inc|llc|ltd|llp|plc|corp|corporation|company|co|group|systems|solutions|services|consulting|technologies|technology|partners|holdings|industries|international|global|enterprises|aerospace|labs|software|agency|studio|foundation|association|club|university|bank|team|staff|office)\b/i;
function accept(pick, evidence, company = '') {
  if (!pick || !pick.name) return { ok: false, reason: 'No current top executive named in the evidence found' };
  const name = squash(pick.name).replace(/^(mr|mrs|ms|miss|dr|prof)\.?\s+/i, '');
  const words = name.split(' ');
  const looksLikeCompany = BUSINESS_WORD.test(name) || (company && (fold(company).includes(fold(name)) || fold(name).includes(fold(company))));
  if (words.length < 2 || words.length > 5 || ROLE.test(name) || /\d/.test(name) || looksLikeCompany) return { ok: false, reason: `"${name}" does not look like a person's full name` };
  if (!fold(evidence).includes(fold(name))) return { ok: false, reason: `"${name}" is not in the evidence, so it was not trusted` };
  if (!(pick.confidence >= 0.6)) return { ok: false, reason: `Only a weak match (${name})` };
  return { ok: true, name: name === name.toLowerCase() ? name.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : name };
}

// Researches one company in up to two passes; the second pass only runs when the first finds nobody.
// Searches use plain wording ("Company CEO"): several engines ignore or garble OR, which hid real answers.
async function researchDomain(domain, model, emit, usage, contacts = []) {
  const stats = { searches: 0, pages: 0 };
  const site = await readWebsite(domain, { maxPages: 4 }, emit);
  stats.pages += site.pages;
  const company = site.company || stemName(domain);
  const canSearch = searchConfigured();
  // A short or one-word name ("Emerge") matches many companies, so search by the web address instead.
  const generic = company.split(/\s+/).length < 2 || company.length < 9;
  const q1 = canSearch ? await searchAll(generic ? [`${domain} CEO`, `${domain} president`] : [`${company} CEO`, `${company} owner`], emit) : { evidence: [], count: 0 };
  stats.searches += q1.count;
  let evidence = [...site.evidence, ...q1.evidence].join('\n\n').slice(0, 9000);
  let pick = evidence ? await pickExecutive(model, domain, company, evidence, usage, contacts) : null;
  let verdict = evidence ? accept(pick, evidence, company) : { ok: false, reason: site.reachable ? 'Nothing about its leadership on the website or in search' : 'Website not reachable and nothing found in search' };

  if (!verdict.ok) {
    // Second pass: more pages from the same site and differently worded searches.
    const more = site.links.length > 4 ? await readWebsite(domain, { maxPages: 4, links: site.links.slice(4, 8) }, emit) : { evidence: [], pages: 0 };
    stats.pages += more.pages;
    // The lead is often the owner of a small company, so their own name is searched with the company too.
    const people = contacts.filter((n) => /\p{L}{2,}/u.test(n)).slice(0, 2);
    const q2 = canSearch ? await searchAll([
      `${company} president`,
      `${company} founder`,
      `${company} executive director`,
      ...people.map((n) => `${n} ${generic ? domain : company}`),
      generic ? `${domain} owner` : `${domain} CEO`,
    ], emit) : { evidence: [], count: 0 };
    stats.searches += q2.count;
    const extra = [...more.evidence, ...q2.evidence];
    if (extra.length) {
      evidence = [...site.evidence, ...q1.evidence, ...extra].join('\n\n').slice(0, 14000);
      pick = await pickExecutive(model, domain, company, evidence, usage, contacts);
      verdict = accept(pick, evidence, company);
    }
  }
  return verdict.ok
    ? { domain, company, status: 'verified', name: verdict.name, title: squash(pick.title).slice(0, 80) || null, url: pick.evidence_url || null, quote: squash(pick.evidence_quote).slice(0, 240) || null, ...stats }
    : { domain, company, status: 'review', reason: verdict.reason, ...stats };
}

module.exports = { researchDomain, readWebsite, searchAll, accept, fold };
