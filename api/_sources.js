'use strict';
// Free sources besides search engines, none of which block servers:
// - Wikidata: the CEO / director / chair of any organisation whose official website is the lead's domain.
// - ProPublica Nonprofit Explorer: the officers a nonprofit lists on its latest IRS Form 990.
// - Wayback Machine: pages of the company's site that nothing links to any more (team, leadership...), and
//   copies of sites that are down or block us.

const UA = 'DocBatch/1.0 (company research; https://github.com/Timi16/docsbatch)';
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const fold = (s) => squash(String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ')).toLowerCase();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function getJson(url, ms = 20000, headers = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).hostname} answered ${r.status}`);
  return r.json();
}

// One query for a whole batch of domains. Only roles with no end date are returned.
async function wikidataLookup(domains) {
  const out = {};
  if (!domains.length) return out;
  const sites = domains.flatMap((d) => ['https://', 'http://'].flatMap((p) => ['', 'www.'].flatMap((w) => [`<${p}${w}${d}/>`, `<${p}${w}${d}>`])));
  const query = `SELECT ?w ?item ?itemLabel ?role ?person ?personLabel ?start WHERE {
    VALUES ?w { ${sites.join(' ')} }
    ?item wdt:P856 ?w .
    { ?item p:P169 ?st . ?st ps:P169 ?person . BIND("chief executive officer" AS ?role) }
    UNION { ?item p:P1037 ?st . ?st ps:P1037 ?person . BIND("director / manager" AS ?role) }
    UNION { ?item p:P488 ?st . ?st ps:P488 ?person . BIND("chairperson" AS ?role) }
    FILTER NOT EXISTS { ?st pq:P582 ?end }
    OPTIONAL { ?st pq:P580 ?start }
    SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
  }`;
  const data = await getJson(`https://query.wikidata.org/sparql?query=${encodeURIComponent(query)}`, 30000, { Accept: 'application/sparql-results+json' });
  for (const b of data.results.bindings) {
    const domain = new URL(b.w.value).hostname.replace(/^www\./, '');
    const person = b.personLabel && b.personLabel.value;
    if (!person || /^Q\d+$/.test(person)) continue; // no English label
    (out[domain] = out[domain] || []).push({
      org: b.itemLabel.value, role: b.role.value, person,
      start: b.start ? b.start.value.slice(0, 10) : null,
      url: b.item.value.replace('http://www.wikidata.org/entity/', 'https://www.wikidata.org/wiki/'),
    });
  }
  return out;
}

// The nonprofit whose name matches `name`, with the officers on its newest Form 990.
async function nonprofitOfficers(name) {
  const core = fold(name).replace(/\b(inc|incorporated|the|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (core.length < 4) return null;
  const found = await getJson(`https://projects.propublica.org/nonprofits/api/v2/search.json?q=${encodeURIComponent(name)}`);
  const org = (found.organizations || []).find((o) => {
    const n = fold(o.name).replace(/\b(inc|incorporated|the|of|and)\b/g, ' ').replace(/\s+/g, ' ').trim();
    return n === core || n.startsWith(`${core} `) || core.startsWith(`${n} `);
  });
  if (!org) return null;
  const url = `https://projects.propublica.org/nonprofits/organizations/${org.ein}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return null;
  const html = await r.text();
  const table = html.match(/<table class="employees[\s\S]*?<\/table>/);
  if (!table) return null;
  const officers = [];
  for (const m of table[0].matchAll(/<td class="padded-right">\s*([^<]+?)\s*<span>\(([^)]*)\)<\/span>/g)) {
    officers.push({ name: squash(decode(m[1])), title: squash(decode(m[2])) });
    if (officers.length >= 12) break;
  }
  const year = (html.match(/fiscal year ending ([A-Z][a-z]{2}\.? \d{4})/) || [])[1] || null;
  return officers.length ? { org: org.name, city: org.city, state: org.state, url, year, officers } : null;
}

// The Wayback Machine allows about 15 requests a minute and refuses connections for a while after a burst,
// so its requests are spaced out, and after a refusal it is left alone for 10 minutes.
const ARCHIVE_PACE_MS = 4500;
let archiveNext = 0;
let archiveResting = 0;
async function archiveFetch(url, ms) {
  if (Date.now() < archiveResting) return null;
  const wait = archiveNext - Date.now();
  archiveNext = Math.max(Date.now(), archiveNext) + ARCHIVE_PACE_MS;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  if (Date.now() < archiveResting) return null;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(ms) });
    if (r.status === 429) archiveResting = Date.now() + 10 * 60 * 1000;
    return r;
  } catch (e) {
    if (e.cause && e.cause.code === 'ECONNREFUSED') archiveResting = Date.now() + 10 * 60 * 1000;
    return null;
  }
}

// Leadership-looking pages the Wayback Machine has seen on this domain, best first.
const ARCHIVE_HINT = 'about|team|leadership|management|our-story|who-we-are|founder|people|staff|executive|board|meet|officers|owner|principal';
async function archivedPages(domain, rank) {
  const params = new URLSearchParams({ url: `${domain}/*`, fl: 'original', collapse: 'urlkey', limit: '60' });
  params.append('filter', 'statuscode:200');
  params.append('filter', `original:.*(${ARCHIVE_HINT}).*`);
  const r = await archiveFetch(`https://web.archive.org/cdx/search/cdx?${params}`, 20000);
  if (!r || !r.ok) return [];
  const seen = new Set();
  const urls = [];
  for (const line of (await r.text()).split('\n')) {
    let u;
    try { u = new URL(line.trim()); } catch { continue; }
    if (/\.(pdf|jpe?g|png|gif|css|js|xml|json|zip)$/i.test(u.pathname) || /\/(feed|embed|tag|category|page|wp-json)\//i.test(u.pathname)) continue;
    const key = u.pathname.replace(/\/+$/, '').toLowerCase();
    if (!key || seen.has(key) || key.split('/').length > 4) continue;
    seen.add(key);
    urls.push(`https://${domain}${u.pathname}`);
  }
  return urls.sort((a, b) => rank(a) - rank(b)).slice(0, 6);
}

// The newest archived copy of a page: { url, html, date } or null.
async function archivedCopy(url) {
  try {
    const r = await archiveFetch(`https://web.archive.org/web/2026id_/${url}`, 15000);
    if (!r || !r.ok || !/html/i.test(r.headers.get('content-type') || '')) return null;
    const stamp = (r.url.match(/\/web\/(\d{8})/) || [])[1];
    const html = (await r.text()).slice(0, 1500000);
    return { url: r.url.replace('id_/', '/'), html, date: stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : null };
  } catch {
    return null;
  }
}

module.exports = { wikidataLookup, nonprofitOfficers, archivedPages, archivedCopy };
