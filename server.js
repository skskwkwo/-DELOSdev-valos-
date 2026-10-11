'use strict';

/*
 * DELOS — Ollama Real-time AI Console
 * Zero-dependency Node.js server.
 *
 *  - Proxies Ollama /api/chat with true token streaming (NDJSON -> SSE)
 *  - Real-time DuckDuckGo web research stream (SSE progress + sources)
 *  - Serves the static front-end from ./public
 *
 * Requires Node 18+ (uses global fetch / web streams).
 * Run:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '3789', 10);
const HOST = process.env.HOST || '127.0.0.1';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DDG_HTML = 'https://html.duckduckgo.com/html/';
const DDG_API = 'https://api.duckduckgo.com/';
const REQUEST_TIMEOUT = 120000;

/* ----------------------------------------------------------------------- */
/* Small utilities                                                          */
/* ----------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseSend(res, event, data) {
  if (res.writableEnded) return;
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* ----------------------------------------------------------------------- */
/* DuckDuckGo research                                                      */
/* ----------------------------------------------------------------------- */

function decodeDdgHref(href) {
  if (!href) return '';
  let h = href.trim();
  try {
    if (h.startsWith('//')) h = 'https:' + h;
    const u = new URL(h);
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname.startsWith('/l/')) {
      const target = u.searchParams.get('uddg');
      if (target) return decodeURIComponent(target);
    }
    return h;
  } catch (e) {
    return href;
  }
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (e) {
    return '';
  }
}

function parseDdgHtml(html) {
  const results = [];
  const seen = new Set();
  const blockRe = /<div[^>]*class="[^"]*result[^"]*"?[^>]*>[\s\S]*?(?=<div[^>]*class="[^"]*result|<div[^>]*class="nav-link|$)/gi;
  let match;
  const blocks = [];
  while ((match = blockRe.exec(html)) !== null) {
    blocks.push(match[0]);
    if (blocks.length > 60) break;
  }

  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeDdgHref(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    const snippetMatch = block.match(/<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i) ||
      block.match(/<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = snippetMatch ? stripTags(snippetMatch[1]) : '';
    if (!title || !url) continue;
    const key = url + '|' + title;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title, url, snippet, domain: domainOf(url) });
    if (results.length >= 12) break;
  }

  if (results.length === 0) {
    const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const url = decodeDdgHref(m[1]);
      const title = stripTags(m[2]);
      if (!title || !url) continue;
      const key = url + '|' + title;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ title, url, snippet: '', domain: domainOf(url) });
      if (results.length >= 12) break;
    }
  }
  return results;
}

const DDG_LITE = 'https://lite.duckduckgo.com/lite/';
const DDG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function ddgHeaders(form) {
  const h = {
    'User-Agent': DDG_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1'
  };
  if (form) h['Content-Type'] = 'application/x-www-form-urlencoded';
  return h;
}

/* DuckDuckGo Lite uses class='result-link' for anchors and result-snippet cells. */
function parseDdgLite(html) {
  const results = [];
  const seen = new Set();
  const linkRe = /<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snips = [];
  const snipRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  let sm;
  while ((sm = snipRe.exec(html)) !== null) snips.push(stripTags(sm[1]));

  let m;
  let i = 0;
  while ((m = linkRe.exec(html)) !== null) {
    const url = decodeDdgHref(m[1]);
    const title = stripTags(m[2]);
    if (!title || !url) continue;
    const key = url + '|' + title;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title, url, snippet: snips[i] || '', domain: domainOf(url) });
    i++;
    if (results.length >= 12) break;
  }
  return results;
}

async function fetchDdg(url, method, query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const params = new URLSearchParams({ q: query, kl: 'wt-wt' });
    const isPost = method === 'POST';
    const target = isPost ? url : url + '?' + params.toString();
    const resp = await fetch(target, {
      method,
      headers: ddgHeaders(isPost),
      body: isPost ? params.toString() : undefined,
      redirect: 'follow',
      signal: controller.signal
    });
    if (resp.status !== 200) throw new Error('status ' + resp.status);
    const html = await resp.text();
    if (/anomaly|challenge|unusual traffic/i.test(html) && html.length < 20000 &&
        !html.includes('result-link') && !html.includes('result__a')) {
      throw new Error('bot-challenge');
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

/* Try every DuckDuckGo surface until one returns parseable results. */
async function ddgSearch(query) {
  const attempts = [
    { url: DDG_HTML, method: 'POST', parse: parseDdgHtml },
    { url: DDG_HTML, method: 'GET', parse: parseDdgHtml },
    { url: DDG_LITE, method: 'POST', parse: parseDdgLite },
    { url: DDG_LITE, method: 'GET', parse: parseDdgLite }
  ];
  for (const a of attempts) {
    try {
      const html = await fetchDdg(a.url, a.method, query);
      const results = a.parse(html);
      if (results.length) return results;
    } catch (e) {
      /* try next surface */
    }
  }
  return [];
}

/* Reliable secondary source: Wikipedia search + summaries. */
async function wikiSearch(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const api = 'https://en.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=6&srsearch=' +
      encodeURIComponent(query);
    const resp = await fetch(api, { headers: { 'User-Agent': 'DELOS/1.0 (research)' }, signal: controller.signal });
    if (!resp.ok) return [];
    const data = await resp.json();
    const hits = data && data.query && data.query.search ? data.query.search : [];
    const out = [];
    for (const hit of hits) {
      out.push({
        title: stripTags(hit.title),
        url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(hit.title.replace(/ /g, '_')),
        snippet: stripTags(hit.snippet || ''),
        domain: 'en.wikipedia.org'
      });
    }
    return out;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function ddgInstantAnswer(query) {
  const url = DDG_API + '?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1&no_redirect=1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'DELOS/1.0' },
      signal: controller.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const out = { abstract: '', heading: '', source: '', related: [] };
    if (data.AbstractText) {
      out.abstract = data.AbstractText;
      out.heading = data.Heading || '';
      out.source = data.AbstractSource || '';
    }
    if (data.Answer) out.abstract = data.Answer;
    if (data.Definition) out.abstract = data.Definition;
    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics) {
        if (topic && topic.Text) {
          out.related.push({ text: topic.Text, url: topic.FirstURL || '' });
        } else if (topic && Array.isArray(topic.Topics)) {
          for (const sub of topic.Topics) {
            if (sub && sub.Text) out.related.push({ text: sub.Text, url: sub.FirstURL || '' });
          }
        }
        if (out.related.length >= 6) break;
      }
    }
    return out;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function streamResearch(req, res, payload) {
  const query = String(payload.query || '').trim();
  const depth = Math.min(Math.max(parseInt(payload.depth || '8', 10) || 8, 1), 12);
  openSse(res);

  if (!query) {
    sseSend(res, 'error', { message: 'Empty query' });
    res.end();
    return;
  }

  const send = (event, data) => sseSend(res, event, data);
  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    send('step', { label: 'Initializing research core', detail: 'authorizing DuckDuckGo endpoint', pct: 5 });
    await sleep(120);

    send('step', { label: 'Querying Instant Answer API', detail: query, pct: 15 });
    const instant = await ddgInstantAnswer(query);
    if (closed) return;
    if (instant && instant.abstract) {
      send('answer', instant);
      send('step', { label: 'Instant answer acquired', detail: instant.source || 'DuckDuckGo', pct: 30 });
    } else {
      send('step', { label: 'No instant answer', detail: 'falling back to deep HTML crawl', pct: 30 });
    }

    send('step', { label: 'Crawling DuckDuckGo index', detail: 'html + lite endpoints', pct: 45 });
    let results = [];
    try {
      results = await ddgSearch(query);
    } catch (err) {
      send('step', { label: 'DuckDuckGo crawl failed', detail: String(err.message || err), pct: 55 });
    }
    if (closed) return;

    if (!results.length) {
      send('step', { label: 'DuckDuckGo rate-limited', detail: 'switching to Wikipedia fallback', pct: 58 });
      try {
        results = await wikiSearch(query);
        if (results.length) {
          send('step', { label: 'Fallback sources acquired', detail: 'en.wikipedia.org', pct: 62 });
        }
      } catch (err) {
        send('step', { label: 'Fallback failed', detail: String(err.message || err), pct: 62 });
      }
    }
    if (closed) return;

    const limited = results.slice(0, depth);
    send('step', { label: 'Results retrieved', detail: limited.length + ' sources found', pct: 65 });

    for (let i = 0; i < limited.length; i++) {
      const r = limited[i];
      await sleep(70);
      if (closed) return;
      send('source', {
        index: i + 1,
        total: limited.length,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        domain: r.domain
      });
      send('step', {
        label: 'Analyzing source ' + (i + 1),
        detail: r.domain,
        pct: 65 + Math.round(((i + 1) / Math.max(limited.length, 1)) * 30)
      });
    }

    const context = buildResearchContext(query, instant, limited);
    send('step', { label: 'Research synthesized', detail: 'context window compiled', pct: 100 });
    send('done', { query, context, count: limited.length, instant: instant || null });
  } catch (err) {
    send('error', { message: String(err && err.message ? err.message : err) });
  } finally {
    if (!res.writableEnded) res.end();
  }
}

function buildResearchContext(query, instant, results) {
  const lines = [];
  lines.push('WEB RESEARCH CONTEXT');
  lines.push('Query: ' + query);
  lines.push('Generated: ' + new Date().toISOString());
  lines.push('');
  if (instant && instant.abstract) {
    lines.push('DUCKDUCKGO INSTANT ANSWER' + (instant.source ? ' (' + instant.source + ')' : '') + ':');
    lines.push(instant.abstract);
    lines.push('');
  }
  if (results.length) {
    lines.push('TOP SOURCES:');
    results.forEach((r, i) => {
      lines.push('[' + (i + 1) + '] ' + r.title);
      lines.push('    URL: ' + r.url);
      if (r.snippet) lines.push('    Excerpt: ' + r.snippet);
      lines.push('');
    });
  }
  lines.push('Use the sources above. Cite them as [1], [2] ... when relevant. If the sources are insufficient, say so honestly.');
  return lines.join('\n');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------------------------------------------------- */
/* Ollama chat streaming                                                    */
/* ----------------------------------------------------------------------- */

async function streamChat(req, res, payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const model = payload.model || 'llama3.2';
  const options = Object.assign({
    temperature: typeof payload.temperature === 'number' ? payload.temperature : 0.7,
    num_ctx: 8192
  }, payload.options || {});

  if (!messages.length) {
    sendJson(res, 400, { error: 'No messages provided' });
    return;
  }

  const body = {
    model,
    messages,
    stream: true,
    options
  };

  openSse(res);
  const send = (event, data) => sseSend(res, event, data);
  let closed = false;
  req.on('close', () => { closed = true; });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  req.on('close', () => controller.abort());

  try {
    const upstream = await fetch(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      throw new Error('Ollama ' + upstream.status + ' ' + text.slice(0, 300));
    }

    send('open', { model, time: Date.now() });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (obj.error) {
          send('error', { message: obj.error });
          continue;
        }
        const piece = obj.message && obj.message.content ? obj.message.content : '';
        if (piece) {
          full += piece;
          send('token', { content: piece });
        }
        if (obj.message && obj.message.thinking) {
          send('thinking', { content: obj.message.thinking });
        }
        if (obj.done) {
          send('done', {
            model: obj.model,
            total_duration: obj.total_duration,
            eval_count: obj.eval_count,
            prompt_eval_count: obj.prompt_eval_count,
            content: full
          });
        }
        if (closed) break;
      }
    }
    if (!closed && !res.writableEnded) {
      send('end', { content: full });
    }
  } catch (err) {
    if (!closed && !res.writableEnded) {
      const message = String(err && err.message ? err.message : err);
      if (/fetch failed|ECONNREFUSED|aborted/i.test(message)) {
        await demoStream(req, res, send, messages, model);
      } else {
        send('error', { message });
      }
    }
  } finally {
    clearTimeout(timer);
    if (!res.writableEnded) res.end();
  }
}

/*
 * Demo fallback: when Ollama is not reachable, stream a synthetic answer so
 * the interface remains fully demonstrable.
 */
async function demoStream(req, res, send, messages, model) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const q = last ? String(last.content || '') : '';
  const text = [
    '> Demo stream active — no local Ollama instance detected at the configured endpoint.',
    '',
    'I can see your message: **' + (q.slice(0, 180) || '(empty)') + '**',
    '',
    'To enable real model inference, start Ollama and pull a model:',
    '',
    '```bash',
    'ollama serve',
    'ollama pull ' + model,
    '```',
    '',
    'Once Ollama is online, refresh this console and DELOS will stream live tokens directly from `' + model + '`, with real-time DuckDuckGo research injected into the context window.'
  ].join('\n');

  const tokens = text.match(/\s+|\S+/g) || [text];
  for (const t of tokens) {
    if (res.writableEnded) return;
    send('token', { content: t });
    await sleep(14);
  }
  send('done', { model: 'demo', content: text, demo: true });
}

/* ----------------------------------------------------------------------- */
/* Static file serving                                                      */
/* ----------------------------------------------------------------------- */

function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      const fallback = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fallback, (e, buf) => {
        if (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ----------------------------------------------------------------------- */
/* Router                                                                   */
/* ----------------------------------------------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (url === '/api/health') {
    let ollama = { online: false };
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 2500);
      const r = await fetch(OLLAMA_URL + '/api/tags', { signal: controller.signal });
      clearTimeout(t);
      ollama.online = r.ok;
    } catch (e) {
      ollama.online = false;
    }
    sendJson(res, 200, {
      ok: true,
      service: 'DELOS',
      version: '1.0.0',
      ollamaUrl: OLLAMA_URL,
      ollama
    });
    return;
  }

  if (url === '/api/models' && req.method === 'GET') {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      const r = await fetch(OLLAMA_URL + '/api/tags', { signal: controller.signal });
      clearTimeout(t);
      const data = await r.json();
      const models = (data.models || []).map((m) => ({
        name: m.name,
        size: m.size,
        family: m.details && m.details.family,
        parameters: m.details && m.details.parameter_size,
        quantization: m.details && m.details.quantization_level,
        modified: m.modified_at
      }));
      sendJson(res, 200, { models });
    } catch (e) {
      sendJson(res, 200, { models: [], error: String(e.message || e) });
    }
    return;
  }

  if (url === '/api/research' && req.method === 'POST') {
    let payload;
    try {
      payload = await readBody(req, 1024 * 256);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    await streamResearch(req, res, payload);
    return;
  }

  if (url === '/api/chat' && req.method === 'POST') {
    let payload;
    try {
      payload = await readBody(req, 1024 * 1024 * 4);
    } catch (e) {
      sendJson(res, 400, { error: e.message });
      return;
    }
    await streamChat(req, res, payload);
    return;
  }

  if (url.startsWith('/api/')) {
    sendJson(res, 404, { error: 'Unknown endpoint' });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const line = '='.repeat(58);
  console.log(line);
  console.log('  DELOS  ::  Ollama Real-time AI Console');
  console.log(line);
  console.log('  Local:     http://' + HOST + ':' + PORT);
  console.log('  Ollama:    ' + OLLAMA_URL);
  console.log('  Streaming: /api/chat   Research: /api/research');
  console.log(line);
});

process.on('SIGINT', () => {
  console.log('\nShutting down DELOS...');
  server.close(() => process.exit(0));
});
