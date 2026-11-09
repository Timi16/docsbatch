'use strict';
const { streamRoute, httpError, cleanModel } = require('./_lib');
const { researchDomain, engineHealth } = require('./_leads');
const { wikidataLookup } = require('./_sources');

// Companies researched at once. Reading websites and judging run in parallel; searches still start one
// second apart (paced in _leads.js), so more workers do not mean a burst on your SearXNG server.
// The website pass (pass: 'site') does no searching at all, so it runs more companies at once.
const WORKERS = 8;
const SITE_WORKERS = 16;
// The function may run 300 s (vercel.json). New companies are only started in the first 170 s of a website
// pass (about 30 s per company) and the first 120 s of a full pass (up to 165 s per company); any not started
// come back as `remaining` and the page sends them again.
const SITE_START_MS = 170000;
const FULL_START_MS = 120000;
// The stubborn pass (pass: 'stubborn', companies every other pass failed) spends up to 250 s on each, so
// fewer at once and only started in the first 40 s.
const STUBBORN_WORKERS = 4;
const STUBBORN_START_MS = 40000;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;

// Researches a batch of company domains (from lead emails), streaming each result as it is found.
module.exports = streamRoute(async (req, emit) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const model = cleanModel(b.model);
  const domains = [...new Set((Array.isArray(b.domains) ? b.domains : []).map((d) => String(d || '').trim().toLowerCase()))]
    .filter((d) => DOMAIN.test(d)).slice(0, 40);
  if (!domains.length) throw httpError(400, 'No company domains to research.');
  // First names of the leads at each company (optional), for the "the lead is the owner" search.
  const contacts = b.contacts && typeof b.contacts === 'object' ? b.contacts : {};
  const siteOnly = b.pass === 'site';
  const stubborn = b.pass === 'stubborn';
  const workers = siteOnly ? SITE_WORKERS : stubborn ? STUBBORN_WORKERS : WORKERS;
  const startMs = siteOnly ? SITE_START_MS : stubborn ? STUBBORN_START_MS : FULL_START_MS;
  const namesFor = (d) => (Array.isArray(contacts[d]) ? contacts[d] : []).map((n) => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 3);

  const started = Date.now();
  const usage = { input: 0, output: 0, searches: 0, google: 0, pages: 0 };
  const results = [];
  // Organisations whose official website is one of these domains, with their CEO / director / chair: one
  // Wikidata query for the whole batch.
  const wikidata = await wikidataLookup(domains).catch(() => ({}));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workers, domains.length) }, async () => {
    while (next < domains.length && Date.now() - started < startMs) {
      const domain = domains[next++];
      emit({ type: 'company', domain });
      let result;
      try {
        result = await researchDomain(domain, model, (ev) => emit({ ...ev, domain }), usage, namesFor(domain), { siteOnly, stubborn, wikidata: wikidata[domain] || [] });
      } catch (e) {
        // Only problems that stop every company end the batch: no OpenAI credit (402) or a key/permission
        // problem (401/403). Anything else affects just this company, which the page retries later.
        if ([401, 402, 403].includes(e.status)) throw e;
        result = { domain, status: 'error', reason: e.message || 'Research failed' };
      }
      usage.searches += result.searches || 0;
      usage.google += result.google || 0;
      usage.pages += result.pages || 0;
      results.push(result);
      emit({ type: 'domain', ...result });
    }
  }));
  const done = new Set(results.map((r) => r.domain));
  return { results, remaining: domains.filter((d) => !done.has(d)), usage, engines: engineHealth() };
});
