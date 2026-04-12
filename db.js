const path = require('path');
const Database = require('better-sqlite3');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_number INTEGER NOT NULL UNIQUE,
  password TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  winner_player_id TEXT,
  total_guesses INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS guesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT,
  is_correct INTEGER NOT NULL DEFAULT 0,
  correct_digits INTEGER NOT NULL DEFAULT 0,
  guessed_at INTEGER NOT NULL,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

CREATE TABLE IF NOT EXISTS lockouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  player_id TEXT NOT NULL,
  player_name TEXT,
  attempt_count_trigger INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  FOREIGN KEY(round_id) REFERENCES rounds(id)
);

CREATE INDEX IF NOT EXISTS idx_guesses_round_id ON guesses(round_id);
CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id);
CREATE INDEX IF NOT EXISTS idx_lockouts_player_id ON lockouts(player_id);
CREATE INDEX IF NOT EXISTS idx_rounds_winner_player_id ON rounds(winner_player_id);
`);

const statements = {
  upsertPlayer: db.prepare(`
    INSERT INTO players (id, name, created_at, last_seen_at)
    VALUES (@id, @name, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, players.name),
      last_seen_at = excluded.last_seen_at
  `),
  updatePlayerName: db.prepare(`
    UPDATE players
    SET name = ?, last_seen_at = ?
    WHERE id = ?
  `),
  insertRound: db.prepare(`
    INSERT OR IGNORE INTO rounds (round_number, password, started_at, total_guesses)
    VALUES (?, ?, ?, 0)
  `),
  getRoundByNumber: db.prepare(`SELECT * FROM rounds WHERE round_number = ?`),
  updateRoundGuessCount: db.prepare(`UPDATE rounds SET total_guesses = ? WHERE round_number = ?`),
  finishRound: db.prepare(`
    UPDATE rounds
    SET ended_at = ?, winner_player_id = ?, total_guesses = ?
    WHERE round_number = ?
  `),
  insertGuess: db.prepare(`
    INSERT INTO guesses (round_id, round_number, player_id, player_name, is_correct, correct_digits, guessed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  insertLockout: db.prepare(`
    INSERT INTO lockouts (round_id, round_number, player_id, player_name, attempt_count_trigger, started_at, ended_at, duration_seconds)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
};

function initRound(round) {
  statements.insertRound.run(round.number, round.password, round.startedAt);
}

function touchPlayer(id, name = null) {
  statements.upsertPlayer.run({ id, name, now: Date.now() });
}

function setPlayerName(id, name) {
  statements.updatePlayerName.run(name, Date.now(), id);
}

function getRoundId(roundNumber) {
  return statements.getRoundByNumber.get(roundNumber)?.id;
}

function recordGuess({ roundNumber, playerId, playerName, isCorrect, correctDigits, guessedAt, totalGuesses }) {
  const roundId = getRoundId(roundNumber);
  if (!roundId) return;
  statements.insertGuess.run(roundId, roundNumber, playerId, playerName || null, isCorrect ? 1 : 0, correctDigits || 0, guessedAt);
  statements.updateRoundGuessCount.run(totalGuesses, roundNumber);
}

function recordLockout({ roundNumber, playerId, playerName, attemptCountTrigger, startedAt, endedAt, durationSeconds }) {
  const roundId = getRoundId(roundNumber);
  if (!roundId) return;
  statements.insertLockout.run(roundId, roundNumber, playerId, playerName || null, attemptCountTrigger, startedAt, endedAt, durationSeconds);
}

function finishRound({ roundNumber, winnerPlayerId, endedAt, totalGuesses }) {
  statements.finishRound.run(endedAt, winnerPlayerId, totalGuesses, roundNumber);
}

function getOverview() {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM players) AS totalPlayers,
      (SELECT COUNT(*) FROM rounds) AS totalRounds,
      (SELECT COUNT(*) FROM guesses) AS totalGuesses,
      (SELECT COUNT(*) FROM guesses WHERE is_correct = 1) AS totalCracks,
      (SELECT COALESCE(SUM(duration_seconds), 0) FROM lockouts) AS totalLockoutSeconds,
      (SELECT COUNT(*) FROM lockouts) AS totalLockouts,
      (SELECT ROUND(AVG(CASE WHEN ended_at IS NOT NULL THEN (ended_at - started_at) / 1000.0 END), 1) FROM rounds) AS avgRoundSeconds
  `).get();

  const recentWinners = db.prepare(`
    SELECT r.round_number, r.total_guesses, r.started_at, r.ended_at, COALESCE(p.name, 'Unknown') AS winner_name
    FROM rounds r
    LEFT JOIN players p ON p.id = r.winner_player_id
    WHERE r.winner_player_id IS NOT NULL
    ORDER BY r.round_number DESC
    LIMIT 10
  `).all();

  return { ...totals, recentWinners };
}

function getLeaderboardWinners(limit = 50) {
  return db.prepare(`
    SELECT
      p.id AS playerId,
      COALESCE(p.name, 'Unknown') AS playerName,
      COUNT(r.id) AS roundsWon,
      COALESCE(ROUND(AVG((r.ended_at - r.started_at) / 1000.0), 1), 0) AS avgWinSeconds,
      MIN((r.ended_at - r.started_at) / 1000.0) AS fastestWinSeconds,
      MAX(r.ended_at) AS lastWinAt
    FROM rounds r
    JOIN players p ON p.id = r.winner_player_id
    WHERE r.winner_player_id IS NOT NULL
    GROUP BY p.id, p.name
    ORDER BY roundsWon DESC, fastestWinSeconds ASC, lastWinAt DESC
    LIMIT ?
  `).all(limit);
}

function getLeaderboardCrackers(limit = 50) {
  return db.prepare(`
    SELECT
      g.player_id AS playerId,
      COALESCE(p.name, g.player_name, 'Unknown') AS playerName,
      SUM(CASE WHEN g.is_correct = 1 THEN 1 ELSE 0 END) AS passwordsCracked,
      COUNT(g.id) AS totalGuesses,
      ROUND(100.0 * SUM(CASE WHEN g.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(g.id), 2) AS crackRate,
      COALESCE(ROUND(AVG(CASE WHEN g.is_correct = 1 THEN (r.ended_at - r.started_at) / 1000.0 END), 1), 0) AS avgCrackSeconds,
      MIN(CASE WHEN g.is_correct = 1 THEN (r.ended_at - r.started_at) / 1000.0 END) AS fastestCrackSeconds
    FROM guesses g
    LEFT JOIN players p ON p.id = g.player_id
    LEFT JOIN rounds r ON r.id = g.round_id
    GROUP BY g.player_id, COALESCE(p.name, g.player_name, 'Unknown')
    HAVING passwordsCracked > 0
    ORDER BY passwordsCracked DESC, crackRate DESC, avgCrackSeconds ASC
    LIMIT ?
  `).all(limit);
}

function getLeaderboardLockouts(limit = 50) {
  return db.prepare(`
    SELECT
      l.player_id AS playerId,
      COALESCE(p.name, l.player_name, 'Unknown') AS playerName,
      COUNT(l.id) AS lockoutCount,
      COALESCE(SUM(l.duration_seconds), 0) AS totalLockoutSeconds,
      COALESCE(ROUND(AVG(l.duration_seconds), 1), 0) AS avgLockoutSeconds,
      COALESCE(MAX(l.duration_seconds), 0) AS longestLockoutSeconds,
      MAX(l.ended_at) AS lastLockoutEndedAt
    FROM lockouts l
    LEFT JOIN players p ON p.id = l.player_id
    GROUP BY l.player_id, COALESCE(p.name, l.player_name, 'Unknown')
    ORDER BY totalLockoutSeconds DESC, longestLockoutSeconds DESC, lockoutCount DESC
    LIMIT ?
  `).all(limit);
}

function getRecentRounds(limit = 25) {
  return db.prepare(`
    SELECT
      r.round_number AS roundNumber,
      r.total_guesses AS totalGuesses,
      r.started_at AS startedAt,
      r.ended_at AS endedAt,
      COALESCE(p.name, 'Unknown') AS winnerName,
      CASE WHEN r.ended_at IS NOT NULL THEN ROUND((r.ended_at - r.started_at) / 1000.0, 1) ELSE NULL END AS durationSeconds
    FROM rounds r
    LEFT JOIN players p ON p.id = r.winner_player_id
    ORDER BY r.round_number DESC
    LIMIT ?
  `).all(limit);
}

function getPlayerStats(limit = 100) {
  return db.prepare(`
    SELECT
      p.id AS playerId,
      COALESCE(p.name, 'Unknown') AS playerName,
      p.last_seen_at AS lastSeenAt,
      COALESCE(g.totalGuesses, 0) AS totalGuesses,
      COALESCE(w.roundsWon, 0) AS roundsWon,
      COALESCE(c.passwordsCracked, 0) AS passwordsCracked,
      COALESCE(l.lockoutCount, 0) AS lockoutCount,
      COALESCE(l.totalLockoutSeconds, 0) AS totalLockoutSeconds,
      COALESCE(l.longestLockoutSeconds, 0) AS longestLockoutSeconds
    FROM players p
    LEFT JOIN (
      SELECT player_id, COUNT(*) AS totalGuesses
      FROM guesses
      GROUP BY player_id
    ) g ON g.player_id = p.id
    LEFT JOIN (
      SELECT winner_player_id AS player_id, COUNT(*) AS roundsWon
      FROM rounds
      WHERE winner_player_id IS NOT NULL
      GROUP BY winner_player_id
    ) w ON w.player_id = p.id
    LEFT JOIN (
      SELECT player_id, SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS passwordsCracked
      FROM guesses
      GROUP BY player_id
    ) c ON c.player_id = p.id
    LEFT JOIN (
      SELECT player_id, COUNT(*) AS lockoutCount, SUM(duration_seconds) AS totalLockoutSeconds, MAX(duration_seconds) AS longestLockoutSeconds
      FROM lockouts
      GROUP BY player_id
    ) l ON l.player_id = p.id
    ORDER BY roundsWon DESC, passwordsCracked DESC, totalGuesses DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  initRound,
  touchPlayer,
  setPlayerName,
  recordGuess,
  recordLockout,
  finishRound,
  getOverview,
  getLeaderboardWinners,
  getLeaderboardCrackers,
  getLeaderboardLockouts,
  getRecentRounds,
  getPlayerStats,
};
