const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ── Game State ────────────────────────────────────────────────────────────────

const DISABLE_SCHEDULE = [
  { after: 6,  seconds: 60 },
  { after: 7,  seconds: 300 },
  { after: 8,  seconds: 900 },
  { after: 9,  seconds: 3600 },
  { after: 10, seconds: 7200 },
  { after: 11, seconds: 14400 },
];

let round = {
  number: 1,
  password: generatePassword(),
  startedAt: Date.now(),
  winner: null,
  totalGuesses: 0,
};

// Per-player state keyed by socket id
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
    players.set(socketId, {
      attempts: 0,
      disabledUntil: null,
    });
  }
  return players.get(socketId);
}

function getStats() {
  let online = io.engine.clientsCount;
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
  // Reset all player states
  for (const [, p] of players) {
    p.attempts = 0;
    p.disabledUntil = null;
  }
  console.log(`Round ${round.number} — password: ${round.password}`);
}

// ── Socket.IO ─────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  const player = getPlayerState(socket.id);

  // Send initial state
  socket.emit('init', {
    stats: getStats(),
    playerState: {
      attempts: player.attempts,
      disabledUntil: player.disabledUntil,
    },
    roundNumber: round.number,
  });

  // Broadcast updated player count
  io.emit('stats', getStats());

  socket.on('guess', (code) => {
    // Validate input
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) return;
    if (round.winner) return;

    const p = getPlayerState(socket.id);
    const now = Date.now();

    // Check if player is disabled
    if (p.disabledUntil && p.disabledUntil > now) {
      socket.emit('disabled', {
        until: p.disabledUntil,
        attempts: p.attempts,
      });
      return;
    }

    // Clear expired disable
    if (p.disabledUntil && p.disabledUntil <= now) {
      p.disabledUntil = null;
    }

    round.totalGuesses++;
    p.attempts++;

    if (code === round.password) {
      // Winner!
      round.winner = socket.id;
      socket.emit('correct', { password: round.password });
      io.emit('round_won', {
        roundNumber: round.number,
        totalGuesses: round.totalGuesses,
        stats: getStats(),
      });

      // Start new round after 8 seconds
      setTimeout(() => {
        startNewRound();
        // Reset all connected players
        for (const [id] of players) {
          const sock = io.sockets.sockets.get(id);
          if (sock) {
            const ps = getPlayerState(id);
            sock.emit('new_round', {
              stats: getStats(),
              playerState: {
                attempts: ps.attempts,
                disabledUntil: ps.disabledUntil,
              },
              roundNumber: round.number,
            });
          }
        }
      }, 8000);

    } else {
      // Wrong guess
      const disableSeconds = getDisableSeconds(p.attempts);
      if (disableSeconds > 0) {
        p.disabledUntil = now + disableSeconds * 1000;
      }

      socket.emit('wrong', {
        attempts: p.attempts,
        disabledUntil: p.disabledUntil,
      });
    }

    // Broadcast stats
    io.emit('stats', getStats());
  });

  socket.on('disconnect', () => {
    players.delete(socket.id);
    io.emit('stats', getStats());
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`iPad Lockscreen Game running on http://localhost:${PORT}`);
  console.log(`Round ${round.number} — password: ${round.password}`);
});
