'use strict';
const { streamRoute, httpError, cleanModel } = require('./_lib');
const { researchDomain, engineHealth } = require('./_leads');

// Companies researched at once. Reading websites and judging run in parallel; searches still start one
// second apart (paced in _leads.js), so more workers do not mean a burst on your SearXNG server.
// The website pass (pass: 'site') does no searching at all, so it runs more companies at once.
const WORKERS = 8;
const SITE_WORKERS = 16;
// The function may run 300 s (vercel.json). New companies are only started in the first 170 s; any not
// started come back as `remaining` and the page sends them again.
const START_MS = 170000;
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
  const namesFor = (d) => (Array.isArray(contacts[d]) ? contacts[d] : []).map((n) => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 3);

  const started = Date.now();
  const usage = { input: 0, output: 0, searches: 0, google: 0, pages: 0 };
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(siteOnly ? SITE_WORKERS : WORKERS, domains.length) }, async () => {
    while (next < domains.length && Date.now() - started < START_MS) {
      const domain = domains[next++];
      emit({ type: 'company', domain });
      let result;
      try {
        result = await researchDomain(domain, model, (ev) => emit({ ...ev, domain }), usage, namesFor(domain), { siteOnly });
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
