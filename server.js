#!/usr/bin/env node
/**
 * MC Bot Summoner  —  Node.js edition
 * ====================================
 * Summon any number of FAKE Minecraft players (offline-mode / "cracked" bots)
 * to a target server, from a friendly web UI.
 *
 * Inspired by the mindcraft project (https://github.com/mindcraft-bots/mindcraft)
 * which uses the `mineflayer` Node.js library. Unlike a Python wrapper, this
 * Node port runs every bot IN-PROCESS — no subprocess per bot — so it's far
 * more memory-efficient (a few MB per connection vs ~40MB per child process)
 * and can scale to very large flocks.
 *
 * RUN:
 *     node server.js
 *
 * On first run it auto-installs its own npm deps (express + mineflayer) if
 * missing, then starts an HTTP server on http://0.0.0.0:3000.
 *
 * REQUIREMENTS:
 *   - Node.js 16+  (must be installed already)
 *
 * The target server MUST run in offline mode (server.properties:
 * `online-mode=false`) for offline players to join.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ---------------------------------------------------------------------------
// Bootstrap: auto-install npm dependencies if missing (one-time).
// ---------------------------------------------------------------------------
(function ensureDeps() {
  const missing = [];
  try { require.resolve('express'); } catch { missing.push('express'); }
  try { require.resolve('mineflayer'); } catch { missing.push('mineflayer'); }
  if (missing.length === 0) return;
  console.log('[setup] Missing dependencies: ' + missing.join(', '));
  console.log('[setup] Running npm install (one-time, ~20s) ...');
  try {
    execSync('npm install --no-audit --no-fund --loglevel=error', {
      stdio: 'inherit',
      cwd: __dirname,
    });
    console.log('[setup] Dependencies installed.');
  } catch (e) {
    console.error('[setup] FATAL: npm install failed: ' + e.message);
    console.error('[setup] Try running  npm install  manually in ' + __dirname);
    process.exit(1);
  }
})();

const express = require('express');
const mineflayer = require('mineflayer');

// ---------------------------------------------------------------------------
// Config & state
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const SPAWN_DELAY_MS = 350;          // delay between spawning consecutive bots
const LOG_BUFFER_MAX = 400;          // recent log entries kept in memory
const RECONNECT_DELAY_MS = 6000;     // delay before reconnecting a dropped bot
const COUNT_MAX = 100000;            // sanity cap (each bot ~few MB RAM, in-process)

const bots = new Map();               // id -> BotSession
const logBuffer = [];                 // ring buffer of log entries
const subscribers = new Set();        // SSE response objects

let spawnQueue = [];
let spawning = false;

// ---------------------------------------------------------------------------
// Logging + SSE fan-out
// ---------------------------------------------------------------------------
function pushLog(botId, name, message, kind = 'log') {
  const entry = { bot_id: botId, name, message, kind, time: Date.now() };
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  const data = JSON.stringify(entry);
  for (const res of subscribers) {
    try { res.write('data: ' + data + '\n\n'); } catch (_) { /* dead socket */ }
  }
}

// ---------------------------------------------------------------------------
// Name generation (mirrors the Python version)
// ---------------------------------------------------------------------------
const NAME_ADJ = ['Cool', 'Fast', 'Brave', 'Sly', 'Mega', 'Super', 'Dark', 'Epic',
  'Lucky', 'Quick', 'Iron', 'Gold', 'Red', 'Cyber', 'Neon', 'Hyper',
  'Silent', 'Wild', 'Mighty', 'Proto'];
const NAME_NOUN = ['Steve', 'Alex', 'Creeper', 'Zombie', 'Miner', 'Builder', 'Knight',
  'Wizard', 'Ninja', 'Pirate', 'Hunter', 'Wolf', 'Tiger', 'Dragon',
  'Phoenix', 'Gamer', 'Pro', 'Noob', 'King', 'Queen'];

function sanitizeName(name) {
  let n = String(name).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 16);
  if (n.length < 3) n = (n + 'Bot').slice(0, 16);
  return n;
}

function generateNames(mode, prefix, count, existing) {
  const used = new Set(existing);
  const out = [];
  const base = sanitizeName(prefix || 'Bot');

  function take(n) {
    n = sanitizeName(n);
    let i = 1;
    while (used.has(n)) {
      const suffix = '_' + i;
      n = (base.slice(0, 16 - suffix.length) + suffix);
      i++;
    }
    used.add(n);
    return n;
  }

  if (mode === 'steve') {
    for (let i = 0; i < count; i++) {
      out.push(take('Steve' + (i > 0 ? String(i + 1) : '')));
    }
  } else if (mode === 'random') {
    for (let i = 0; i < count; i++) {
      const n = (NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)] +
                 NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)] +
                 Math.floor(Math.random() * 99 + 1));
      out.push(take(n.slice(0, 16)));
    }
  } else { // prefix
    for (let i = 1; i <= count; i++) {
      const s = String(i);
      const b = base.slice(0, 16 - s.length - 1);
      out.push(take(b + '_' + s));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bot behaviors
// ---------------------------------------------------------------------------
function startBehavior(session) {
  if (session.behaviorTimer) { clearInterval(session.behaviorTimer); session.behaviorTimer = null; }
  const b = session.bot;
  if (!b) return;
  const cfg = session.behavior;

  try {
    switch (cfg) {
      case 'idle':
        session.behaviorTimer = setInterval(() => {
          try { b.look(Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.6); } catch (_) {}
        }, 4000 + Math.random() * 4000);
        break;
      case 'wander':
        session.behaviorTimer = setInterval(() => {
          try {
            const r = Math.random();
            if (r < 0.25) {
              b.setControlState('jump', true);
              setTimeout(() => { try { b.setControlState('jump', false); } catch (_) {} }, 400);
            } else {
              b.look(Math.random() * Math.PI * 2, 0);
              b.setControlState('forward', true);
              setTimeout(() => { try { b.setControlState('forward', false); } catch (_) {} }, 1000 + Math.random() * 2500);
            }
          } catch (_) {}
        }, 2400);
        break;
      case 'jump':
        session.behaviorTimer = setInterval(() => {
          try { b.setControlState('jump', true); setTimeout(() => { try { b.setControlState('jump', false); } catch (_) {} }, 300); } catch (_) {}
        }, 1400 + Math.random() * 1400);
        break;
      case 'spin': {
        let yaw = 0;
        session.behaviorTimer = setInterval(() => {
          try { yaw += 0.45; b.look(yaw % (Math.PI * 2), 0); } catch (_) {}
        }, 90);
        break;
      }
      case 'sneak':
        session.behaviorTimer = setInterval(() => {
          try { b.setControlState('sneak', Math.random() > 0.5); } catch (_) {}
        }, 3000);
        break;
      case 'follow':
        session.behaviorTimer = setInterval(() => {
          try {
            const players = Object.values(b.players || {})
              .filter(p => p && p.entity && p.username !== b.username);
            if (players.length) {
              const target = players[0].entity.position;
              b.lookAt(target.offset(0, 1.6, 0));
              const dist = b.entity.position.distanceTo(target);
              b.setControlState('forward', dist > 2.5);
              b.setControlState('sprint', dist > 8);
            } else {
              b.setControlState('forward', false);
              b.setControlState('sprint', false);
            }
          } catch (_) {}
        }, 500);
        break;
      case 'chat': {
        const msgs = ['hi', 'lol', 'gg', 'anyone here?', 'nice', 'brb', 'hello!', 'wow', 'cool', 'yo'];
        session.behaviorTimer = setInterval(() => {
          try { b.chat(msgs[Math.floor(Math.random() * msgs.length)]); } catch (_) {}
        }, 9000 + Math.random() * 7000);
        break;
      }
      case 'punch':
        session.behaviorTimer = setInterval(() => {
          try {
            const target = b.nearestEntity(e => e && e.position && e.position.distanceTo(b.entity.position) < 4);
            if (target) {
              b.lookAt(target.position.offset(0, 1, 0));
              b.attack(target);
            }
          } catch (_) {}
        }, 2000);
        break;
      default:
        session.behaviorTimer = setInterval(() => {
          try { b.look(Math.random() * Math.PI * 2, 0); } catch (_) {}
        }, 5000);
    }
  } catch (e) {
    pushLog(session.id, session.name, 'behavior error: ' + (e && e.message), 'error');
  }
}

function clearBehavior(session) {
  if (session.behaviorTimer) { clearInterval(session.behaviorTimer); session.behaviorTimer = null; }
}

// ---------------------------------------------------------------------------
// Bot session lifecycle
// ---------------------------------------------------------------------------
function makeSession(config) {
  return {
    id: config.id,
    name: config.name,
    host: config.host,
    port: config.port,
    version: config.version,
    behavior: config.behavior,
    reconnect: config.reconnect,
    status: 'connecting',
    startedAt: Date.now(),
    health: null,
    bot: null,
    behaviorTimer: null,
    reconnectTimer: null,
    stopped: false,
  };
}

function launchBot(session) {
  const opts = {
    username: session.name,
    host: session.host,
    port: session.port,
    auth: 'offline',
    hideErrors: false,
  };
  if (session.version && session.version !== 'auto') opts.version = session.version;

  session.status = 'connecting';
  session.ended = false;
  pushLog(session.id, session.name,
    'Connecting to ' + session.host + ':' + session.port + ' as "' + session.name + '"' +
    (session.version && session.version !== 'auto' ? ' (v' + session.version + ')' : ' (auto version)'),
    'log');

  let bot;
  try {
    bot = mineflayer.createBot(opts);
  } catch (e) {
    session.status = 'error';
    pushLog(session.id, session.name, 'createBot error: ' + (e && e.message), 'error');
    return;
  }
  session.bot = bot;

  bot.on('spawn', () => {
    session.status = 'online';
    try {
      const p = bot.entity.position;
      pushLog(session.id, session.name,
        'Spawned at ' + p.x.toFixed(1) + ', ' + p.y.toFixed(1) + ', ' + p.z.toFixed(1) +
        ' (health ' + (bot.health != null ? bot.health.toFixed(0) : '?') + ')', 'log');
    } catch (_) {
      pushLog(session.id, session.name, 'Spawned.', 'log');
    }
    startBehavior(session);
  });

  bot.on('health', () => {
    try { session.health = bot.health; } catch (_) {}
  });

  bot.on('chat', (username, message) => {
    if (username === session.name) return;
    pushLog(session.id, session.name, '[chat] ' + username + ': ' + message, 'log');
  });

  bot.on('kicked', (reason) => {
    let r = reason;
    try { if (typeof reason === 'object') r = JSON.stringify(reason); } catch (_) {}
    pushLog(session.id, session.name, 'Kicked: ' + r, 'log');
    if (!session.stopped && !session.ended) session.status = 'offline';
  });

  bot.on('error', (err) => {
    pushLog(session.id, session.name, 'Error: ' + (err && err.message ? err.message : err), 'error');
    if (!session.stopped && !session.ended) session.status = 'error';
  });

  bot.on('end', () => {
    session.ended = true;
    clearBehavior(session);
    if (!session.stopped) {
      session.status = session.reconnect ? 'reconnecting' : 'offline';
    }
    pushLog(session.id, session.name, 'Disconnected.', 'log');
    if (!session.stopped && session.reconnect && bots.has(session.id)) {
      pushLog(session.id, session.name, 'Reconnecting in 6s ...', 'log');
      session.reconnectTimer = setTimeout(() => {
        if (session.stopped || !bots.has(session.id)) return;
        launchBot(session);
      }, RECONNECT_DELAY_MS);
    }
  });
}

function stopBot(id) {
  const session = bots.get(id);
  if (!session) return false;
  session.stopped = true;
  if (session.reconnectTimer) { clearTimeout(session.reconnectTimer); session.reconnectTimer = null; }
  clearBehavior(session);
  session.status = 'stopped';
  if (session.bot) {
    try { session.bot.quit('Bye'); } catch (_) {}
  }
  pushLog(id, session.name, 'Stopped by user.', 'system');
  return true;
}

// ---------------------------------------------------------------------------
// Spawn queue (sequential to avoid connection flooding)
// ---------------------------------------------------------------------------
function enqueueSpawn(config) {
  bots.set(config.id, makeSession(config));
  spawnQueue.push(config);
  processQueue();
}

async function processQueue() {
  if (spawning) return;
  spawning = true;
  while (spawnQueue.length) {
    const job = spawnQueue.shift();
    const session = bots.get(job.id);
    if (session && !session.stopped) {
      try { launchBot(session); } catch (e) {
        pushLog(job.id, job.name, 'launch error: ' + (e && e.message), 'error');
      }
    }
    await new Promise(r => setTimeout(r, SPAWN_DELAY_MS));
  }
  spawning = false;
}

// ---------------------------------------------------------------------------
// Public bot view (for the API)
// ---------------------------------------------------------------------------
function publicBot(s) {
  return {
    id: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    version: s.version,
    behavior: s.behavior,
    reconnect: s.reconnect,
    status: s.status,
    started_at: Math.floor(s.startedAt / 1000),
    pid: process.pid, // single process — same pid for all bots
    health: s.health,
  };
}

function getCounts() {
  const c = { total: bots.size, online: 0, connecting: 0, reconnecting: 0, queued: 0, offline: 0, error: 0, stopped: 0 };
  for (const s of bots.values()) {
    if (c[s.status] !== undefined) c[s.status]++;
    else c.offline++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Serve the UI
const HTML_PATH = path.join(__dirname, 'index.html');
app.get('/', (req, res) => {
  res.type('html');
  fs.createReadStream(HTML_PATH).pipe(res);
});

app.get('/api/state', (req, res) => {
  res.json({
    ready: true,
    install_error: null,
    node: process.execPath,
    node_version: process.version,
    spawn_queue: spawnQueue.length,
    counts: getCounts(),
    bots: Array.from(bots.values()).map(publicBot),
  });
});

app.post('/api/spawn', (req, res) => {
  const data = req.body || {};
  const host = String(data.host || '').trim();
  if (!host) return res.status(400).json({ error: 'Server host/IP is required.' });

  let port;
  try { port = parseInt(data.port || 25565, 10); }
  catch { return res.status(400).json({ error: 'Port must be a number.' }); }
  if (!(port >= 1 && port <= 65535)) return res.status(400).json({ error: 'Port must be between 1 and 65535.' });

  const version = String(data.version || 'auto').trim();
  const behavior = String(data.behavior || 'idle').trim();
  const reconnect = data.reconnect !== undefined ? !!data.reconnect : true;
  const nameMode = String(data.name_mode || 'prefix').trim();
  const prefix = String(data.prefix || 'Bot').trim();

  let count;
  try { count = parseInt(data.count || 1, 10); }
  catch { return res.status(400).json({ error: 'Count must be a number.' }); }
  if (count < 1) return res.status(400).json({ error: 'Count must be at least 1.' });
  if (count > COUNT_MAX) return res.status(400).json({ error: 'Count capped at ' + COUNT_MAX + ' for sanity. Each bot is ~few MB RAM (in-process).' });

  const existing = Array.from(bots.values()).map(b => b.name);
  const names = generateNames(nameMode, prefix, count, existing);

  const created = names.map(nm => {
    const id = crypto.randomBytes(5).toString('hex');
    enqueueSpawn({
      id, name: nm, host, port, version, behavior, reconnect,
    });
    return { id, name: nm };
  });

  pushLog(null, 'system',
    'Queued ' + names.length + ' bot(s) -> ' + host + ':' + port + ' (' + behavior + ')', 'system');

  res.json({ queued: names.length, bots: created });
});

app.post('/api/stop/:id', (req, res) => {
  const ok = stopBot(req.params.id);
  res.json({ ok });
});

app.post('/api/stop_all', (req, res) => {
  let n = 0;
  for (const [id, s] of bots.entries()) {
    if (s.status !== 'stopped' && s.status !== 'offline' && s.status !== 'error') {
      // also stop reconnecting bots (clear their pending reconnect timer)
      if (stopBot(id)) n++;
    }
  }
  pushLog(null, 'system', 'Stopping ' + n + ' active bot(s) ...', 'system');
  res.json({ stopping: n });
});

app.post('/api/clear', (req, res) => {
  let removed = 0;
  for (const [id, s] of bots.entries()) {
    if (s.status === 'stopped' || s.status === 'offline' || s.status === 'error' || s.status === 'reconnecting') {
      // clean up any lingering timers
      if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
      bots.delete(id);
      removed++;
    }
  }
  res.json({ removed });
});

// Server-Sent Events log stream
app.get('/api/logs', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  for (const entry of logBuffer) {
    res.write('data: ' + JSON.stringify(entry) + '\n\n');
  }
  subscribers.add(res);

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (_) {}
  }, 20000);

  req.on('close', () => {
    clearInterval(keepalive);
    subscribers.delete(res);
  });
});

app.get('/api/version_info', (req, res) => {
  res.json({
    versions: [
      ['auto', 'Auto-detect (ping server)'],
      ['1.21.4', '1.21.4'], ['1.21.1', '1.21.1'], ['1.20.6', '1.20.6'],
      ['1.20.4', '1.20.4'], ['1.20.1', '1.20.1'], ['1.19.4', '1.19.4'],
      ['1.19.2', '1.19.2'], ['1.18.2', '1.18.2'], ['1.17.1', '1.17.1'],
      ['1.16.5', '1.16.5'], ['1.12.2', '1.12.2'], ['1.8.9', '1.8.9'],
    ],
    behaviors: [
      ['idle', 'Idle (look around)'], ['wander', 'Wander (walk randomly)'],
      ['jump', 'Jump repeatedly'], ['spin', 'Spin in place'],
      ['sneak', 'Toggle sneak'], ['follow', 'Follow nearest player'],
      ['chat', 'Chat random messages'], ['punch', 'Punch nearby entities'],
    ],
  });
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(sig) {
  console.log('\n[shutdown] received ' + sig + ', stopping ' + bots.size + ' bot(s) ...');
  for (const id of bots.keys()) {
    stopBot(id);
  }
  // give bots a moment to quit cleanly
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('============================================================');
  console.log('  MC Bot Summoner (Node.js)  -  offline-mode fake players');
  console.log('  Inspired by mindcraft (github.com/mindcraft-bots/mindcraft)');
  console.log('  In-process Mineflayer bots  -  no subprocess per bot');
  console.log('============================================================');
  console.log('[server] Node ' + process.version + ' | express + mineflayer ready');
  console.log('[server] Listening on http://0.0.0.0:' + PORT);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[server] FATAL: port ' + PORT + ' is already in use.');
    console.error('[server] Stop the other process, or set PORT=xxxx env var.');
  } else {
    console.error('[server] listen error:', err);
  }
  process.exit(1);
});
