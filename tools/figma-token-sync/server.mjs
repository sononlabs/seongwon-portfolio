import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 7788);
const CSS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../css/style.css');
const NAME_RE = /^--[\w-]+$/;

function readRoot() {
  const css = fs.readFileSync(CSS, 'utf8');
  const m = css.match(/:root\s*\{([\s\S]*?)\}/);
  if (!m) throw new Error(':root 블록을 찾을 수 없습니다');
  const tokens = {};
  for (const [, name, value] of m[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[name] = value.trim();
  const bodyStart = m.index + m[0].length - 1 - m[1].length;
  return { css, body: m[1], bodyStart, tokens };
}

function writeTokens(updates) {
  const { css, body, bodyStart, tokens } = readRoot();
  let next = body;
  const changed = [];
  const rejected = [];
  for (const [name, raw] of Object.entries(updates)) {
    const value = String(raw).trim();
    if (!NAME_RE.test(name) || !(name in tokens) || !value || /[;{}]/.test(value)) { rejected.push(name); continue; }
    if (tokens[name] === value) continue;
    const re = new RegExp(`((?<![\\w-])${name.replace(/-/g, '\\-')}\\s*:\\s*)([^;]+)(;)`);
    next = next.replace(re, (_, a, _old, c) => a + value + c);
    changed.push({ name, from: tokens[name], to: value });
  }
  if (changed.length) fs.writeFileSync(CSS, css.slice(0, bodyStart) + next + css.slice(bodyStart + body.length));
  return { changed, rejected };
}

function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Private-Network': 'true',
    'Cache-Control': 'no-store',
  });
  res.end(data === undefined ? '' : JSON.stringify(data));
}

const log = (msg) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);

function handler(req, res) {
  // 피그마 플러그인 iframe은 Origin이 "null"이다. 일반 웹사이트가 이 서버로 style.css를 바꾸지 못하게 막는다.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return send(res, 403, { error: 'origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204);

  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/tokens') {
      return send(res, 200, { file: CSS, mtime: fs.statSync(CSS).mtimeMs, tokens: readRoot().tokens });
    }
    if (req.method === 'POST' && url.pathname === '/tokens') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
      req.on('end', () => {
        try {
          const result = writeTokens(JSON.parse(raw || '{}'));
          for (const c of result.changed) log(`피그마 → 코드  ${c.name}: ${c.from} → ${c.to}`);
          send(res, 200, result);
        } catch (e) { send(res, 400, { error: e.message }); }
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}

// 브라우저가 localhost를 ::1로 풀 수도 있어 IPv4·IPv6 루프백 둘 다 연다
for (const host of ['127.0.0.1', '::1']) {
  http.createServer(handler)
    .on('error', (e) => { if (host === '127.0.0.1') { console.error(e.message); process.exit(1); } })
    .listen(PORT, host, () => { if (host === '127.0.0.1') log(`토큰 동기화 서버 실행 중 — http://localhost:${PORT}  (${CSS})`); });
}
