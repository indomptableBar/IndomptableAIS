#!/usr/bin/env node
/* ============================================================================
 *  Vigie AIS — relais local (Node.js ≥ 22, aucune dépendance)
 *
 *  - sert le tableau de bord :            http://localhost:8787/
 *  - pont WebSocket → WebSocket :         ws://localhost:8787/ws?target=wss://stream.aisstream.io/v0/stream
 *  - pont TCP NMEA → WebSocket :          ws://localhost:8787/tcp?host=153.44.253.27&port=5631
 *  - écoute UDP NMEA → WebSocket :        ws://localhost:8787/udp?port=10110
 *  - proxy HTTP avec en-têtes CORS :      http://localhost:8787/proxy?url=https://data.aishub.net/…
 *    (GET, et POST pour l’API GraphQL de Spire Maritime — satellite)
 *
 *  - récepteur SDR (SDRplay RSP1…) :      ws://localhost:8787/sdr?lnastate=3&grdb=32 → lance AIS-catcher
 *
 *  Usage : node ais-relay.mjs [--port 8787] [--host 127.0.0.1] [--allow-origin https://exemple.fr]
 *                             [--ais-catcher /chemin/vers/AIS-catcher]
 * ==========================================================================*/
import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

const VERSION = '1.3.0';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const PORT = +opt('port', 8787);
const HOST = opt('host', '127.0.0.1');
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(DIR, 'vigie-ais.html');
const AISCATCHER = opt('ais-catcher', process.env.AIS_CATCHER || 'AIS-catcher'); // chemin de l’exécutable AIS-catcher

// Hôtes autorisés (le relais ne doit pas devenir un proxy ouvert)
const WS_TARGETS = ['stream.aisstream.io'];
const HTTP_TARGETS = ['data.aishub.net', 'api.vesselfinder.com', 'services.marinetraffic.com', 'meri.digitraffic.fi', 'api.spire.com', 'api.sml.kpler.com', 'api.aiscatcher.org'];
// Origines autorisées : page locale (file:// → « null ») et le relais lui-même
const ORIGINS = new Set(['null', `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, ...(opt('allow-origin', '') ? [opt('allow-origin')] : [])]);
const originOk = (o) => !o || ORIGINS.has(o);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- Serveur WebSocket minimal (RFC 6455) ---------------------------- */
function wsAccept(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return null; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const ws = { socket, open: true, onText: null, onClose: null };
  ws.send = (data, opcode = 1) => {
    if (!ws.open) return;
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | opcode; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
    socket.write(Buffer.concat([head, payload]));
  };
  ws.close = () => { if (!ws.open) return; ws.open = false; try { socket.write(Buffer.from([0x88, 0])); socket.end(); } catch { } ws.onClose && ws.onClose(); };
  let buf = Buffer.alloc(0), frag = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mOff = off; if (masked) off += 4;
      if (buf.length < off + len) return;
      let p = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(mOff, mOff + 4); p = Buffer.from(p.map((b, i) => b ^ m[i & 3])); }
      buf = buf.subarray(off + len);
      if (op === 8) { ws.close(); return; }
      if (op === 9) { ws.send(p, 10); continue; }
      if (op === 10) continue;
      frag.push(p);
      if (fin) { const msg = Buffer.concat(frag); frag = []; ws.onText && ws.onText(msg.toString('utf8')); }
    }
  });
  socket.on('close', () => { if (ws.open) { ws.open = false; ws.onClose && ws.onClose(); } });
  socket.on('error', () => { });
  return ws;
}

/* ---------- Ponts ---------------------------------------------------------- */
function bridgeWs(client, target) {
  if (typeof WebSocket === 'undefined') { client.send(JSON.stringify({ error: 'Node.js ≥ 22 requis (WebSocket global)' })); client.close(); return; }
  log('WS  →', target);
  const up = new WebSocket(target);
  const queue = [];
  up.onopen = () => { for (const m of queue) up.send(m); queue.length = 0; };
  up.onmessage = async (e) => client.send(typeof e.data === 'string' ? e.data : Buffer.from(typeof e.data.arrayBuffer === 'function' ? await e.data.arrayBuffer() : e.data));
  up.onerror = (e) => { client.send(JSON.stringify({ error: 'Amont : ' + (e.message || 'erreur WebSocket') })); };
  up.onclose = (e) => { log('WS  ×', target, e.code, e.reason || ''); client.close(); };
  client.onText = (t) => (up.readyState === 1 ? up.send(t) : queue.push(t));
  client.onClose = () => { try { up.close(); } catch { } };
}
function bridgeTcp(client, host, port, login) {
  log('TCP →', host + ':' + port);
  const s = net.connect({ host, port }, () => { log('TCP ✓', host + ':' + port); if (login) s.write(login + '\r\n'); });
  s.setEncoding('latin1');
  let rest = '';
  s.on('data', (d) => {
    const lines = (rest + d).split(/\r?\n/); rest = lines.pop();
    if (lines.length) client.send(lines.join('\n') + '\n');
  });
  s.on('error', (e) => { log('TCP ×', e.message); client.close(); });
  s.on('close', () => client.close());
  client.onClose = () => s.destroy();
}
function bridgeUdp(client, port) {
  log('UDP ← écoute sur le port', port);
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (m) => client.send(m.toString('latin1')));
  sock.on('error', (e) => { log('UDP ×', e.message); client.close(); });
  sock.bind(port);
  client.onClose = () => { try { sock.close(); } catch { } };
}

/* ---------- Récepteur SDR via AIS-catcher ------------------------------------ */
let sdrProc = null;
function sdrArgs(q) {
  const num = (k, lo, hi, d) => { const v = q.get(k); if (v == null || v === '') return d; const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error('Paramètre ' + k + ' invalide'); return Math.round(n); };
  const a = [];
  const serial = q.get('serial');
  if (serial) { if (!/^[A-Za-z0-9]{1,32}$/.test(serial)) throw new Error('Numéro de série invalide'); a.push('-d', serial); }
  else a.push('-d:' + num('device', 0, 16, 0));
  const ppm = num('ppm', -150, 150, 0); if (ppm) a.push('-p', String(ppm));
  const gs = ['lnastate', String(num('lnastate', 0, 9, 3)), 'grdb', String(num('grdb', 0, 59, 32)), 'agc', q.get('agc') === 'on' ? 'on' : 'off'];
  const ant = q.get('antenna'); if (ant === 'A' || ant === 'B') gs.push('antenna', ant);
  a.push('-gs', ...gs);
  const share = q.get('share'); // partage vers la carte communautaire aiscatcher.org
  if (share) { if (!/^[A-Za-z0-9_-]{6,128}$/.test(share)) throw new Error('Clé de partage invalide'); a.push('-X', share); }
  a.push('-n'); // NMEA brut sur la sortie standard
  return a;
}
function bridgeSdr(client, q) {
  let args;
  try { args = sdrArgs(q); } catch (e) { client.send(JSON.stringify({ sdr: 'error', text: e.message })); client.close(); return; }
  if (sdrProc) { log('SDR × arrêt de l’instance précédente'); try { sdrProc.kill(); } catch { } }
  log('SDR →', AISCATCHER, args.join(' ').replace(/-X \S+/, '-X ••••••'));
  client.send(JSON.stringify({ sdr: 'cmd', text: AISCATCHER + ' ' + args.join(' ').replace(/-X \S+/, '-X ••••••') }));
  let p;
  try { p = spawn(AISCATCHER, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { client.send(JSON.stringify({ sdr: 'error', text: e.message })); client.close(); return; }
  sdrProc = p;
  let rest = '';
  p.stdout.setEncoding('latin1');
  p.stdout.on('data', (d) => {
    const lines = (rest + d).split(/\r?\n/); rest = lines.pop();
    const nmea = lines.filter((l) => /[!$]..VD[MO]/.test(l));
    if (nmea.length) client.send(nmea.join('\n') + '\n');
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', (d) => { for (const l of String(d).split(/\r?\n/)) if (l.trim()) client.send(JSON.stringify({ sdr: 'log', text: l.trim().slice(0, 300) })); });
  p.on('error', (e) => { client.send(JSON.stringify({ sdr: 'error', text: e.code === 'ENOENT' ? 'AIS-catcher introuvable : installez-le ou lancez le relais avec --ais-catcher /chemin/vers/AIS-catcher' : e.message })); client.close(); });
  p.on('exit', (code) => { log('SDR × AIS-catcher terminé (code ' + code + ')'); if (sdrProc === p) sdrProc = null; client.send(JSON.stringify({ sdr: 'exit', text: 'AIS-catcher s’est arrêté (code ' + code + ')' })); client.close(); });
  client.onClose = () => { try { p.kill(); } catch { } };
}
process.on('exit', () => { try { sdrProc && sdrProc.kill(); } catch { } });
process.on('SIGINT', () => process.exit(0));

/* ---------- HTTP ------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  const cors = originOk(origin) ? { 'Access-Control-Allow-Origin': origin || '*', Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' }); return res.end(); }
  if (u.pathname === '/' || u.pathname === '/index.html' || u.pathname === '/vigie-ais.html') {
    if (!fs.existsSync(PAGE)) { res.writeHead(404); return res.end('vigie-ais.html introuvable à côté du relais'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(PAGE).pipe(res);
  }
  if (u.pathname === '/sdr/list') {
    if (!originOk(origin)) { res.writeHead(403); return res.end(); }
    execFile(AISCATCHER, ['-l'], { timeout: 15000 }, (err, out, errOut) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify({ ok: !err || !!out, text: String(out || '') + String(errOut || ''), error: err && err.code === 'ENOENT' ? 'AIS-catcher introuvable sur cet ordinateur' : null }));
    });
    return;
  }
  if (u.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); return res.end(JSON.stringify({ ok: true, version: VERSION, node: process.version, aisCatcher: AISCATCHER })); }
  if (u.pathname === '/proxy') {
    if (!originOk(origin)) { res.writeHead(403); return res.end('Origine refusée'); }
    let target;
    try { target = new URL(u.searchParams.get('url')); } catch { res.writeHead(400, cors); return res.end('URL invalide'); }
    if (target.protocol !== 'https:' || !HTTP_TARGETS.includes(target.hostname)) { res.writeHead(403, cors); return res.end('Hôte non autorisé : ' + target.hostname); }
    try {
      log(req.method + ' →', target.hostname + target.pathname);
      const headers = { 'User-Agent': 'VigieAIS-relay/' + VERSION, 'Digitraffic-User': 'VigieAIS/' + VERSION, 'Accept-Encoding': 'gzip' };
      let body;
      if (req.method === 'POST') { // GraphQL (Spire) : corps et jeton transmis tels quels
        const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks);
        if (body.length > 64 * 1024) { res.writeHead(413, cors); return res.end('Requête trop volumineuse'); }
        headers['Content-Type'] = req.headers['content-type'] || 'application/json';
      }
      if (req.headers.authorization) headers.Authorization = req.headers.authorization; // jeton Bearer (Spire, AIS-catcher)
      const r = await fetch(target, { method: req.method === 'POST' ? 'POST' : 'GET', headers, body });
      const out = Buffer.from(await r.arrayBuffer());
      const pass = {};
      for (const h of ['x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after']) if (r.headers.get(h)) pass[h] = r.headers.get(h);
      res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json', ...pass, 'Access-Control-Expose-Headers': 'X-RateLimit-Remaining, X-RateLimit-Limit, Retry-After', ...cors });
      return res.end(out);
    } catch (e) { res.writeHead(502, cors); return res.end(JSON.stringify({ error: e.message })); }
  }
  res.writeHead(404); res.end('Introuvable');
});

server.on('upgrade', (req, socket) => {
  const u = new URL(req.url, 'http://x');
  if (!originOk(req.headers.origin)) { log('Refusé (origine)', req.headers.origin); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const ws = wsAccept(req, socket); if (!ws) return;
  try {
    if (u.pathname === '/ws') {
      const t = new URL(u.searchParams.get('target'));
      if (t.protocol !== 'wss:' || !WS_TARGETS.includes(t.hostname)) throw new Error('Cible non autorisée : ' + t.hostname);
      bridgeWs(ws, t.href);
    } else if (u.pathname === '/tcp') {
      const host = u.searchParams.get('host'), port = +u.searchParams.get('port');
      if (!host || !port) throw new Error('Paramètres host et port requis');
      const login = (u.searchParams.get('login') || '').slice(0, 512).replace(/[\r\n]/g, '');
      bridgeTcp(ws, host, port, login);
    } else if (u.pathname === '/sdr') {
      bridgeSdr(ws, u.searchParams);
    } else if (u.pathname === '/udp') {
      const port = +u.searchParams.get('port') || 10110;
      bridgeUdp(ws, port);
    } else throw new Error('Chemin inconnu');
  } catch (e) { ws.send(JSON.stringify({ error: e.message })); ws.close(); }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Vigie AIS — relais v${VERSION}\n  Tableau de bord : http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/\n  Ctrl+C pour arrêter.\n`);
  if (typeof WebSocket === 'undefined') console.log('  ⚠ Node.js < 22 : le pont AISStream (WebSocket) est indisponible, le reste fonctionne.\n');
});
