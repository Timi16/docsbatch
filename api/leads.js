'use strict';
const { streamRoute, httpError, cleanModel } = require('./_lib');
const { researchDomain } = require('./_leads');

// Companies researched at once. Searches inside one company run one after another, so this is also the most
// searches your SearXNG server gets at the same time.
const WORKERS = 3;
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
  const namesFor = (d) => (Array.isArray(contacts[d]) ? contacts[d] : []).map((n) => String(n || '').trim().slice(0, 40)).filter(Boolean).slice(0, 3);

  const started = Date.now();
  const usage = { input: 0, output: 0, searches: 0, pages: 0 };
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(WORKERS, domains.length) }, async () => {
    while (next < domains.length && Date.now() - started < START_MS) {
      const domain = domains[next++];
      emit({ type: 'company', domain });
      let result;
      try {
        result = await researchDomain(domain, model, (ev) => emit({ ...ev, domain }), usage, namesFor(domain));
      } catch (e) {
        // No credit left (402) or a rejected request will not fix itself: stop the batch and say why.
        if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
        result = { domain, status: 'error', reason: e.message || 'Research failed' };
      }
      usage.searches += result.searches || 0;
      usage.pages += result.pages || 0;
      results.push(result);
      emit({ type: 'domain', ...result });
    }
  }));
  const done = new Set(results.map((r) => r.domain));
  return { results, remaining: domains.filter((d) => !done.has(d)), usage };
});
