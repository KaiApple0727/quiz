// みんなのクイズ大会 — サーバー（追加ライブラリ不要。Node.js 18 以上で動きます）
// 正解はこのサーバーの中だけにあり、答え合わせの瞬間まで誰のブラウザにも送りません。
//
// 流れ : ロビー（ルーム主が問題数・制限時間を決める） → 投票（形式・モード・ジャンルを多数決）
//        → 決定（チーム発表） → 出題 → 答え合わせ（5秒で自動的に次へ） → … → 結果発表
// しくみ
//   画面 → サーバー : POST /api/<操作>   （JSON）
//   サーバー → 画面 : GET  /events      （Server-Sent Events で状態を送り続ける）

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { GENRES, BANK } = require('./questions');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const MAX_BOTS = 7;
const VOTE_MS = 30000;               // 投票の制限時間
const DECIDED_MS = 6000;             // 決定画面（チーム発表）を見せる時間
const REVEAL_MS = 5000;              // 答え合わせを見せてから次の問題へ自動で進むまでの時間
const COUNTS = [5, 10, 15];          // ルーム主が選べる問題数
const TIMES = [10, 15, 20, 30];      // ルーム主が選べる制限時間（秒）
const BUZZ_POINTS = 1000;            // 早押しで正解したときの得点
const HOST_HANDOVER_MS = 15000;      // ルーム主が切断したまま戻らないとき、次の人に交代するまでの時間
const ROOM_IDLE_MS = 15 * 60 * 1000; // 誰もいないルームを消すまでの時間
const GRACE_MS = 600;                // 通信の遅れを見込んだ受付の猶予
const PING_MS = 20000;               // 接続を保つための空送信

// NPC の強さ。accuracy = 正解する確率、speed = 制限時間のどのあたりで答えるか（0=すぐ、1=ぎりぎり）
const BOT_LEVELS = {
  easy:   { label: 'よわい', accuracy: 0.4,  speed: [0.45, 0.9] },
  normal: { label: 'ふつう', accuracy: 0.65, speed: [0.25, 0.7] },
  hard:   { label: 'つよい', accuracy: 0.9,  speed: [0.08, 0.4] },
};
const BOT_NAMES = ['ロボ太', 'ピコ', 'クイズ博士', 'ポン吉', 'ミケ', 'ガリ勉くん', 'ひらめき姫', 'うっかり侍', 'もぐら先生', 'チャチャ', 'ドット', 'ハカセ2号'];

const TEAMS = [
  { id: 'red', name: '赤チーム' },
  { id: 'blue', name: '青チーム' },
];

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
const pick = (arr) => arr[crypto.randomInt(arr.length)];
function pool(genre) {
  if (genre === 'mix') return GENRES.flatMap((g) => BANK[g.id] || []);
  return BANK[genre] || [];
}

// 投票で選ぶもの（問題数と制限時間はルーム主が決める）。id はすべて文字列
function ballot() {
  return [
    { key: 'format', label: '形式', options: [
      { id: 'solo', name: '個人戦', note: 'ひとりずつ点数を競う' },
      { id: 'team', name: 'チーム戦', note: 'ランダムに2チームに分かれる' },
    ], fallback: 'solo' },
    { key: 'mode', label: 'モード', options: [
      { id: 'normal', name: 'ふつう', note: '全員が答える。速く正解するほど高得点' },
      { id: 'buzz', name: '早押し', note: 'いちばん早く正解した人だけ得点。まちがえるとお手つき' },
    ], fallback: 'normal' },
    { key: 'genre', label: 'ジャンル', options: [
      ...GENRES.map((g) => ({ id: g.id, name: g.name, note: g.note, count: pool(g.id).length })),
      { id: 'mix', name: 'ミックス', note: '全ジャンルからランダム', count: pool('mix').length },
    ].filter((g) => g.count > 0), fallback: null },
  ];
}
const BALLOT = ballot();
const optionName = (key, id) => ((BALLOT.find((b) => b.key === key) || { options: [] }).options.find((o) => o.id === id) || {}).name || '';

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
const inGame = (room) => room.phase === 'decided' || room.phase === 'question' || room.phase === 'reveal' || room.phase === 'final';
const teamMode = (room) => room.config && room.config.format === 'team';
const buzzMode = (room) => room.config && room.config.mode === 'buzz';

function clearTimers(room) {
  clearTimeout(room.timer);
  for (const t of room.botTimers || []) clearTimeout(t);
  room.botTimers = [];
}
function deleteRoom(room) {
  clearTimers(room);
  clearTimeout(room.handoverTimer);
  rooms.delete(room.code);
}

/* ---------- 投票 ---------- */
function tally(room) {
  const t = {};
  for (const b of BALLOT) {
    t[b.key] = Object.fromEntries(b.options.map((o) => [o.id, 0]));
  }
  for (const [pid, v] of room.votes) {
    if (!room.players.has(pid)) continue;
    for (const b of BALLOT) if (v[b.key] in t[b.key]) t[b.key][v[b.key]]++;
  }
  return t;
}
const fullyVoted = (room, p) => {
  const v = room.votes.get(p.id);
  return !!v && BALLOT.every((b) => v[b.key]);
};
function startVote(room) {
  clearTimers(room);
  room.phase = 'vote';
  room.votes = new Map();
  room.voteDeadline = Date.now() + VOTE_MS;
  room.timer = setTimeout(() => closeVote(room), VOTE_MS);
  broadcast(room);
}
function maybeCloseVote(room) {
  if (room.phase !== 'vote') return;
  const live = onlineHumans(room);
  if (live.length && live.every((p) => fullyVoted(room, p))) {
    clearTimeout(room.timer);
    room.timer = setTimeout(() => closeVote(room), 1000);
  }
}
function closeVote(room) {
  if (room.phase !== 'vote') return;
  clearTimers(room);
  const t = tally(room);
  const result = {};
  for (const b of BALLOT) {
    const counts = t[b.key];
    const max = Math.max(...Object.values(counts));
    if (max === 0) {
      // 誰も投票しなかった項目は、決まった初期値（ジャンルはランダム）
      result[b.key] = b.fallback || pick(b.options).id;
    } else {
      // 最多票。同数ならランダム
      result[b.key] = pick(Object.keys(counts).filter((id) => counts[id] === max));
    }
  }
  const total = connectedPlayers(room).length;
  room.forcedSolo = result.format === 'team' && total < 2;
  if (room.forcedSolo) result.format = 'solo';
  room.config = {
    format: result.format,
    mode: result.mode,
    genre: result.genre,
    count: room.settings.count,
    time: room.settings.time,
  };
  room.lastTally = t;
  // チーム分け（ランダム、人数がなるべく同じになるように）
  for (const p of room.players.values()) p.team = null;
  if (teamMode(room)) {
    shuffle(connectedPlayers(room)).forEach((p, i) => { p.team = TEAMS[i % TEAMS.length].id; });
  }
  room.phase = 'decided';
  room.decidedAt = Date.now();
  room.timer = setTimeout(() => startGame(room), DECIDED_MS);
  broadcast(room);
}
function smallerTeam(room) {
  const sizes = TEAMS.map((t) => ({ id: t.id, n: [...room.players.values()].filter((p) => p.team === t.id).length }));
  sizes.sort((a, b) => a.n - b.n);
  return sizes[0].n === sizes[sizes.length - 1].n ? pick(TEAMS).id : sizes[0].id;
}

/* ---------- 各プレイヤーに送る状態 ---------- */
function teamBoard(room) {
  if (!teamMode(room)) return null;
  return TEAMS.map((t) => {
    const members = [...room.players.values()].filter((p) => p.team === t.id);
    const sum = members.reduce((s, p) => s + p.score, 0);
    const gain = members.reduce((s, p) => s + p.gain, 0);
    return {
      id: t.id,
      name: t.name,
      size: members.length,
      score: members.length ? Math.round(sum / members.length) : 0, // チーム得点 = メンバーの平均点
      gain: members.length ? Math.round(gain / members.length) : 0,
      members: members.map((p) => p.id),
    };
  });
}
function viewFor(room, player) {
  const q = room.questions[room.qIndex];
  const v = {
    code: room.code,
    me: { id: player.id, name: player.name, isHost: room.hostId === player.id, team: player.team || null },
    phase: room.phase,
    settings: room.settings,
    choices: { counts: COUNTS, times: TIMES },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      gain: p.gain,
      connected: isConnected(p),
      isHost: room.hostId === p.id,
      bot: !!p.bot,
      level: p.bot ? BOT_LEVELS[p.level].label : undefined,
      team: p.team || null,
      answered: room.phase === 'question' ? room.answers.has(p.id) : false,
    })),
  };
  if (room.config && inGame(room)) {
    v.config = {
      ...room.config,
      formatName: optionName('format', room.config.format),
      modeName: optionName('mode', room.config.mode),
      genreName: optionName('genre', room.config.genre),
    };
    v.teams = teamBoard(room);
  }
  if (room.phase === 'vote') {
    const live = onlineHumans(room);
    v.vote = {
      ballot: BALLOT.map((b) => ({ key: b.key, label: b.label, options: b.options })),
      tally: tally(room),
      mine: room.votes.get(player.id) || {},
      voted: live.filter((p) => fullyVoted(room, p)).length,
      voters: live.length,
      remainingMs: Math.max(0, room.voteDeadline - Date.now()),
      canVote: !player.bot,
    };
  }
  if (room.phase === 'decided') {
    v.decided = {
      tally: room.lastTally,
      ballot: BALLOT.map((b) => ({ key: b.key, label: b.label, options: b.options })),
      forcedSolo: room.forcedSolo,
      remainingMs: Math.max(0, room.decidedAt + DECIDED_MS - Date.now()),
    };
  }
  if ((room.phase === 'question' || room.phase === 'reveal') && q) {
    v.question = {
      index: room.qIndex,
      total: room.questions.length,
      text: q.t,
      choices: q.c,
      time: room.config.time,
      remainingMs: room.phase === 'question' ? Math.max(0, room.deadline - Date.now()) : 0,
    };
    const mine = room.answers.get(player.id);
    v.myAnswer = mine ? mine.c : null;
    v.answeredCount = room.answers.size;
    v.playerCount = connectedPlayers(room).length;
    if (buzzMode(room)) {
      // 早押し: お手つきした人の名前だけ（どの選択肢かは見せない）
      v.buzz = {
        missed: [...room.answers.entries()].filter(([, a]) => !a.correct).map(([pid]) => (room.players.get(pid) || {}).name).filter(Boolean),
        myMissed: !!mine && !mine.correct,
        winnerName: room.buzzWinner ? (room.players.get(room.buzzWinner.id) || {}).name || '' : '',
      };
    }
    // 正解は答え合わせのときだけ入れる
    if (room.phase === 'reveal') {
      const dist = [0, 0, 0, 0];
      for (const a of room.answers.values()) dist[a.c]++;
      const winner = room.buzzWinner ? room.players.get(room.buzzWinner.id) : null;
      v.reveal = {
        correct: q.a,
        dist,
        myCorrect: !!mine && mine.c === q.a,
        myGain: player.gain,
        winner: winner ? { id: winner.id, name: winner.name, team: winner.team, sec: (room.buzzWinner.ms / 1000).toFixed(1) } : null,
        nextInMs: Math.max(0, room.revealEndsAt - Date.now()),
        last: room.qIndex + 1 >= room.questions.length,
      };
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
  if (room.phase !== 'decided') return;
  const { genre, count } = room.config;
  room.questions = shuffle(pool(genre)).slice(0, count).map((q) => {
    const order = shuffle([0, 1, 2, 3]);
    return { t: q.t, c: order.map((i) => q.c[i]), a: order.indexOf(0) };
  });
  for (const p of room.players.values()) { p.score = 0; p.gain = 0; }
  showQuestion(room, 0);
}
function showQuestion(room, i) {
  clearTimers(room);
  room.phase = 'question';
  room.qIndex = i;
  room.answers = new Map();
  room.buzzWinner = null;
  for (const p of room.players.values()) p.gain = 0;
  room.qStartedAt = Date.now();
  room.deadline = room.qStartedAt + room.config.time * 1000;
  room.timer = setTimeout(() => reveal(room), room.config.time * 1000 + GRACE_MS);
  scheduleBots(room);
  broadcast(room);
}
function reveal(room) {
  if (room.phase !== 'question') return;
  clearTimers(room);
  const q = room.questions[room.qIndex];
  if (!buzzMode(room)) {
    const limit = room.config.time * 1000;
    for (const [pid, a] of room.answers) {
      const p = room.players.get(pid);
      if (p && a.c === q.a) {
        const pts = Math.round(1000 - 500 * Math.min(1, a.ms / limit)); // 速いほど高得点（500〜1000点）
        p.score += pts;
        p.gain = pts;
      }
    }
  }
  room.phase = 'reveal';
  room.revealEndsAt = Date.now() + REVEAL_MS;
  room.timer = setTimeout(() => advance(room), REVEAL_MS);
  broadcast(room);
}
// 答え合わせのあと、次の問題（最後なら結果発表）へ進む
function advance(room) {
  if (room.phase !== 'reveal') return;
  clearTimers(room);
  if (room.qIndex + 1 < room.questions.length) showQuestion(room, room.qIndex + 1);
  else { room.phase = 'final'; broadcast(room); }
}
function submitAnswer(room, p, c) {
  if (room.phase !== 'question' || room.answers.has(p.id)) return false;
  const ms = Date.now() - room.qStartedAt;
  if (ms > room.config.time * 1000 + GRACE_MS) return false;
  const q = room.questions[room.qIndex];
  const correct = c === q.a;
  room.answers.set(p.id, { c, ms, correct });
  if (buzzMode(room) && correct && !room.buzzWinner) {
    // 早押し: 最初の正解者だけ得点。そこで締め切る
    room.buzzWinner = { id: p.id, ms };
    p.score += BUZZ_POINTS;
    p.gain = BUZZ_POINTS;
    clearTimers(room);
    room.timer = setTimeout(() => reveal(room), 400);
    broadcast(room);
    return true;
  }
  broadcast(room);
  maybeAutoReveal(room);
  return true;
}
function maybeAutoReveal(room) {
  if (room.phase !== 'question' || room.buzzWinner) return;
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

/* ---------- NPC ---------- */
function scheduleBots(room) {
  const q = room.questions[room.qIndex];
  const limit = room.config.time * 1000;
  for (const p of room.players.values()) {
    if (!p.bot) continue;
    const lv = BOT_LEVELS[p.level];
    const [lo, hi] = lv.speed;
    const delay = Math.round(limit * (lo + Math.random() * (hi - lo)));
    const right = Math.random() < lv.accuracy;
    const wrong = [0, 1, 2, 3].filter((i) => i !== q.a);
    const c = right ? q.a : pick(wrong);
    room.botTimers.push(setTimeout(() => {
      if (room.questions[room.qIndex] !== q || !room.players.has(p.id)) return;
      submitAnswer(room, p, c);
    }, delay));
  }
}
function addBot(room, level) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  const name = shuffle(BOT_NAMES).find((n) => !used.has(n)) || uniqueName(room, 'NPC');
  const p = { id: rand(6), token: null, bot: true, level, name, score: 0, gain: 0, team: null, joinedAt: Date.now(), streams: new Set() };
  room.players.set(p.id, p);
  return p;
}

/* ---------- 操作 ---------- */
function addPlayer(room, name) {
  const p = { id: rand(6), token: rand(16), name: uniqueName(room, name), score: 0, gain: 0, team: null, joinedAt: Date.now(), streams: new Set() };
  // 試合の途中に来た人は、人数の少ないチームに入る
  if (teamMode(room) && inGame(room) && room.phase !== 'final') p.team = smallerTeam(room);
  room.players.set(p.id, p);
  return p;
}
function auth(body) {
  const room = rooms.get(String(body.code || ''));
  if (!room) return {};
  const me = body.token ? humans(room).find((p) => p.token === body.token) : null;
  return { room, me, isHost: !!me && room.hostId === me.id };
}
const canSetUp = (room) => room.phase === 'lobby' || room.phase === 'final';

const actions = {
  create(body) {
    const name = cleanName(body.name);
    if (!name) return { ok: false, error: 'ニックネームを入れてください。' };
    const code = newCode();
    const room = {
      code, hostId: null, players: new Map(), phase: 'lobby', settings: { count: 10, time: 15 },
      config: null, votes: new Map(), questions: [], qIndex: 0, answers: new Map(),
      botTimers: [], lastActive: Date.now(),
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
    room.votes.delete(me.id);
    if (humans(room).length === 0) { deleteRoom(room); return { ok: true }; }
    if (room.hostId === me.id) room.hostId = (onlineHumans(room)[0] || humans(room)[0]).id;
    maybeAutoReveal(room);
    maybeCloseVote(room);
    broadcast(room);
    return { ok: true };
  },
  addBot(body) {
    const { room, isHost } = auth(body);
    if (!isHost || !canSetUp(room)) return { ok: false };
    if (!BOT_LEVELS[body.level]) return { ok: false };
    if (room.players.size - humans(room).length >= MAX_BOTS) return { ok: false, error: `NPCは${MAX_BOTS}人までです。` };
    addBot(room, body.level);
    broadcast(room);
    return { ok: true };
  },
  removeBot(body) {
    const { room, isHost } = auth(body);
    if (!isHost || !canSetUp(room)) return { ok: false };
    const p = room.players.get(String(body.id || ''));
    if (!p || !p.bot) return { ok: false };
    room.players.delete(p.id);
    broadcast(room);
    return { ok: true };
  },
  settings(body) {
    const { room, isHost } = auth(body);
    if (!isHost || !canSetUp(room)) return { ok: false };
    if (COUNTS.includes(+body.count)) room.settings.count = +body.count;
    if (TIMES.includes(+body.time)) room.settings.time = +body.time;
    broadcast(room);
    return { ok: true };
  },
  startVote(body) {
    const { room, isHost } = auth(body);
    if (!isHost || !canSetUp(room)) return { ok: false };
    startVote(room);
    return { ok: true };
  },
  vote(body) {
    const { room, me } = auth(body);
    if (!me || room.phase !== 'vote') return { ok: false };
    const b = BALLOT.find((x) => x.key === body.key);
    if (!b || !b.options.some((o) => o.id === String(body.value))) return { ok: false };
    const mine = { ...(room.votes.get(me.id) || {}) };
    mine[b.key] = String(body.value);
    room.votes.set(me.id, mine);
    broadcast(room);
    maybeCloseVote(room);
    return { ok: true };
  },
  closeVote(body) {
    const { room, isHost } = auth(body);
    if (!isHost || room.phase !== 'vote') return { ok: false };
    closeVote(room);
    return { ok: true };
  },
  answer(body) {
    const { room, me } = auth(body);
    if (!me) return { ok: false };
    const c = Number(body.c);
    if (![0, 1, 2, 3].includes(c)) return { ok: false };
    if (room.phase !== 'question') return { ok: false, error: 'この問題はもう締め切られました。' };
    const ok = submitAnswer(room, me, c);
    return ok ? { ok: true } : { ok: false, error: '時間切れです。' };
  },
  close(body) {
    const { room, isHost } = auth(body);
    if (isHost) reveal(room);
    return { ok: !!isHost };
  },
  next(body) {
    const { room, isHost } = auth(body);
    if (!isHost || room.phase !== 'reveal') return { ok: false };
    advance(room);
    return { ok: true };
  },
  lobby(body) {
    const { room, isHost } = auth(body);
    if (!isHost) return { ok: false };
    clearTimers(room);
    room.phase = 'lobby';
    room.config = null;
    for (const p of room.players.values()) { p.score = 0; p.gain = 0; p.team = null; }
    broadcast(room);
    return { ok: true };
  },
};

/* ---------- HTTP ---------- */
// 画面のファイルは public フォルダの中か、server.js と同じ場所のどちらに置いてあっても動くようにする
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')]
  .find((p) => fs.existsSync(p)) || path.join(__dirname, 'public', 'index.html');

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
    maybeCloseVote(room);
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
  for (const [, room] of rooms) {
    if (onlineHumans(room).length === 0 && now - room.lastActive > ROOM_IDLE_MS) deleteRoom(room);
  }
}, 60 * 1000).unref();

server.listen(PORT, () => console.log(`クイズ大会サーバー起動: http://localhost:${PORT}`));
