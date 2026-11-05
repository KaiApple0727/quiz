// みんなのクイズ大会 — サーバー（追加ライブラリ不要。Node.js 18 以上で動きます）
// 正解はこのサーバーの中だけにあり、答え合わせの瞬間まで誰のブラウザにも送りません。
//
// しくみ
//   画面 → サーバー : POST /api/<操作>   （JSON）
//   サーバー → 画面 : GET  /events      （Server-Sent Events で状態を送り続ける）

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { GENRES, BANK } = require('./questions');

const PORT = process.env.PORT || 3000;
const COUNTS = [5, 10, 15];
const TIMES = [10, 15, 20, 30];
const MAX_PLAYERS = 50;
const HOST_HANDOVER_MS = 15000;      // ルーム主が切断したまま戻らないとき、次の人に交代するまでの時間
const ROOM_IDLE_MS = 15 * 60 * 1000; // 誰もいないルームを消すまでの時間
const GRACE_MS = 600;                // 通信の遅れを見込んだ受付の猶予
const PING_MS = 20000;               // 接続を保つための空送信
const MAX_BOTS = 7;

// NPC の強さ。accuracy = 正解する確率、speed = 制限時間のどのあたりで答えるか（0=すぐ、1=ぎりぎり）
const BOT_LEVELS = {
  easy:   { label: 'よわい', accuracy: 0.4,  speed: [0.45, 0.9] },
  normal: { label: 'ふつう', accuracy: 0.65, speed: [0.25, 0.7] },
  hard:   { label: 'つよい', accuracy: 0.9,  speed: [0.08, 0.4] },
};
const BOT_NAMES = ['ロボ太', 'ピコ', 'クイズ博士', 'ポン吉', 'ミケ', 'ガリ勉くん', 'ひらめき姫', 'うっかり侍', 'もぐら先生', 'チャチャ', 'ドット', 'ハカセ2号'];

const rooms = new Map();

/* ---------- helpers ---------- */
const rand = (n) => crypto.randomBytes(n).toString('hex');
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function pool(genre) {
  if (genre === 'mix') return GENRES.flatMap((g) => BANK[g.id] || []);
  return BANK[genre] || [];
}
function genreList() {
  return [
    ...GENRES.map((g) => ({ ...g, count: pool(g.id).length })),
    { id: 'mix', name: 'ミックス', note: '全ジャンルからランダム', count: pool('mix').length },
  ];
}
const genreName = (id) => (genreList().find((g) => g.id === id) || {}).name || '';
function newCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!rooms.has(code)) return code;
  }
  return String(Date.now()).slice(-6);
}
function cleanName(raw) {
  const s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 12);
  return s || null;
}
function uniqueName(room, name, selfId) {
  const taken = new Set([...room.players.values()].filter((p) => p.id !== selfId).map((p) => p.name));
  if (!taken.has(name)) return name;
  for (let n = 2; n < 100; n++) if (!taken.has(`${name}${n}`)) return `${name}${n}`;
  return name;
}
const isConnected = (p) => p.bot || p.streams.size > 0;
const connectedPlayers = (room) => [...room.players.values()].filter(isConnected);
const humans = (room) => [...room.players.values()].filter((p) => !p.bot);
const onlineHumans = (room) => humans(room).filter(isConnected);
function deleteRoom(room) {
  clearTimeout(room.timer);
  clearTimeout(room.handoverTimer);
  clearBotTimers(room);
  rooms.delete(room.code);
}

/* ---------- 各プレイヤーに送る状態 ---------- */
function viewFor(room, player) {
  const q = room.questions[room.qIndex];
  const v = {
    code: room.code,
    me: { id: player.id, name: player.name, isHost: room.hostId === player.id },
    phase: room.phase,
    settings: room.settings,
    genres: genreList(),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      gain: p.gain,
      connected: isConnected(p),
      isHost: room.hostId === p.id,
      bot: !!p.bot,
      level: p.bot ? BOT_LEVELS[p.level].label : undefined,
      answered: room.phase === 'question' ? room.answers.has(p.id) : false,
    })),
  };
  if ((room.phase === 'question' || room.phase === 'reveal') && q) {
    v.question = {
      index: room.qIndex,
      total: room.questions.length,
      genre: room.genreLabel,
      text: q.t,
      choices: q.c,
      time: room.settings.time,
      remainingMs: room.phase === 'question' ? Math.max(0, room.deadline - Date.now()) : 0,
    };
    const mine = room.answers.get(player.id);
    v.myAnswer = mine ? mine.c : null;
    v.answeredCount = room.answers.size;
    v.playerCount = connectedPlayers(room).length;
    // 正解は答え合わせのときだけ入れる
    if (room.phase === 'reveal') {
      const dist = [0, 0, 0, 0];
      for (const a of room.answers.values()) dist[a.c]++;
      v.reveal = { correct: q.a, dist, myCorrect: !!mine && mine.c === q.a, myGain: player.gain };
    }
  }
  return v;
}
function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.bot || !isConnected(p)) continue;
    const view = viewFor(room, p);
    for (const res of p.streams) send(res, 'state', view);
  }
}

/* ---------- 進行 ---------- */
function startGame(room) {
  const { genre, count } = room.settings;
  room.questions = shuffle(pool(genre)).slice(0, count).map((q) => {
    const order = shuffle([0, 1, 2, 3]);
    return { t: q.t, c: order.map((i) => q.c[i]), a: order.indexOf(0) };
  });
  room.genreLabel = genreName(genre);
  for (const p of room.players.values()) { p.score = 0; p.gain = 0; }
  showQuestion(room, 0);
}
function showQuestion(room, i) {
  clearTimeout(room.timer);
  room.phase = 'question';
  room.qIndex = i;
  room.answers = new Map();
  for (const p of room.players.values()) p.gain = 0;
  room.qStartedAt = Date.now();
  room.deadline = room.qStartedAt + room.settings.time * 1000;
  room.timer = setTimeout(() => reveal(room), room.settings.time * 1000 + GRACE_MS);
  scheduleBots(room);
  broadcast(room);
}

/* ---------- NPC ---------- */
function clearBotTimers(room) {
  for (const t of room.botTimers || []) clearTimeout(t);
  room.botTimers = [];
}
function scheduleBots(room) {
  clearBotTimers(room);
  const q = room.questions[room.qIndex];
  const limit = room.settings.time * 1000;
  for (const p of room.players.values()) {
    if (!p.bot) continue;
    const lv = BOT_LEVELS[p.level];
    const [lo, hi] = lv.speed;
    const delay = Math.round(limit * (lo + Math.random() * (hi - lo)));
    const right = Math.random() < lv.accuracy;
    const wrong = [0, 1, 2, 3].filter((i) => i !== q.a);
    const c = right ? q.a : wrong[crypto.randomInt(wrong.length)];
    room.botTimers.push(setTimeout(() => {
      if (room.phase !== 'question' || room.questions[room.qIndex] !== q || room.answers.has(p.id) || !room.players.has(p.id)) return;
      room.answers.set(p.id, { c, ms: Date.now() - room.qStartedAt });
      broadcast(room);
      maybeAutoReveal(room);
    }, delay));
  }
}
function addBot(room, level) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  const name = shuffle(BOT_NAMES).find((n) => !used.has(n)) || uniqueName(room, 'NPC');
  const p = { id: rand(6), token: null, bot: true, level, name, score: 0, gain: 0, joinedAt: Date.now(), streams: new Set() };
  room.players.set(p.id, p);
  return p;
}

function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimeout(room.timer);
  clearBotTimers(room);
  const q = room.questions[room.qIndex];
  const limit = room.settings.time * 1000;
  for (const [pid, a] of room.answers) {
    const p = room.players.get(pid);
    if (p && a.c === q.a) {
      const pts = Math.round(1000 - 500 * Math.min(1, a.ms / limit)); // 速いほど高得点（500〜1000点）
      p.score += pts;
      p.gain = pts;
    }
  }
  room.phase = 'reveal';
  broadcast(room);
}
function maybeAutoReveal(room) {
  if (room.phase !== 'question') return;
  const live = connectedPlayers(room);
  if (live.length && live.every((p) => room.answers.has(p.id))) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => reveal(room), 700);
  }
}
function scheduleHandover(room) {
  clearTimeout(room.handoverTimer);
  room.handoverTimer = setTimeout(() => {
    const host = room.players.get(room.hostId);
    if (host && isConnected(host)) return;
    const nextHost = onlineHumans(room).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (nextHost) { room.hostId = nextHost.id; broadcast(room); }
  }, HOST_HANDOVER_MS);
}

/* ---------- 操作 ---------- */
function addPlayer(room, name) {
  const p = { id: rand(6), token: rand(16), name: uniqueName(room, name), score: 0, gain: 0, joinedAt: Date.now(), streams: new Set() };
  room.players.set(p.id, p);
  return p;
}
function auth(body) {
  const room = rooms.get(String(body.code || ''));
  if (!room) return {};
  const me = body.token ? [...room.players.values()].find((p) => !p.bot && p.token === body.token) : null;
  return { room, me, isHost: !!me && room.hostId === me.id };
}

const actions = {
  create(body) {
    const name = cleanName(body.name);
    if (!name) return { ok: false, error: 'ニックネームを入れてください。' };
    const code = newCode();
    const room = {
      code, hostId: null, players: new Map(),
      settings: { genre: 'nazonazo', count: 10, time: 15 },
      phase: 'lobby', questions: [], qIndex: 0, answers: new Map(), lastActive: Date.now(),
    };
    rooms.set(code, room);
    const me = addPlayer(room, name);
    room.hostId = me.id;
    return { ok: true, code, token: me.token };
  },
  join(body) {
    const code = String(body.code || '').replace(/\D/g, '');
    const room = rooms.get(code);
    if (!room) return { ok: false, error: 'そのルームは見つかりません。番号を確かめてください。' };
    const known = body.token ? humans(room).find((p) => p.token === body.token) : null;
    if (known) return { ok: true, code, token: known.token };
    const name = cleanName(body.name);
    if (!name) return { ok: false, error: 'ニックネームを入れてください。' };
    if (humans(room).length >= MAX_PLAYERS) return { ok: false, error: 'このルームは満員です。' };
    const me = addPlayer(room, name);
    room.lastActive = Date.now();
    broadcast(room);
    return { ok: true, code, token: me.token };
  },
  leave(body) {
    const { room, me } = auth(body);
    if (!me) return { ok: true };
    for (const res of me.streams) res.end();
    room.players.delete(me.id);
    if (humans(room).length === 0) { deleteRoom(room); return { ok: true }; }
    if (room.hostId === me.id) {
      const nextHost = (onlineHumans(room)[0] || humans(room)[0]);
      room.hostId = nextHost.id;
    }
    maybeAutoReveal(room);
    broadcast(room);
    return { ok: true };
  },
  settings(body) {
    const { room, isHost } = auth(body);
    if (!isHost || (room.phase !== 'lobby' && room.phase !== 'final')) return { ok: false };
    const s = room.settings;
    if (genreList().some((g) => g.id === body.genre && g.count > 0)) s.genre = body.genre;
    if (COUNTS.includes(+body.count)) s.count = +body.count;
    if (TIMES.includes(+body.time)) s.time = +body.time;
    broadcast(room);
    return { ok: true };
  },
  addBot(body) {
    const { room, isHost } = auth(body);
    if (!isHost || (room.phase !== 'lobby' && room.phase !== 'final')) return { ok: false };
    if (!BOT_LEVELS[body.level]) return { ok: false };
    if (room.players.size - humans(room).length >= MAX_BOTS) return { ok: false, error: `NPCは${MAX_BOTS}人までです。` };
    addBot(room, body.level);
    broadcast(room);
    return { ok: true };
  },
  removeBot(body) {
    const { room, isHost } = auth(body);
    if (!isHost || (room.phase !== 'lobby' && room.phase !== 'final')) return { ok: false };
    const p = room.players.get(String(body.id || ''));
    if (!p || !p.bot) return { ok: false };
    room.players.delete(p.id);
    broadcast(room);
    return { ok: true };
  },
  start(body) {
    const { room, isHost } = auth(body);
    if (!isHost || (room.phase !== 'lobby' && room.phase !== 'final')) return { ok: false };
    if (!pool(room.settings.genre).length) return { ok: false, error: 'このジャンルには問題がありません。' };
    startGame(room);
    return { ok: true };
  },
  answer(body) {
    const { room, me } = auth(body);
    if (!me || room.phase !== 'question' || room.answers.has(me.id)) return { ok: false };
    const c = Number(body.c);
    if (![0, 1, 2, 3].includes(c)) return { ok: false };
    const ms = Date.now() - room.qStartedAt;
    if (ms > room.settings.time * 1000 + GRACE_MS) return { ok: false, error: '時間切れです。' };
    room.answers.set(me.id, { c, ms });
    broadcast(room);
    maybeAutoReveal(room);
    return { ok: true };
  },
  close(body) {
    const { room, isHost } = auth(body);
    if (isHost) reveal(room);
    return { ok: !!isHost };
  },
  next(body) {
    const { room, isHost } = auth(body);
    if (!isHost || room.phase !== 'reveal') return { ok: false };
    if (room.qIndex + 1 < room.questions.length) showQuestion(room, room.qIndex + 1);
    else { room.phase = 'final'; broadcast(room); }
    return { ok: true };
  },
  lobby(body) {
    const { room, isHost } = auth(body);
    if (!isHost) return { ok: false };
    clearTimeout(room.timer);
    clearBotTimers(room);
    room.phase = 'lobby';
    for (const p of room.players.values()) { p.score = 0; p.gain = 0; }
    broadcast(room);
    return { ok: true };
  },
};

/* ---------- HTTP ---------- */
const INDEX = path.join(__dirname, 'public', 'index.html');

function openStream(req, res, url) {
  const { room, me } = auth({ code: url.searchParams.get('code'), token: url.searchParams.get('token') });
  if (!me) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('gone'); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  me.streams.add(res);
  room.lastActive = Date.now();
  if (room.hostId === me.id) clearTimeout(room.handoverTimer);
  send(res, 'state', viewFor(room, me));
  broadcast(room);
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
  req.on('close', () => {
    clearInterval(ping);
    me.streams.delete(res);
    if (!rooms.has(room.code) || isConnected(me)) return;
    room.lastActive = Date.now();
    if (room.hostId === me.id) scheduleHandover(room);
    maybeAutoReveal(room);
    broadcast(room);
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    fs.readFile(INDEX, (err, buf) => {
      if (err) { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') return openStream(req, res, url);
  if (req.method === 'GET' && url.pathname === '/healthz') { res.end('ok'); return; }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const fn = actions[url.pathname.slice(5)];
    const body = await readJson(req);
    const out = fn ? fn(body) : { ok: false };
    res.writeHead(fn ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(out));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// 誰もいなくなったルームを片づける
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (onlineHumans(room).length === 0 && now - room.lastActive > ROOM_IDLE_MS) deleteRoom(room);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => console.log(`クイズ大会サーバー起動: http://localhost:${PORT}`));
