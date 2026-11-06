// みんなのクイズ大会 — サーバー（追加ライブラリ不要。Node.js 18 以上で動きます）
// 正解はこのサーバーの中だけにあり、答え合わせの瞬間まで誰のブラウザにも送りません。
//
// 流れ : ロビー（ルーム主が問題数・制限時間を決める） → 投票（形式・モード・回答方式・ジャンル・難易度を多数決。全員が準備OKで締め切り）
//        → 決定（チーム発表） → 出題 → 答え合わせ（5秒で自動的に次へ） → … → 結果発表
// しくみ
//   画面 → サーバー : POST /api/<操作>   （JSON）
//   サーバー → 画面 : GET  /events      （Server-Sent Events で状態を送り続ける）

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const { GENRES, BANK } = require('./questions');
// ログイン機能（下書き・まだ使っていない）。accounts.js がなくても動くようにしておく
let accounts = null;
try { accounts = require('./accounts'); } catch { accounts = null; }

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 50;
const MAX_BOTS = 7;
const DECIDED_MS = 11000;            // 決定画面（スロットでルール発表）を見せる時間
const DECIDED_TEAM_MS = 15000;       // チーム戦のとき（スロットのあとにチーム発表）
const REVEAL_MS = 5000;              // 答え合わせを見せてから次の問題へ自動で進むまでの時間
const COUNTS = [5, 10, 15, 30];          // ルーム主が選べる問題数
const TIMES = [10, 15, 20, 30];      // ルーム主が選べる制限時間（秒）
const BUZZ_POINTS = 1000;            // 早押しで正解したときの得点
// 連続正解ボーナス：2連続 +50、3連続 +100 … 6連続以上 +250
const streakBonus = (streak) => (streak >= 2 ? Math.min(streak - 1, 5) * 50 : 0);
const REACTIONS = ['すごい！', '惜しい！', 'ドンマイ', 'ナイス！', 'えっ!?', '速い！'];
const REACTION_GAP_MS = 700;         // スタンプの連打防止
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🐧', '🦉', '🐙', '🐯', '🐰', '🐻', '🐨', '🦁', '🐮', '🐵', '🐲'];
const COLORS = 8;                    // アイコンの背景色の数（色そのものは画面側で決める）
const CHAT_MAX = 60;                 // チャット1件の最大文字数
const CHAT_KEEP = 40;                // ルームに残しておくチャットの件数
const CHAT_GAP_MS = 1000;            // チャットの連投防止
const clampInt = (v, max, def) => (Number.isInteger(+v) && +v >= 0 && +v < max ? +v : def);
const HOST_HANDOVER_MS = 15000;      // ルーム主が切断したまま戻らないとき、次の人に交代するまでの時間
const ROOM_IDLE_MS = 15 * 60 * 1000; // 誰もいないルームを消すまでの時間
const GRACE_MS = 600;                // 通信の遅れを見込んだ受付の猶予
const PING_MS = 20000;               // 接続を保つための空送信
const RESUME_GRACE_MS = 1500;        // 再開したとき、残り時間に足すおまけ
const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // これより古い保存データからは再開しない

// NPC の強さ。accuracy = 正解する確率、speed = 制限時間のどのあたりで答えるか（0=すぐ、1=ぎりぎり）
// typeMs = タイピングで1文字打つのにかかる時間
const BOT_LEVELS = {
  easy:   { label: '弱い', accuracy: 0.4,  speed: [0.45, 0.9], typeMs: 550 },
  normal: { label: '普通', accuracy: 0.65, speed: [0.25, 0.7], typeMs: 400 },
  hard:   { label: '強い', accuracy: 0.9,  speed: [0.08, 0.4], typeMs: 300 },
};
// 早押しとタイピングでは NPC を少し弱く・遅くする
const BOT_BUZZ = { accuracy: 0.75, slower: 0.2 };      // 正解率を0.75倍、答えるタイミングを制限時間の2割ぶん遅く
const BOT_TYPING = { accuracy: 0.8, thinkMs: 1500 };   // 正解率を0.8倍、打ちはじめるまで1.5秒＋1文字ごとの時間
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
// 難易度が分かれているジャンルか（なぞなぞは共通）
const hasLevels = (genre) => pool(genre).some((q) => q.d);
// 難易度に合わせて問題を選ぶ。選んだ難易度の問題を優先し、足りなければ近い難易度から補う
const LEVEL_ORDER = { easy: [1, 2, 3], normal: [2, 1, 3], hard: [3, 2, 1] };
const typable = (q) => Array.isArray(q.k);
function pickQuestions(genre, difficulty, count, answerType) {
  // タイピングのときは、入力で答えられる問題だけから選ぶ
  const all = answerType === 'typing' ? pool(genre).filter(typable) : pool(genre);
  if (!hasLevels(genre)) return shuffle(all).slice(0, count);
  const order = LEVEL_ORDER[difficulty] || LEVEL_ORDER.normal;
  const picked = order.flatMap((lv) => shuffle(all.filter((q) => (q.d || 2) === lv))).slice(0, count);
  return shuffle(picked);
}

// 投票で選ぶもの（問題数と制限時間はルーム主が決める）。id はすべて文字列
function ballot() {
  return [
    { key: 'format', label: '形式', options: [
      { id: 'solo', name: '個人戦', note: '個人で得点を競う' },
      { id: 'team', name: 'チーム戦', note: 'ランダムに2チームに分かれて競う' },
    ], fallback: 'solo' },
    { key: 'mode', label: 'モード', options: [
      { id: 'normal', name: '通常', note: '全員が回答。早く正解するほど高得点' },
      { id: 'buzz', name: '早押し', note: '最初の正解者だけが得点。誤答はお手つき' },
    ], fallback: 'normal' },
    { key: 'answer', label: '回答方式', options: [
      { id: 'choice', name: '4択', note: '4つの選択肢から選ぶ' },
      { id: 'typing', name: 'タイピング', note: '答えを入力する' },
      { id: 'mixed', name: '混合', note: '4択とタイピングを混ぜて出題' },
    ], fallback: 'choice' },
    { key: 'genre', label: 'ジャンル', options: [
      ...GENRES.map((g) => ({ id: g.id, name: g.name, note: g.note, count: pool(g.id).length })),
      { id: 'mix', name: 'ミックス', note: '全ジャンルからランダム', count: pool('mix').length },
    ].filter((g) => g.count > 0), fallback: null },
    { key: 'difficulty', label: '難易度', options: [
      { id: 'easy', name: '初級' },
      { id: 'normal', name: '中級' },
      { id: 'hard', name: '上級' },
    ], fallback: 'normal' },
  ];
}
const BALLOT = ballot();

/* ---------- タイピングの答え合わせ ---------- */
// 全角/半角・大文字/小文字・カタカナ/ひらがな・空白や記号のちがいは同じとみなす
function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[\s・.,、。!?！？「」『』"'`~〜\-ー－―]/g, (ch) => (ch === 'ー' ? 'ー' : ''))
    .trim();
}
// 正解として認める書き方の一覧（（ ）の中は書いても書かなくてもよい）
function acceptList(q) {
  const out = new Set();
  for (const raw of [q.c[0], ...(q.k || [])]) {
    const s = String(raw);
    out.add(norm(s));
    const outer = s.replace(/（[^）]*）|\([^)]*\)/g, '');
    if (outer.trim()) out.add(norm(outer));
    for (const m of s.matchAll(/（([^）]*)）|\(([^)]*)\)/g)) {
      const inner = m[1] || m[2];
      if (inner && !/[、。]/.test(inner)) out.add(norm(inner));
    }
  }
  out.delete('');
  return [...out];
}
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
// 観戦の人は、回答・投票・チーム・順位に入らない
const connectedPlayers = (room) => [...room.players.values()].filter((p) => isConnected(p) && !p.spectator);
const humans = (room) => [...room.players.values()].filter((p) => !p.bot);
const onlineHumans = (room) => humans(room).filter(isConnected);
const voters = (room) => onlineHumans(room).filter((p) => !p.spectator);
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
  room.ready = new Set();
  broadcast(room);
}
// 全員が「準備OK」を押したら締め切る（制限時間はなし。ルーム主は途中で締め切れる）
function maybeCloseVote(room) {
  if (room.phase !== 'vote') return;
  const live = voters(room);
  clearTimeout(room.timer);
  if (live.length && live.every((p) => room.ready.has(p.id))) {
    room.timer = setTimeout(() => closeVote(room), 800);
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
    difficulty: result.difficulty,
    answer: result.answer,
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
  room.decidedMs = teamMode(room) ? DECIDED_TEAM_MS : DECIDED_MS;
  room.timer = setTimeout(() => startGame(room), room.decidedMs);
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
// 終盤（最後の約3割の問題）は、合計点・順位・チーム得点をかくす
const HIDE_RATIO = 0.3;
const hideFromIndex = (total) => total - Math.max(1, Math.ceil(total * HIDE_RATIO));
const scoresHidden = (room) => (room.phase === 'question' || room.phase === 'reveal') && room.qIndex >= room.hideFrom;

function viewFor(room, player) {
  const q = room.questions[room.qIndex];
  const hidden = scoresHidden(room);
  const v = {
    code: room.code,
    me: { id: player.id, name: player.name, isHost: room.hostId === player.id, team: player.team || null, spectator: !!player.spectator },
    phase: room.phase,
    version: VERSION,
    snap: room.snap || (room.snap = sealSnapshot(snapshotOf(room))),
    settings: room.settings,
    choices: { counts: COUNTS, times: TIMES },
    reactions: REACTIONS,
    avatars: AVATARS,
    chat: (room.chat || []).slice(-30),
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      // かくしているあいだは点数を送らない（自分のこの問題の得点だけは見せる）
      score: hidden ? null : p.score,
      gain: hidden ? (p.id === player.id ? p.gain : 0) : p.gain,
      connected: isConnected(p),
      isHost: room.hostId === p.id,
      bot: !!p.bot,
      level: p.bot ? BOT_LEVELS[p.level].label : undefined,
      team: p.team || null,
      account: !!p.userId,
      avatar: p.avatar || 0,
      color: p.color || 0,
      spectator: !!p.spectator,
      streak: hidden && p.id !== player.id ? 0 : (p.streak || 0),
      answered: room.phase === 'question' ? room.answers.has(p.id) : false,
    })),
  };
  if (room.config && inGame(room)) {
    v.config = {
      ...room.config,
      formatName: optionName('format', room.config.format),
      modeName: optionName('mode', room.config.mode),
      genreName: optionName('genre', room.config.genre),
      difficultyName: optionName('difficulty', room.config.difficulty),
      answerName: optionName('answer', room.config.answer),
      leveled: hasLevels(room.config.genre),
    };
    v.teams = teamBoard(room);
    if (v.teams && hidden) v.teams = v.teams.map((t) => ({ ...t, score: null, gain: null }));
    v.hidden = hidden;
    v.hideFrom = room.hideFrom;
  }
  if (room.phase === 'final') {
    v.finalElapsedMs = Date.now() - room.finalAt; // 結果発表の演出を全員でそろえるため
    v.record = room.recorded || null;               // 成績を記録したか
  }
  if (room.phase === 'vote') {
    const live = voters(room);
    v.vote = {
      ballot: BALLOT.map((b) => ({ key: b.key, label: b.label, options: b.options })),
      tally: tally(room),
      mine: room.votes.get(player.id) || {},
      readyCount: live.filter((p) => room.ready.has(p.id)).length,
      voters: live.length,
      people: live.map((p) => ({ id: p.id, name: p.name, ready: room.ready.has(p.id) })),
      myReady: room.ready.has(player.id),
    };
  }
  if (room.phase === 'decided') {
    v.decided = {
      tally: room.lastTally,
      ballot: BALLOT.map((b) => ({ key: b.key, label: b.label, options: b.options })),
      forcedSolo: room.forcedSolo,
      remainingMs: Math.max(0, room.decidedAt + room.decidedMs - Date.now()),
      elapsedMs: Date.now() - room.decidedAt, // スロットの回り具合を全員でそろえるため
    };
  }
  if ((room.phase === 'question' || room.phase === 'reveal') && q) {
    v.question = {
      index: room.qIndex,
      total: room.questions.length,
      text: q.t,
      typing: q.typing,
      choices: q.typing ? null : q.c, // タイピングの問題では選択肢を送らない
      time: room.config.time,
      remainingMs: room.phase === 'question' ? Math.max(0, room.deadline - Date.now()) : 0,
    };
    const mine = room.answers.get(player.id);
    v.myAnswer = mine ? (q.typing ? -1 : mine.c) : null;
    v.myText = mine && q.typing ? mine.text : null;
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
      if (!q.typing) for (const a of room.answers.values()) dist[a.c]++;
      const winner = room.buzzWinner ? room.players.get(room.buzzWinner.id) : null;
      v.reveal = {
        correct: q.typing ? null : q.a,
        correctText: q.c[q.a],
        dist,
        // タイピング: みんなが入力した答え（答えた順）
        typed: q.typing ? [...room.answers.entries()].sort((x, y) => x[1].ms - y[1].ms).map(([pid, a]) => ({
          id: pid, name: (room.players.get(pid) || {}).name || '', text: a.text, correct: a.correct, sec: (a.ms / 1000).toFixed(1),
        })) : null,
        myCorrect: !!mine && mine.correct,
        myGain: player.gain,
        myBonus: player.bonus || 0,
        myStreak: player.streak || 0,
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
  room.snap = sealSnapshot(snapshotOf(room)); // 再起動にそなえて、最新の状態を預けておく
  for (const p of room.players.values()) {
    if (p.bot || !isConnected(p)) continue;
    const view = viewFor(room, p);
    for (const res of p.streams) send(res, 'state', view);
  }
}

/* ---------- 進行 ---------- */
function startGame(room) {
  if (room.phase !== 'decided') return;
  const { genre, difficulty, count, answer } = room.config;
  room.questions = pickQuestions(genre, difficulty, count, answer).map((q) => {
    const order = shuffle([0, 1, 2, 3]);
    // まぜる: タイピングで答えられる問題を半分くらいの確率でタイピングにする
    const typing = typable(q) && (answer === 'typing' || (answer === 'mixed' && Math.random() < 0.5));
    return { t: q.t, c: order.map((i) => q.c[i]), a: order.indexOf(0), typing, accept: typing ? acceptList(q) : null };
  });
  room.hideFrom = hideFromIndex(room.questions.length);
  room.recorded = null;
  for (const p of room.players.values()) { p.score = 0; p.gain = 0; p.bonus = 0; p.streak = 0; p.seen = 0; p.correct = 0; }
  showQuestion(room, 0);
}
function showQuestion(room, i) {
  clearTimers(room);
  room.phase = 'question';
  room.qIndex = i;
  room.answers = new Map();
  room.buzzWinner = null;
  for (const p of room.players.values()) { p.gain = 0; p.bonus = 0; p.seen = (p.seen || 0) + 1; } // 出題された問題数（成績用）
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
  for (const [pid, a] of room.answers) { const p = room.players.get(pid); if (p && a.correct) p.correct = (p.correct || 0) + 1; }
  if (!buzzMode(room)) {
    const limit = room.config.time * 1000;
    for (const p of room.players.values()) {
      const a = room.answers.get(p.id);
      if (a && a.correct) {
        const pts = Math.round(1000 - 500 * Math.min(1, a.ms / limit)); // 速いほど高得点（500〜1000点）
        p.streak = (p.streak || 0) + 1;
        p.bonus = streakBonus(p.streak);
        p.score += pts + p.bonus;
        p.gain = pts + p.bonus;
      } else {
        p.streak = 0; // まちがえた・答えなかったら連続は止まる
      }
    }
  } else {
    // 早押し：まちがえた（お手つき）人だけ連続が止まる。正解者の連続は答えたときに数えている
    for (const [pid, a] of room.answers) { const p = room.players.get(pid); if (p && !a.correct) p.streak = 0; }
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
  else { room.phase = 'final'; room.finalAt = Date.now(); broadcast(room); recordResults(room); }
}
// 結果発表になったら、ログインしている人の成績を記録する（人間が2人以上ならランキングにも数える）
async function recordResults(room) {
  if (room.recorded) return;
  const people = humans(room).filter((p) => !p.spectator);
  const ranked = people.length >= 2;
  const all = [...room.players.values()];
  let winners;
  if (teamMode(room)) {
    const board = teamBoard(room) || [];
    const top = Math.max(...board.map((t) => t.score));
    const tops = board.filter((t) => t.score === top);
    winners = new Set(tops.length === 1 ? all.filter((p) => p.team === tops[0].id).map((p) => p.id) : []);
  } else {
    const top = Math.max(0, ...all.map((p) => p.score));
    winners = new Set(top > 0 ? all.filter((p) => p.score === top).map((p) => p.id) : []);
  }
  const results = people.filter((p) => p.userId).map((p) => ({
    id: p.userId, questions: p.seen || 0, correct: p.correct || 0, score: p.score, win: winners.has(p.id) ? 1 : 0,
  }));
  room.recorded = { ranked, accounts: results.length, saved: null };
  if (!results.length) return;
  if (!accounts) return;
  const saved = await accounts.recordGame(results, ranked);
  if (room.recorded) room.recorded.saved = saved;
  if (rooms.get(room.code) === room) broadcast(room);
}
// input は { c: 選んだ番号 } か { text: 入力した答え }
function submitAnswer(room, p, input) {
  if (room.phase !== 'question' || room.answers.has(p.id)) return false;
  const ms = Math.min(Date.now() - room.qStartedAt, room.config.time * 1000);
  if (Date.now() > room.deadline + GRACE_MS) return false;
  const q = room.questions[room.qIndex];
  let entry;
  if (q.typing) {
    const text = String(input.text || '').slice(0, 40);
    entry = { c: -1, text, ms, correct: q.accept.includes(norm(text)) };
  } else {
    entry = { c: input.c, ms, correct: input.c === q.a };
  }
  const correct = entry.correct;
  room.answers.set(p.id, entry);
  if (buzzMode(room) && correct && !room.buzzWinner) {
    // 早押し: 最初の正解者だけ得点。そこで締め切る
    room.buzzWinner = { id: p.id, ms };
    p.streak = (p.streak || 0) + 1;
    p.bonus = streakBonus(p.streak);
    p.score += BUZZ_POINTS + p.bonus;
    p.gain = BUZZ_POINTS + p.bonus;
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
    const nextHost = voters(room).sort((a, b) => a.joinedAt - b.joinedAt)[0] || onlineHumans(room)[0];
    if (nextHost) { room.hostId = nextHost.id; broadcast(room); }
  }, HOST_HANDOVER_MS);
}

/* ---------- NPC ---------- */
// elapsed: 再開したときに、すでに過ぎていた時間
function scheduleBots(room, elapsed = 0) {
  const q = room.questions[room.qIndex];
  const limit = room.config.time * 1000;
  for (const p of room.players.values()) {
    if (!p.bot || room.answers.has(p.id)) continue;
    const lv = BOT_LEVELS[p.level];
    let [lo, hi] = lv.speed;
    let accuracy = lv.accuracy;
    if (buzzMode(room)) {
      accuracy *= BOT_BUZZ.accuracy;
      lo = Math.min(0.9, lo + BOT_BUZZ.slower);
      hi = Math.min(0.95, hi + BOT_BUZZ.slower);
    }
    if (q.typing) accuracy *= BOT_TYPING.accuracy;
    const right = Math.random() < accuracy;
    const wrong = [0, 1, 2, 3].filter((i) => i !== q.a);
    const c = right ? q.a : pick(wrong);
    let delay;
    if (q.typing) {
      // 文字を打つ時間をとってから、残りの時間の中で答える（長い答えで間に合わなければ答えない）
      const typeTime = BOT_TYPING.thinkMs + q.c[c].length * lv.typeMs;
      const room_ = limit - 300 - typeTime;
      if (room_ <= 0) continue;
      delay = Math.round(typeTime + room_ * (lo + Math.random() * (hi - lo)));
    } else {
      delay = Math.round(limit * (lo + Math.random() * (hi - lo)));
    }
    if (elapsed) delay = Math.max(800 + Math.random() * 1500, delay - elapsed);
    // タイピングの問題では、選んだ選択肢の言葉を「入力」する
    const input = q.typing ? { text: q.c[c] } : { c };
    room.botTimers.push(setTimeout(() => {
      if (room.questions[room.qIndex] !== q || !room.players.has(p.id)) return;
      submitAnswer(room, p, input);
    }, delay));
  }
}
function addBot(room, level) {
  const used = new Set([...room.players.values()].map((p) => p.name));
  const name = shuffle(BOT_NAMES).find((n) => !used.has(n)) || uniqueName(room, 'NPC');
  const p = {
    id: rand(6), token: null, bot: true, level, name, score: 0, gain: 0, team: null, joinedAt: Date.now(), streams: new Set(),
    avatar: crypto.randomInt(AVATARS.length), color: crypto.randomInt(COLORS),
  };
  room.players.set(p.id, p);
  return p;
}

/* ---------- 操作 ---------- */
// opts: { avatar, color, spectator }
function addPlayer(room, name, user, opts = {}) {
  const p = {
    id: rand(6), token: rand(16), name: uniqueName(room, user ? user.nickname : name), score: 0, gain: 0, team: null,
    userId: user ? user.id : null, seen: 0, correct: 0, joinedAt: Date.now(), streams: new Set(),
    avatar: clampInt(opts.avatar, AVATARS.length, crypto.randomInt(AVATARS.length)),
    color: clampInt(opts.color, COLORS, crypto.randomInt(COLORS)),
    spectator: !!opts.spectator,
  };
  // 試合の途中に来た人は、人数の少ないチームに入る
  if (!p.spectator && teamMode(room) && inGame(room) && room.phase !== 'final') p.team = smallerTeam(room);
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

/* ---------- 意見箱 ---------- */
// 送られた意見は Google フォームに転送する。
// Render の環境変数 FEEDBACK_FORM_URL に、Google フォームの「事前入力したURL」を登録する
// （4つの欄に KIND・TEXT・NAME・INFO と入れて作ったリンク）。
const FEEDBACK_KINDS = ['要望', '不具合', 'その他'];
const FEEDBACK_MAX = 500;
const FEEDBACK_LIMIT = { count: 3, windowMs: 10 * 60 * 1000 }; // 同じ回線から10分に3件まで
const feedbackLog = new Map();   // ip -> 送った時刻の一覧
const feedbackMemory = [];       // フォームが未設定のときに、とりあえず残しておく（再起動で消える）
function feedbackForm() {
  const raw = process.env.FEEDBACK_FORM_URL || '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const fields = {};
    for (const [k, v] of u.searchParams) if (k.startsWith('entry.')) fields[String(v).trim().toUpperCase()] = k;
    if (!fields.TEXT) { console.error('意見箱: FEEDBACK_FORM_URL に TEXT の欄が見つかりません。事前入力したURLを作り直してください。'); return null; }
    const action = `${u.origin}${u.pathname.replace(/\/viewform$/, '/formResponse')}`;
    return { action, fields };
  } catch {
    console.error('意見箱: FEEDBACK_FORM_URL の形式が正しくありません。');
    return null;
  }
}
const FEEDBACK_FORM = feedbackForm();
async function sendFeedback(item) {
  if (!FEEDBACK_FORM) {
    feedbackMemory.push(item);
    if (feedbackMemory.length > 200) feedbackMemory.shift();
    console.log('意見箱（フォーム未設定のためログのみ）:', JSON.stringify(item));
    return true;
  }
  const body = new URLSearchParams();
  const { fields } = FEEDBACK_FORM;
  if (fields.KIND) body.set(fields.KIND, item.kind);
  body.set(fields.TEXT, item.text);
  if (fields.NAME) body.set(fields.NAME, item.name);
  if (fields.INFO) body.set(fields.INFO, item.info);
  try {
    const res = await fetch(FEEDBACK_FORM.action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'manual',              // ログイン画面に飛ばされたかを見分けるため
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return true;
    // 失敗の理由をログに出す（Render の「Logs」で見られる）
    const loc = res.headers.get('location') || '';
    let why = '';
    if ((res.status >= 300 && res.status < 400 && /accounts\.google\.com|ServiceLogin/.test(loc)) || res.status === 401 || res.status === 403) {
      why = 'フォームがログイン必須になっています。フォームの「設定」で「（学校や組織名）のユーザーに限定する」と「メールアドレスを収集する」をオフにしてください。';
    } else if (res.status === 400) {
      why = '質問の形式が合っていません。4つの質問をすべて「記述式」（内容だけ「段落」）にして、「必須」をオフにしてください。';
    } else if (res.status === 404) {
      why = 'フォームが見つかりません。FEEDBACK_FORM_URL のリンクを確かめてください。';
    }
    console.error(`意見箱：フォームへの送信に失敗（${res.status}）${why}`);
    return false;
  } catch (e) {
    console.error('意見箱：フォームへの送信に失敗', e.message);
    return false;
  }
}

const actions = {
  async feedback(body, ip) {
    const kind = FEEDBACK_KINDS.includes(body.kind) ? body.kind : 'その他';
    const text = String(body.text || '').replace(/\r\n?/g, '\n').trim().slice(0, FEEDBACK_MAX);
    if (text.length < 2) return { ok: false, error: '内容を入力してください。' };
    const name = String(body.name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 20) || '（名前なし）';
    const now = Date.now();
    const key = ip || 'unknown';
    const recent = (feedbackLog.get(key) || []).filter((t) => now - t < FEEDBACK_LIMIT.windowMs);
    if (recent.length >= FEEDBACK_LIMIT.count) return { ok: false, error: '短い時間に送れるのは3件までです。しばらくしてからお試しください。' };
    const ctx = body.ctx && typeof body.ctx === 'object' ? body.ctx : {};
    const info = [
      `バージョン ${VERSION}`,
      ctx.phase ? `画面 ${String(ctx.phase).slice(0, 20)}` : '',
      ctx.room ? `ルーム ${String(ctx.room).slice(0, 8)}` : '',
      ctx.screen ? `画面サイズ ${String(ctx.screen).slice(0, 20)}` : '',
      ctx.ua ? `ブラウザ ${String(ctx.ua).slice(0, 200)}` : '',
    ].filter(Boolean).join(' / ');
    const ok = await sendFeedback({ kind, text, name, info, at: new Date(now).toISOString() });
    if (!ok) return { ok: false, error: '送信に失敗しました。時間をおいてもう一度お試しください。' };
    recent.push(now);
    feedbackLog.set(key, recent);
    return { ok: true };
  },
  async create(body) {
    const user = body.auth && accounts ? await accounts.userForRoom(body.auth) : null;
    const name = user ? user.nickname : cleanName(body.name);
    if (!name) return { ok: false, error: 'ニックネームを入力してください。' };
    const code = newCode();
    const room = {
      code, hostId: null, players: new Map(), phase: 'lobby', settings: { count: 10, time: 15 },
      config: null, votes: new Map(), ready: new Set(), questions: [], qIndex: 0, answers: new Map(),
      botTimers: [], lastActive: Date.now(), chat: [],
    };
    rooms.set(code, room);
    const me = addPlayer(room, name, user, { avatar: body.avatar, color: body.color });
    room.hostId = me.id;
    return { ok: true, code, token: me.token };
  },
  async join(body) {
    const code = String(body.code || '').replace(/\D/g, '');
    const room = rooms.get(code);
    if (!room) return { ok: false, error: 'ルームが見つかりません。番号を確認してください。' };
    const known = body.token ? humans(room).find((p) => p.token === body.token) : null;
    if (known) return { ok: true, code, token: known.token, version: VERSION };
    const user = body.auth && accounts ? await accounts.userForRoom(body.auth) : null;
    // 同じアカウントでもう入っていたら（別の端末から開いたときなど）、その人として入る
    const same = user ? humans(room).find((p) => p.userId === user.id) : null;
    if (same) return { ok: true, code, token: same.token, version: VERSION };
    const name = user ? user.nickname : cleanName(body.name);
    if (!name) return { ok: false, error: 'ニックネームを入力してください。' };
    if (humans(room).length >= MAX_PLAYERS) return { ok: false, error: 'このルームは満員です。' };
    const me = addPlayer(room, name, user, { avatar: body.avatar, color: body.color, spectator: !!body.spectator });
    room.lastActive = Date.now();
    broadcast(room);
    return { ok: true, code, token: me.token };
  },
  // 再起動で消えたルームを、ブラウザに預けておいたデータから元に戻す
  restore(body) {
    const code = String(body.code || '');
    if (rooms.has(code)) {
      const r = rooms.get(code);
      const known = body.token ? humans(r).find((p) => p.token === body.token) : null;
      return known ? { ok: true, code, version: VERSION } : { ok: false, error: 'このルームには参加していません。' };
    }
    const snap = openSnapshot(body.snap);
    if (!snap || snap.v !== 1 || snap.code !== code) return { ok: false, error: 'ルームを再開できませんでした。' };
    if (Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) return { ok: false, error: '保存期間を過ぎているため、ルームを再開できませんでした。' };
    if (!snap.players.some((p) => !p.bot && p.token === body.token)) return { ok: false, error: 'このルームには参加していません。' };
    restoreRoom(snap);
    return { ok: true, code, version: VERSION, restored: true };
  },
  leave(body) {
    const { room, me } = auth(body);
    if (!me) return { ok: true };
    for (const res of me.streams) res.end();
    room.players.delete(me.id);
    room.votes.delete(me.id);
    if (room.ready) room.ready.delete(me.id);
    if (humans(room).length === 0) { deleteRoom(room); return { ok: true }; }
    if (room.hostId === me.id) room.hostId = (voters(room)[0] || onlineHumans(room)[0] || humans(room)[0]).id;
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
    if (!me || room.phase !== 'vote' || me.spectator) return { ok: false };
    if (room.ready.has(me.id)) return { ok: false, error: '投票を変更するには、準備OKを取り消してください。' };
    const b = BALLOT.find((x) => x.key === body.key);
    if (!b || !b.options.some((o) => o.id === String(body.value))) return { ok: false };
    const mine = { ...(room.votes.get(me.id) || {}) };
    mine[b.key] = String(body.value);
    room.votes.set(me.id, mine);
    broadcast(room);
    return { ok: true };
  },
  ready(body) {
    const { room, me } = auth(body);
    if (!me || room.phase !== 'vote' || me.spectator) return { ok: false };
    if (body.on) {
      if (!fullyVoted(room, me)) return { ok: false, error: 'すべての項目に投票してから押してください。' };
      room.ready.add(me.id);
    } else {
      room.ready.delete(me.id);
    }
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
    if (me.spectator) return { ok: false, error: '観戦中は回答できません。' };
    if (room.phase !== 'question') return { ok: false, error: 'この問題はもう締め切られました。' };
    const q = room.questions[room.qIndex];
    let input;
    if (q.typing) {
      const text = String(body.text || '').trim();
      if (!text) return { ok: false, error: '答えを入力してください。' };
      input = { text };
    } else {
      const c = Number(body.c);
      if (![0, 1, 2, 3].includes(c)) return { ok: false };
      input = { c };
    }
    const ok = submitAnswer(room, me, input);
    return ok ? { ok: true } : { ok: false, error: '時間切れです。' };
  },
  // アイコンと色を変える
  profile(body) {
    const { room, me } = auth(body);
    if (!me) return { ok: false };
    me.avatar = clampInt(body.avatar, AVATARS.length, me.avatar || 0);
    me.color = clampInt(body.color, COLORS, me.color || 0);
    broadcast(room);
    return { ok: true };
  },
  // 観戦とプレイヤーを切りかえる（ロビーと結果発表のときだけ）
  spectate(body) {
    const { room, me } = auth(body);
    if (!me || !canSetUp(room)) return { ok: false, error: 'ゲーム中は切り替えられません。' };
    const on = !!body.on;
    if (on && room.hostId === me.id) return { ok: false, error: 'ルーム主は観戦にできません。' };
    me.spectator = on;
    me.team = null;
    broadcast(room);
    return { ok: true };
  },
  // ひとことチャット（出題中は送れない）
  chat(body) {
    const { room, me } = auth(body);
    if (!me) return { ok: false };
    if (room.phase === 'question') return { ok: false, error: '出題中はチャットを送れません。' };
    const text = String(body.text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, CHAT_MAX);
    if (!text) return { ok: false };
    const now = Date.now();
    if (now - (me.lastChat || 0) < CHAT_GAP_MS) return { ok: false, error: '少し待ってから送信してください。' };
    me.lastChat = now;
    room.chat = room.chat || [];
    room.chat.push({ i: rand(4), id: me.id, name: me.name, avatar: me.avatar || 0, color: me.color || 0, text, t: now });
    if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
    broadcast(room);
    return { ok: true };
  },
  // リアクションスタンプ：ルームのみんなの画面に飛ばす（記録はしない）
  react(body) {
    const { room, me } = auth(body);
    const k = Number(body.k);
    if (!me || !(k >= 0 && k < REACTIONS.length)) return { ok: false };
    const now = Date.now();
    if (now - (me.lastReact || 0) < REACTION_GAP_MS) return { ok: false };
    me.lastReact = now;
    const data = { id: me.id, name: me.name, k, team: me.team || null, avatar: me.avatar || 0, color: me.color || 0 };
    for (const p of room.players.values()) for (const res of p.streams) send(res, 'react', data);
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

/* ---------- 再起動しても続けられるようにする ---------- */
// サーバーを更新（再起動）すると、メモリにあるルームは消えてしまう。
// そこでルームの状態を暗号化して参加者のブラウザに預けておき、再起動後に返してもらって元に戻す。
// 暗号の鍵は Render の環境変数 QUIZ_SECRET に登録しておくと安全（なくても動く）。
const SECRET_KEY = crypto.createHash('sha256').update(process.env.QUIZ_SECRET || 'minna-no-quiz-taikai-default-key').digest();

function sealSnapshot(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const body = Buffer.concat([cipher.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(obj)))), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}
function openSnapshot(blob) {
  try {
    const buf = Buffer.from(String(blob || ''), 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
    return JSON.parse(zlib.inflateRawSync(plain).toString());
  } catch {
    return null; // 鍵がちがう・書きかえられている・こわれている
  }
}
// ルームを保存用のデータにする（時間は「あと何ミリ秒」「何ミリ秒たった」の形で持つ）
function snapshotOf(room) {
  const now = Date.now();
  return {
    v: 1,
    savedAt: now,
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    settings: room.settings,
    config: room.config,
    votes: [...room.votes.entries()],
    ready: [...(room.ready || [])],
    players: [...room.players.values()].map((p) => ({
      id: p.id, token: p.token, name: p.name, bot: !!p.bot, level: p.level, score: p.score, gain: p.gain, team: p.team, joinedAt: p.joinedAt,
      userId: p.userId || null, seen: p.seen || 0, correct: p.correct || 0, streak: p.streak || 0, bonus: p.bonus || 0,
      avatar: p.avatar || 0, color: p.color || 0, spectator: !!p.spectator,
    })),
    questions: room.questions,
    qIndex: room.qIndex,
    answers: [...room.answers.entries()],
    buzzWinner: room.buzzWinner,
    hideFrom: room.hideFrom,
    forcedSolo: room.forcedSolo,
    lastTally: room.lastTally,
    recorded: room.recorded || null,
    chat: room.chat || [],
    qElapsedMs: room.phase === 'question' ? now - room.qStartedAt : 0,
    qRemainingMs: room.phase === 'question' ? Math.max(0, room.deadline - now) : 0,
    revealRemainingMs: room.phase === 'reveal' ? Math.max(0, room.revealEndsAt - now) : 0,
    decidedElapsedMs: room.phase === 'decided' ? now - room.decidedAt : 0,
    decidedMs: room.decidedMs,
    finalElapsedMs: room.phase === 'final' ? now - room.finalAt : 0,
  };
}
// 保存データからルームを作り直し、止まったところから続ける
function restoreRoom(snap) {
  const now = Date.now();
  const room = {
    code: snap.code, hostId: snap.hostId, phase: snap.phase, settings: snap.settings, config: snap.config,
    votes: new Map(snap.votes || []), ready: new Set(snap.ready || []),
    players: new Map(), questions: snap.questions || [], qIndex: snap.qIndex || 0,
    answers: new Map(snap.answers || []), buzzWinner: snap.buzzWinner || null,
    hideFrom: snap.hideFrom, forcedSolo: snap.forcedSolo, lastTally: snap.lastTally, recorded: snap.recorded || null, chat: snap.chat || [],
    botTimers: [], lastActive: now, restoredAt: now,
  };
  for (const p of snap.players || []) room.players.set(p.id, { ...p, streams: new Set() });
  rooms.set(room.code, room);
  if (room.phase === 'decided') {
    room.decidedMs = snap.decidedMs || DECIDED_MS;
    room.decidedAt = now - (snap.decidedElapsedMs || 0);
    room.timer = setTimeout(() => startGame(room), Math.max(1500, room.decidedMs - (snap.decidedElapsedMs || 0)));
  } else if (room.phase === 'question') {
    // 残り時間はそのまま（止まっていたあいだは数えない）＋少しおまけ
    room.qStartedAt = now - (snap.qElapsedMs || 0);
    room.deadline = now + (snap.qRemainingMs || 0) + RESUME_GRACE_MS;
    room.timer = setTimeout(() => reveal(room), room.deadline - now + GRACE_MS);
    if (room.buzzWinner) { clearTimeout(room.timer); room.timer = setTimeout(() => reveal(room), 800); }
    else scheduleBots(room, snap.qElapsedMs || 0);
  } else if (room.phase === 'reveal') {
    room.revealEndsAt = now + Math.max(2500, snap.revealRemainingMs || 0);
    room.timer = setTimeout(() => advance(room), room.revealEndsAt - now);
  } else if (room.phase === 'final') {
    room.finalAt = now - Math.max(snap.finalElapsedMs || 0, 60000); // 結果発表の演出はくり返さない
  }
  console.log(`ルーム ${room.code} を再開しました（${room.phase}）`);
  return room;
}

// 画面のバージョン。ファイルが変わると変わる（開いている画面が古ければ自動で読みこみ直す）
const VERSION = (() => {
  const h = crypto.createHash('sha1');
  for (const f of [__filename, path.join(__dirname, 'questions.js'), path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')]) {
    try { h.update(fs.readFileSync(f)); } catch {}
  }
  return h.digest('hex').slice(0, 10);
})();

/* ---------- HTTP ---------- */
// 画面のファイルは public フォルダの中か、server.js と同じ場所のどちらに置いてあっても動くようにする
const INDEX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')]
  .find((p) => fs.existsSync(p)) || path.join(__dirname, 'public', 'index.html');

// アップデート情報（updates.json）。public フォルダの中か server.js と同じ場所に置く
const UPDATES = [path.join(__dirname, 'updates.json'), path.join(__dirname, 'public', 'updates.json')];
function sendUpdates(res) {
  const file = UPDATES.find((p) => fs.existsSync(p));
  if (!file) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end('[]'); return; }
  fs.readFile(file, 'utf8', (err, text) => {
    let list = [];
    try { list = JSON.parse(text); } catch { list = []; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(Array.isArray(list) ? list : []));
  });
}

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
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 512 * 1024) req.destroy(); });
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
      res.end(buf.toString().replace('__APP_VERSION__', VERSION));
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/events') return openStream(req, res, url);
  if (req.method === 'GET' && url.pathname === '/healthz') { res.end('ok'); return; }
  if (req.method === 'GET' && url.pathname === '/updates.json') return sendUpdates(res);
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5);
    const table = name.startsWith('account/') ? ((accounts && accounts.actions) || {}) : actions;
    const key = name.startsWith('account/') ? name.slice(8) : name;
    const fn = Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
    const body = await readJson(req);
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    let out;
    try { out = fn ? await fn(body, ip) : { ok: false }; }
    catch (e) { console.error(e); out = { ok: false, error: '処理に失敗しました。もう一度お試しください。' }; }
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
  // 意見箱の送信回数の記録を片づける
  for (const [ip, list] of feedbackLog) if (!list.some((t) => now - t < FEEDBACK_LIMIT.windowMs)) feedbackLog.delete(ip);
}, 60 * 1000).unref();

// 更新で止められるとき：みんなに最新の保存データと「更新中」の合図を送ってから終わる
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const room of rooms.values()) {
    clearTimers(room);
    const snap = sealSnapshot(snapshotOf(room));
    for (const p of room.players.values()) for (const res of p.streams) { try { send(res, 'restart', { snap }); } catch {} }
  }
  setTimeout(() => {
    for (const room of rooms.values()) for (const p of room.players.values()) for (const res of p.streams) { try { res.end(); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }, 500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`クイズ大会サーバー起動: http://localhost:${PORT}（バージョン ${VERSION}）`);
  console.log(FEEDBACK_FORM ? '意見箱: Google フォームに転送します' : '意見箱: FEEDBACK_FORM_URL が未設定のため、届いた意見はログに出すだけです');
});
