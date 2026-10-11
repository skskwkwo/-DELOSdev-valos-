#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DELOS — Ollama Real-time AI Console (Python server)
====================================================
Zero-dependency Python server (standard library only, Python 3.8+).

  - Serves the static front-end from ./public
  - Proxies Ollama /api/chat with true token streaming (NDJSON -> SSE)
  - Real-time DuckDuckGo web research stream (SSE progress + sources)
  - Crash-resistant: every request is isolated, upstream failures fall
    back to a demo stream instead of killing the server.

Run:
  python server.py
"""

import json
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- constants

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "3789"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

DDG_HTML = "https://html.duckduckgo.com/html/"
DDG_LITE = "https://lite.duckduckgo.com/lite/"
DDG_API = "https://api.duckduckgo.com/"
WIKI_API = "https://en.wikipedia.org/w/api.php"

REQUEST_TIMEOUT = 120
UPSTREAM_TIMEOUT = 10
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
}

# ---------------------------------------------------------------- utilities


class ClientClosed(Exception):
    """Raised when the browser disconnects mid-stream."""


def strip_tags(html):
    """Remove HTML tags/entities and collapse whitespace."""
    if not html:
        return ""
    text = re.sub(r"<script[\s\S]*?</script>", "", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", "", text, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    entities = {
        "&nbsp;": " ", "&": "&", "<": "<", ">": ">",
        "&" + "quot;": '"', "&#x27;": "'", "&#39;": "'",
    }
    for ent, ch in entities.items():
        text = text.replace(ent, ch)
    return re.sub(r"\s+", " ", text).strip()


def domain_of(url):
    try:
        return urllib.parse.urlparse(url).hostname or ""
    except Exception:
        return ""


def decode_ddg_href(href):
    """Resolve DuckDuckGo redirect links (//duckduckgo.com/l/?uddg=...) ."""
    if not href:
        return ""
    h = href.strip()
    try:
        if h.startswith("//"):
            h = "https:" + h
        parsed = urllib.parse.urlparse(h)
        if "duckduckgo.com" in (parsed.hostname or "") and parsed.path.startswith("/l/"):
            target = urllib.parse.parse_qs(parsed.query).get("uddg", [""])[0]
            if target:
                return urllib.parse.unquote(target)
        return h
    except Exception:
        return href


def http_request(url, method="GET", data=None, headers=None, timeout=UPSTREAM_TIMEOUT):
    """Robust HTTP request. Returns (status, text) or raises."""
    req = urllib.request.Request(url, method=method)
    base_headers = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        base_headers.update(headers)
    for key, value in base_headers.items():
        req.add_header(key, value)
    if data is not None:
        payload = urllib.parse.urlencode(data).encode("utf-8")
        req.add_header("Content-Type", "application/x-www-form-urlencoded")
        req.data = payload
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.getcode(), resp.read().decode("utf-8", errors="replace")


def http_json(url, payload, timeout=REQUEST_TIMEOUT):
    """POST JSON, return raw bytes of the (streaming) response body."""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("User-Agent", "DELOS/1.0")
    return urllib.request.urlopen(req, timeout=timeout)


# ------------------------------------------------------------ DDG research


def parse_ddg_html(html):
    """Parser for html.duckduckgo.com results."""
    results, seen = [], set()
    link_re = re.compile(
        r'<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)</a>',
        re.I)
    snippet_re = re.compile(
        r'<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)</a>', re.I)
    snippets = [strip_tags(m.group(1)) for m in snippet_re.finditer(html)]
    for i, m in enumerate(link_re.finditer(html)):
        url = decode_ddg_href(m.group(1))
        title = strip_tags(m.group(2))
        if not title or not url:
            continue
        key = url + "|" + title
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "title": title,
            "url": url,
            "snippet": snippets[i] if i < len(snippets) else "",
            "domain": domain_of(url),
        })
        if len(results) >= 12:
            break
    return results


def parse_ddg_lite(html):
    """Parser for lite.duckduckgo.com results."""
    results, seen = [], set()
    link_re = re.compile(
        r"<a[^>]*class=['\"]result-link['\"][^>]*href=['\"]([^'\"]+)['\"][^>]*>"
        r"([\s\S]*?)</a>", re.I)
    snippet_re = re.compile(
        r"class=['\"]result-snippet['\"][^>]*>([\s\S]*?)</td>", re.I)
    snippets = [strip_tags(m.group(1)) for m in snippet_re.finditer(html)]
    for i, m in enumerate(link_re.finditer(html)):
        url = decode_ddg_href(m.group(1))
        title = strip_tags(m.group(2))
        if not title or not url:
            continue
        key = url + "|" + title
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "title": title,
            "url": url,
            "snippet": snippets[i] if i < len(snippets) else "",
            "domain": domain_of(url),
        })
        if len(results) >= 12:
            break
    return results


def looks_like_bot_challenge(html):
    return ("anomaly" in html.lower() or "challenge" in html.lower()) \
        and "result-link" not in html and "result__a" not in html


def fetch_ddg(base, method, query):
    params = {"q": query, "kl": "wt-wt"}
    url = base if method == "POST" else base + "?" + urllib.parse.urlencode(params)
    status, html = http_request(
        url, method=method,
        data=params if method == "POST" else None,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": base,
        })
    if status != 200:
        raise RuntimeError("status %s" % status)
    if looks_like_bot_challenge(html):
        raise RuntimeError("bot-challenge")
    return html


def ddg_search(query):
    """Try every DuckDuckGo surface until one returns parseable results."""
    attempts = [
        (DDG_HTML, "POST", parse_ddg_html),
        (DDG_HTML, "GET", parse_ddg_html),
        (DDG_LITE, "POST", parse_ddg_lite),
        (DDG_LITE, "GET", parse_ddg_lite),
    ]
    for base, method, parser in attempts:
        try:
            html = fetch_ddg(base, method, query)
            results = parser(html)
            if results:
                return results
        except Exception:
            continue
    return []


def ddg_instant_answer(query):
    """DuckDuckGo Instant Answer API (official, bot-friendly)."""
    try:
        params = {
            "q": query, "format": "json", "no_html": "1",
            "skip_disambig": "1", "no_redirect": "1",
        }
        status, text = http_request(
            DDG_API + "?" + urllib.parse.urlencode(params),
            headers={"User-Agent": "DELOS/1.0"})
        if status != 200:
            return None
        data = json.loads(text)
        out = {"abstract": "", "heading": "", "source": "", "related": []}
        if data.get("AbstractText"):
            out["abstract"] = data["AbstractText"]
            out["heading"] = data.get("Heading", "")
            out["source"] = data.get("AbstractSource", "")
        elif data.get("Answer"):
            out["abstract"] = data["Answer"]
        elif data.get("Definition"):
            out["abstract"] = data["Definition"]
        for topic in (data.get("RelatedTopics") or []):
            if len(out["related"]) >= 6:
                break
            if isinstance(topic, dict) and topic.get("Text"):
                out["related"].append({
                    "text": topic["Text"],
                    "url": topic.get("FirstURL", ""),
                })
            elif isinstance(topic, dict):
                for sub in topic.get("Topics", []):
                    if isinstance(sub, dict) and sub.get("Text"):
                        out["related"].append({
                            "text": sub["Text"],
                            "url": sub.get("FirstURL", ""),
                        })
        return out
    except Exception:
        return None


def wiki_search(query):
    """Reliable fallback: Wikipedia search API."""
    try:
        params = {
            "action": "query", "format": "json", "list": "search",
            "srlimit": "6", "srsearch": query,
        }
        status, text = http_request(
            WIKI_API + "?" + urllib.parse.urlencode(params),
            headers={"User-Agent": "DELOS/1.0 (research)"})
        if status != 200:
            return []
        data = json.loads(text)
        hits = (data.get("query") or {}).get("search") or []
        results = []
        for hit in hits:
            title = strip_tags(hit.get("title", ""))
            if not title:
                continue
            results.append({
                "title": title,
                "url": "https://en.wikipedia.org/wiki/"
                       + urllib.parse.quote(title.replace(" ", "_")),
                "snippet": strip_tags(hit.get("snippet", "")),
                "domain": "en.wikipedia.org",
            })
        return results
    except Exception:
        return []


def build_research_context(query, instant, results):
    lines = [
        "WEB RESEARCH CONTEXT",
        "Query: " + query,
        "Generated: " + time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "",
    ]
    if instant and instant.get("abstract"):
        src = instant.get("source") or ""
        lines.append("DUCKDUCKGO INSTANT ANSWER"
                     + (" (%s)" % src if src else "") + ":")
        lines.append(instant["abstract"])
        lines.append("")
    if results:
        lines.append("TOP SOURCES:")
        for i, r in enumerate(results, 1):
            lines.append("[%d] %s" % (i, r["title"]))
            lines.append("    URL: " + r["url"])
            if r.get("snippet"):
                lines.append("    Excerpt: " + r["snippet"])
            lines.append("")
    lines.append("Use the sources above. Cite them as [1], [2] ... when relevant. "
                 "If the sources are insufficient, say so honestly.")
    return "\n".join(lines)


# --------------------------------------------------------------- SSE helper


class SseStream:
    """Wraps the response writer with crash-safe SSE sending."""

    def __init__(self, handler):
        self.handler = handler
        self.closed = False
        try:
            handler.close_connection = True  # SSE: end body at connection close
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
            handler.send_header("Cache-Control", "no-cache, no-transform")
            handler.send_header("Connection", "close")
            handler.send_header("X-Accel-Buffering", "no")
            handler.send_header("Access-Control-Allow-Origin", "*")
            handler.end_headers()
        except (ConnectionAbortedError, BrokenPipeError, OSError):
            self.closed = True

    def send(self, event, data):
        if self.closed:
            raise ClientClosed()
        try:
            payload = "event: %s\ndata: %s\n\n" % (event, json.dumps(data, ensure_ascii=False))
            self.handler.wfile.write(payload.encode("utf-8"))
            self.handler.wfile.flush()
        except (ConnectionAbortedError, BrokenPipeError, OSError):
            self.closed = True
            raise ClientClosed()

    def safe_send(self, event, data):
        try:
            self.send(event, data)
            return True
        except ClientClosed:
            return False


def check_client(handler):
    """Raise ClientClosed if the socket is gone."""
    try:
        if handler.wfile.closed:
            raise ClientClosed()
    except (ConnectionAbortedError, BrokenPipeError, OSError):
        raise ClientClosed()


# ------------------------------------------------------------- API handlers


def handle_health(handler):
    ollama_online = False
    try:
        req = urllib.request.Request(OLLAMA_URL + "/api/tags")
        req.add_header("User-Agent", "DELOS/1.0")
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            ollama_online = resp.getcode() == 200
    except Exception:
        ollama_online = False
    body = json.dumps({
        "ok": True,
        "service": "DELOS",
        "version": "1.0.0",
        "ollamaUrl": OLLAMA_URL,
        "ollama": {"online": ollama_online},
    }).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_models(handler):
    models = []
    try:
        req = urllib.request.Request(OLLAMA_URL + "/api/tags")
        req.add_header("User-Agent", "DELOS/1.0")
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        for m in (data.get("models") or []):
            details = m.get("details") or {}
            models.append({
                "name": m.get("name", ""),
                "size": m.get("size", 0),
                "family": details.get("family", ""),
                "parameters": details.get("parameter_size", ""),
                "quantization": details.get("quantization_level", ""),
                "modified": m.get("modified_at", ""),
            })
    except Exception:
        models = []
    body = json.dumps({"models": models}).encode("utf-8")
    handler.send_response(200)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_research(handler, payload):
    query = str(payload.get("query", "")).strip()
    try:
        depth = max(1, min(int(payload.get("depth", 8)), 12))
    except (TypeError, ValueError):
        depth = 8

    sse = SseStream(handler)
    if not query:
        sse.safe_send("error", {"message": "Empty query"})
        return

    try:
        sse.send("step", {"label": "Initializing research core",
                          "detail": "authorizing DuckDuckGo endpoint", "pct": 5})
        time.sleep(0.12)

        sse.send("step", {"label": "Querying Instant Answer API",
                          "detail": query, "pct": 15})
        instant = ddg_instant_answer(query)
        if instant and instant.get("abstract"):
            sse.send("answer", instant)
            sse.send("step", {"label": "Instant answer acquired",
                              "detail": instant.get("source") or "DuckDuckGo", "pct": 30})
        else:
            sse.send("step", {"label": "No instant answer",
                              "detail": "falling back to deep HTML crawl", "pct": 30})

        sse.send("step", {"label": "Crawling DuckDuckGo index",
                          "detail": "html + lite endpoints", "pct": 45})
        results = []
        try:
            results = ddg_search(query)
        except Exception as err:
            sse.send("step", {"label": "DuckDuckGo crawl failed",
                              "detail": str(err), "pct": 55})

        if not results:
            sse.send("step", {"label": "DuckDuckGo rate-limited",
                              "detail": "switching to Wikipedia fallback", "pct": 58})
            results = wiki_search(query)
            if results:
                sse.send("step", {"label": "Fallback sources acquired",
                                  "detail": "en.wikipedia.org", "pct": 62})

        limited = results[:depth]
        sse.send("step", {"label": "Results retrieved",
                          "detail": "%d sources found" % len(limited), "pct": 65})

        for i, r in enumerate(limited, 1):
            time.sleep(0.07)
            sse.send("source", {
                "index": i, "total": len(limited),
                "title": r["title"], "url": r["url"],
                "snippet": r.get("snippet", ""), "domain": r.get("domain", ""),
            })
            sse.send("step", {
                "label": "Analyzing source %d" % i,
                "detail": r.get("domain", ""),
                "pct": 65 + round(i / max(len(limited), 1) * 30),
            })

        context = build_research_context(query, instant, limited)
        sse.send("step", {"label": "Research synthesized",
                          "detail": "context window compiled", "pct": 100})
        sse.send("done", {"query": query, "context": context,
                          "count": len(limited), "instant": instant})
    except ClientClosed:
        pass
    except Exception as err:
        sse.safe_send("error", {"message": str(err)})


def demo_stream(sse, messages, model):
    """Synthetic stream used when Ollama is unreachable — keeps UI alive."""
    last_user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = str(m.get("content", ""))[:180]
            break
    text = "\n".join([
        "> Demo stream active — no local Ollama instance detected.",
        "",
        "I can see your message: **%s**" % (last_user or "(empty)"),
        "",
        "To enable real inference:",
        "",
        "```bash",
        "ollama serve",
        "ollama pull %s" % model,
        "```",
        "",
        "Once Ollama is online, DELOS will stream live tokens with real-time "
        "DuckDuckGo research injected into the context window.",
    ])
    tokens = re.findall(r"\S+\s*|\s+", text)
    for token in tokens:
        if not sse.safe_send("token", {"content": token}):
            return
        time.sleep(0.014)
    sse.safe_send("done", {"model": "demo", "content": text, "demo": True})


def handle_chat(handler, payload):
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        body = json.dumps({"error": "No messages provided"}).encode("utf-8")
        handler.send_response(400)
        handler.send_header("Content-Type", "application/json; charset=utf-8")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)
        return

    model = payload.get("model") or "llama3.2"
    options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
    temperature = payload.get("temperature", 0.7)
    options.setdefault("temperature", temperature)
    options.setdefault("num_ctx", 8192)

    body = {"model": model, "messages": messages, "stream": True, "options": options}
    sse = SseStream(handler)
    full = ""

    try:
        try:
            upstream = http_json(OLLAMA_URL + "/api/chat", body, timeout=REQUEST_TIMEOUT)
        except Exception:
            demo_stream(sse, messages, model)
            return

        sse.send("open", {"model": model, "time": int(time.time() * 1000)})
        buffer = b""
        while True:
            chunk = upstream.read(8192)
            if not chunk:
                break
            buffer += chunk
            while b"\n" in buffer:
                line_bytes, buffer = buffer.split(b"\n", 1)
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if obj.get("error"):
                    sse.send("error", {"message": obj["error"]})
                    continue
                message = obj.get("message") or {}
                piece = message.get("content", "")
                if piece:
                    full += piece
                    sse.send("token", {"content": piece})
                if message.get("thinking"):
                    sse.send("thinking", {"content": message["thinking"]})
                if obj.get("done"):
                    sse.send("done", {
                        "model": obj.get("model", model),
                        "total_duration": obj.get("total_duration", 0),
                        "eval_count": obj.get("eval_count", 0),
                        "prompt_eval_count": obj.get("prompt_eval_count", 0),
                        "content": full,
                    })
        sse.send("end", {"content": full})
    except ClientClosed:
        pass
    except Exception as err:
        # Ollama error mid-stream -> graceful demo fallback
        sse.safe_send("token", {
            "content": "\n\n> ⚠ Ollama error: %s — switching to demo stream.\n\n" % str(err)
        })
        demo_stream(sse, messages, model)


# ------------------------------------------------------------ static server


def handle_static(handler, raw_path):
    url_path = urllib.parse.unquote(urllib.parse.urlparse(raw_path).path)
    if url_path in ("", "/"):
        url_path = "/index.html"
    safe = os.path.normpath(url_path).lstrip("\\/").replace("..\\", "").replace("../", "")
    file_path = os.path.join(PUBLIC_DIR, safe)
    if not os.path.abspath(file_path).startswith(os.path.abspath(PUBLIC_DIR)):
        handler.send_error(403)
        return

    if not os.path.isfile(file_path):
        file_path = os.path.join(PUBLIC_DIR, "index.html")

    ext = os.path.splitext(file_path)[1].lower()
    ctype = MIME.get(ext, "application/octet-stream")
    try:
        with open(file_path, "rb") as f:
            content = f.read()
    except OSError:
        handler.send_error(404)
        return

    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(content)))
    handler.send_header("Cache-Control",
                        "no-store" if ext == ".html" else "public, max-age=3600")
    handler.end_headers()
    handler.wfile.write(content)


# ------------------------------------------------------------------ handler


class DelosHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "DELOS/1.0"

    # -- silence default stderr logging to avoid BrokenPipe crashes ----------
    def log_message(self, fmt, *args):
        try:
            sys.stderr.write("[delos] %s - %s\n" % (self.address_string(), fmt % args))
        except Exception:
            pass

    # -- helpers -------------------------------------------------------------
    def _read_json(self, limit=4 * 1024 * 1024):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > limit:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return {}

    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (ConnectionAbortedError, BrokenPipeError, OSError):
            pass

    def _options(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- routing -------------------------------------------------------------
    def do_OPTIONS(self):
        try:
            self._options()
        except Exception:
            pass

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def _route(self, method):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/health" and method == "GET":
                handle_health(self)
            elif path == "/api/models" and method == "GET":
                handle_models(self)
            elif path == "/api/research" and method == "POST":
                handle_research(self, self._read_json(256 * 1024))
            elif path == "/api/chat" and method == "POST":
                handle_chat(self, self._read_json())
            elif path.startswith("/api/"):
                self._send_json(404, {"error": "Unknown endpoint"})
            else:
                handle_static(self, self.path)
        except (ConnectionAbortedError, BrokenPipeError, OSError):
            pass  # browser disconnected — ignore
        except ClientClosed:
            pass
        except Exception as err:
            # last-resort guard: never let one request crash the server
            try:
                self._send_json(500, {"error": str(err)})
            except Exception:
                pass


# --------------------------------------------------------------------- main


def get_lan_addresses():
    addresses = set()
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None)
        for info in infos:
            ip = info[4][0]
            if ip and not ip.startswith(("127.", "::", "fe80")) and ":" not in ip:
                addresses.add(ip)
    except Exception:
        pass
    return sorted(addresses)


def main():
    try:
        server = ThreadingHTTPServer((HOST, PORT), DelosHandler)
    except OSError as err:
        print("ERROR: cannot bind %s:%d (%s)" % (HOST, PORT, err), file=sys.stderr)
        sys.exit(1)

    server.daemon_threads = True

    line = "=" * 62
    print(line)
    print("  DELOS  ::  Ollama Real-time AI Console  (Python)")
    print(line)

    display_host = "127.0.0.1" if HOST == "0.0.0.0" else HOST
    print("  Local:       http://%s:%d" % (display_host, PORT))
    for ip in get_lan_addresses():
        print("  Network:     http://%s:%d" % (ip, PORT))
    print("  Ollama:      %s" % OLLAMA_URL)
    print("  Streaming:   /api/chat        Research: /api/research")
    print("  Static root: %s" % PUBLIC_DIR)
    print(line)
    print("  Press Ctrl+C to stop.")

    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nShutting down DELOS...")
    finally:
        try:
            server.server_close()
        except Exception:
            pass


if __name__ == "__main__":
    main()
