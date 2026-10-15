'use strict';
// Runs DocBatch on your computer: serves public/ and the api/*.js functions the way Vercel does.
// Usage: npm run dev   (reads .env.local, then .env; open http://localhost:3000)
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
for (const file of ['.env.local', '.env']) {
  if (!fs.existsSync(path.join(root, file))) continue;
  for (const line of fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const publicDir = path.join(root, 'public');

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (!api) {
    const file = path.join(publicDir, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    return res.end(fs.readFileSync(file));
  }
  const handler = path.join(root, 'api', api[1] + '.js');
  if (!fs.existsSync(handler)) { res.statusCode = 404; return res.end('Not found'); }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  req.query = Object.fromEntries(url.searchParams);
  try {
    req.body = /json/.test(req.headers['content-type'] || '') ? JSON.parse(raw.toString() || '{}') : raw.length ? raw : undefined;
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Bad JSON' }));
  }
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (j) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(j)); };
  await require(handler)(req, res);
}).listen(port, () => {
  const search = process.env.SEARXNG_URL ? `SearXNG at ${process.env.SEARXNG_URL}` : 'off (set SEARXNG_URL)';
  console.log(`DocBatch on http://localhost:${port}  (web search: ${search}; OpenAI key ${process.env.OPENAI_API_KEY ? 'set' : 'MISSING'})`);
});
