const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const https = require('https');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Config ────────────────────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DISABLE_SCHEDULE = [
  { after: 6,  seconds: 60 },
  { after: 7,  seconds: 300 },
  { after: 8,  seconds: 900 },
  { after: 9,  seconds: 3600 },
  { after: 10, seconds: 7200 },
  { after: 11, seconds: 14400 },
];

// ── Moderation ────────────────────────────────────────────────────────────────

function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/ph/g, 'f')
    .replace(/kn/g, 'n')
    .replace(/ck/g, 'k')
    .replace(/@/g, 'a')
    .replace(/3/g, 'e')
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/\$/g, 's')
    .replace(/5/g, 's')
    .replace(/!/g, 'i')
    .replace(/\+/g, 't')
    .replace(/[-_.*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function moderateName(name) {
  if (!OPENAI_API_KEY) return { ok: true };

  const normalized = normalizeText(name);
  const prompt = `Is the following player display name offensive, a slur, or hate speech — including deliberate misspellings or phonetic substitutions? Reply with only "yes" or "no".\n\nName: "${name}"\nNormalized: "${normalized}"`;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 3,
      temperature: 0,
    });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const reply = json.choices?.[0]?.message?.content?.trim().toLowerCase() || '';
          if (reply.startsWith('yes')) {
            resolve({ ok: false, reason: 'Name not allowed.' });
          } else {
            resolve({ ok: true });
          }
        } catch {
          resolve({ ok: true });
        }
      });
    });

    req.on('error', () => resolve({ ok: true }));
    req.setTimeout(5000, () => { req.destroy(); resolve({ ok: true }); });
    req.write(body);
    req.end();
  });
}

// ── Game State ────────────────────────────────────────────────────────────────

let round = {
  number: 1,
  password: generatePassword(),
  startedAt: Date.now(),
  winner: null,
  totalGuesses: 0,
};

const players = new Map();

function generatePassword() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function getDisableSeconds(attempts) {
  for (let i = DISABLE_SCHEDULE.length - 1; i >= 0; i--) {
    if (attempts >= DISABLE_SCHEDULE[i].after) {
      return DISABLE_SCHEDULE[i].seconds;
    }
  }
  return 0;
}

function getPlayerState(socketId) {
  if (!players.has(socketId)) {
    players.set(socketId, { attempts: 0, disabledUntil: null, name: null, guessed: new Set() });
  }
  return players.get(socketId);
}

function getPlayerList() {
  const now = Date.now();
  const list = [];
  for (const [id, p] of players) {
    if (p.name) {
      list.push({
        id,
        name: p.name,
        attempts: p.attempts,
        lockedOut: !!(p.disabledUntil && p.disabledUntil > now),
      });
    }
  }
  return list;
}

function getStats() {
  const online = io.engine.clientsCount;
  let lockedOut = 0;
  const now = Date.now();
  for (const [, p] of players) {
    if (p.disabledUntil && p.disabledUntil > now) lockedOut++;
  }
  return {
    online,
    lockedOut,
    totalGuesses: round.totalGuesses,
    roundNumber: round.number,
    roundStartedAt: round.startedAt,
  };
}

function startNewRound() {
  round = {
    number: round.number + 1,
    password: generatePassword(),
    startedAt: Date.now(),
    winner: null,
    totalGuesses: 0,
  };
  for (const [, p] of players) {
    p.attempts = 0;
    p.disabledUntil = null;
    p.guessed = new Set();
  }
  console.log(`Round ${round.number} — password: ${round.password}`);
}

function broadcastNewRound() {
  for (const [id, sock] of io.sockets.sockets) {
    const ps = getPlayerState(id);
    sock.emit('new_round', {
      stats: getStats(),
      playerState: { attempts: ps.attempts, disabledUntil: ps.disabledUntil },
      roundNumber: round.number,
      players: getPlayerList(),
    });
  }
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const player = getPlayerState(socket.id);

  socket.emit('init', {
    stats: getStats(),
    playerState: { attempts: player.attempts, disabledUntil: player.disabledUntil },
    roundNumber: round.number,
    players: getPlayerList(),
  });

  io.emit('stats', getStats());
  io.emit('players', getPlayerList());

  socket.on('set_name', async (rawName) => {
    if (typeof rawName !== 'string') return;
    const name = rawName.replace(/[^a-zA-Z0-9 '_\-.]/g, '').trim().slice(0, 20);
    if (name.length < 1) {
      socket.emit('name_rejected', { reason: 'Name too short.' });
      return;
    }
    const mod = await moderateName(name);
    if (!mod.ok) {
      socket.emit('name_rejected', { reason: mod.reason || 'Name not allowed.' });
      return;
    }
    player.name = name;
    socket.emit('name_accepted', { name });
    io.emit('players', getPlayerList());
  });

  socket.on('guess', (code) => {
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return;
    if (round.winner) return;
    if (!player.name) return;

    const now = Date.now();

    if (player.disabledUntil && player.disabledUntil > now) {
      socket.emit('disabled', { until: player.disabledUntil, attempts: player.attempts });
      return;
    }

    if (player.disabledUntil && player.disabledUntil <= now) {
      player.disabledUntil = null;
    }

    if (player.guessed.has(code)) {
      socket.emit('wrong', { attempts: player.attempts, disabledUntil: player.disabledUntil, duplicate: true });
      return;
    }

    player.guessed.add(code);
    round.totalGuesses++;
    player.attempts++;

    if (code === round.password) {
      round.winner = socket.id;
      socket.emit('correct', { password: round.password });
      io.emit('round_won', {
        roundNumber: round.number,
        totalGuesses: round.totalGuesses,
        winnerName: player.name,
        password: round.password,
        stats: getStats(),
      });

      setTimeout(() => {
        startNewRound();
        broadcastNewRound();
      }, 8000);

    } else {
      const disableSeconds = getDisableSeconds(player.attempts);
      if (disableSeconds > 0) {
        player.disabledUntil = now + disableSeconds * 1000;
      }
      let correct = 0;
      for (let i = 0; i < 4; i++) {
        if (code[i] === round.password[i]) correct++;
      }
      socket.emit('wrong', { attempts: player.attempts, disabledUntil: player.disabledUntil, correct });
    }

    io.emit('stats', getStats());
    io.emit('players', getPlayerList());
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('stats', getStats());
    io.emit('players', getPlayerList());
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Lockscreen Game running on http://localhost:${PORT}`);
  console.log(`Round ${round.number} — password: ${round.password}`);
});
