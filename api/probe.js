'use strict';
// Temporary: how fast Yahoo can be asked from one Vercel server. Needs ?key=<SEARXNG_KEY>; n searches, gap ms apart.
const { yahooSearch } = require('./_lib');

const QUERIES = ['Riteway Logistics owner', 'Phalanx Logistics Solutions CEO', 'White Star Logistics CEO', 'Unicron Logistics owner', 'Stream Logistics founder', 'Allstate Logistics president', 'Citation Logistics CEO', 'Premier Global Logistics CEO', 'DSG Logistics owner', 'GET Logistics CEO', 'Hurricane Logistics owner', 'Pleasant Prairie Logistics CEO', 'Ascent Warehouse Logistics CEO', 'Tolead CEO', '3PL Winner owner', 'ARC Air Logistics CEO'];

module.exports = async (req, res) => {
  const key = process.env.SEARXNG_KEY;
  if (!key || req.query.key !== key) { res.statusCode = 404; return res.end('Not found'); }
  const n = Math.min(16, Number(req.query.n) || 8);
  const gap = Math.min(20000, Number(req.query.gap) || 5000);
  const ip = await fetch('https://api.ipify.org').then((r) => r.text()).catch(() => null);
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    if (i) await new Promise((r) => setTimeout(r, gap));
    const y = await yahooSearch(QUERIES[i % QUERIES.length], 3).catch((e) => ({ error: e.message }));
    out.push(`${((Date.now() - t0) / 1000).toFixed(0)}s ${QUERIES[i % QUERIES.length]}: ${y.blocked ? 'BLOCKED' : y.error ? `error ${y.error}` : `${y.results.length} results · ${(y.results[0] || {}).title || ''}`}`);
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ip, gap, out }, null, 1));
};
