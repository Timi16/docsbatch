'use strict';
const { route, httpError } = require('./_lib');

// OpenAI has no API for the remaining prepaid balance. It does report what was spent (the Costs report, which
// needs an admin key). So: balance = credit you added (OPENAI_CREDIT) − cost reported since you added it
// (OPENAI_CREDIT_SINCE). The admin key never leaves the server; the page only gets the dollar amounts.
const CACHE_MS = 5 * 60 * 1000;
let cache = null;

async function spentSince(adminKey, since) {
  let total = 0;
  let page = null;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ start_time: String(Math.floor(since / 1000)), bucket_width: '1d', limit: '180' });
    if (page) params.set('page', page);
    const r = await fetch(`https://api.openai.com/v1/organization/costs?${params}`, {
      headers: { Authorization: `Bearer ${adminKey}` },
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw httpError(502, (data.error && data.error.message) || `OpenAI cost report failed (${r.status})`);
    for (const bucket of data.data || []) {
      for (const item of bucket.results || []) total += Number((item.amount && item.amount.value) || 0);
    }
    if (!data.has_more || !data.next_page) break;
    page = data.next_page;
  }
  return total;
}

module.exports = route(
  async () => {
    const adminKey = process.env.OPENAI_ADMIN_KEY;
    if (!adminKey) return { configured: false };
    const credit = Number(process.env.OPENAI_CREDIT);
    const sinceText = String(process.env.OPENAI_CREDIT_SINCE || '').trim();
    const since = /^\d{4}-\d{2}-\d{2}$/.test(sinceText) ? Date.parse(`${sinceText}T00:00:00Z`) : Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    const spent = await spentSince(adminKey, since);
    const value = {
      configured: true,
      since: new Date(since).toISOString().slice(0, 10),
      spent: Math.round(spent * 100) / 100,
      credit: Number.isFinite(credit) && credit > 0 ? credit : null,
      remaining: Number.isFinite(credit) && credit > 0 ? Math.round((credit - spent) * 100) / 100 : null,
    };
    cache = { at: Date.now(), value };
    return value;
  },
  { method: 'GET' }
);
