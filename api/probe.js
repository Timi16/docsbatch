'use strict';
// Temporary: checks whether search engines answer from Vercel's servers. Needs ?key=<SEARXNG_KEY>.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ENGINES = {
  brave: (q) => ({ url: `https://search.brave.com/search?q=${encodeURIComponent(q)}`, titles: /<div class="title[^"]*"[^>]*>([^<]{5,120})/g }),
  bing: (q) => ({ url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US&cc=US`, titles: /<h2[^>]*><a[^>]*>([^<]{5,120})/g }),
  ddg: (q) => ({ url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, titles: /class="result__a"[^>]*>([^<]{5,120})/g }),
  yahoo: (q) => ({ url: `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`, titles: /<h3[^>]*>(?:<[^>]+>)*([^<]{5,120})/g }),
};

module.exports = async (req, res) => {
  const key = process.env.SEARXNG_KEY;
  if (!key || req.query.key !== key) { res.statusCode = 404; return res.end('Not found'); }
  const q = String(req.query.q || 'Phalanx Logistics Solutions CEO').slice(0, 200);
  const out = { region: process.env.VERCEL_REGION || null };
  await Promise.all(Object.entries(ENGINES).map(async ([name, make]) => {
    const { url, titles } = make(q);
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(12000) });
      const html = await r.text();
      out[name] = { status: r.status, bytes: html.length, blocked: /captcha|anomaly|unusual traffic/i.test(html), titles: [...html.matchAll(titles)].map((m) => m[1].trim()).slice(0, 5) };
    } catch (e) {
      out[name] = { error: e.message };
    }
  }));
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(out, null, 1));
};
