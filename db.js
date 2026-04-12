const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.sqlite');

let db;

async function init() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
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
  `);

  try { db.run(`CREATE INDEX IF NOT EXISTS idx_guesses_round_id ON guesses(round_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_guesses_player_id ON guesses(player_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_lockouts_player_id ON lockouts(player_id)`); } catch {}
  try { db.run(`CREATE INDEX IF NOT EXISTS idx_rounds_winner_player_id ON rounds(winner_player_id)`); } catch {}

  save();
}

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

// Auto-save every 30 seconds
setInterval(() => { if (db) save(); }, 30000);

function run(sql, params = []) {
  db.run(sql, params);
  save();
}

function get(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function initRound(round) {
  try {
    run(`INSERT OR IGNORE INTO rounds (round_number, password, started_at, total_guesses) VALUES (?, ?, ?, 0)`,
      [round.number, round.password, round.startedAt]);
  } catch {}
}

function touchPlayer(id, name = null) {
  const now = Date.now();
  const existing = get(`SELECT id FROM players WHERE id = ?`, [id]);
  if (existing) {
    if (name) {
      run(`UPDATE players SET name = ?, last_seen_at = ? WHERE id = ?`, [name, now, id]);
    } else {
      run(`UPDATE players SET last_seen_at = ? WHERE id = ?`, [now, id]);
    }
  } else {
    run(`INSERT INTO players (id, name, created_at, last_seen_at) VALUES (?, ?, ?, ?)`, [id, name, now, now]);
  }
}

function setPlayerName(id, name) {
  run(`UPDATE players SET name = ?, last_seen_at = ? WHERE id = ?`, [name, Date.now(), id]);
}

function getRoundId(roundNumber) {
  const row = get(`SELECT id FROM rounds WHERE round_number = ?`, [roundNumber]);
  return row?.id;
}

function recordGuess({ roundNumber, playerId, playerName, isCorrect, correctDigits, guessedAt, totalGuesses }) {
  const roundId = getRoundId(roundNumber);
  if (!roundId) return;
  run(`INSERT INTO guesses (round_id, round_number, player_id, player_name, is_correct, correct_digits, guessed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [roundId, roundNumber, playerId, playerName || null, isCorrect ? 1 : 0, correctDigits || 0, guessedAt]);
  run(`UPDATE rounds SET total_guesses = ? WHERE round_number = ?`, [totalGuesses, roundNumber]);
}

function recordLockout({ roundNumber, playerId, playerName, attemptCountTrigger, startedAt, endedAt, durationSeconds }) {
  const roundId = getRoundId(roundNumber);
  if (!roundId) return;
  run(`INSERT INTO lockouts (round_id, round_number, player_id, player_name, attempt_count_trigger, started_at, ended_at, duration_seconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [roundId, roundNumber, playerId, playerName || null, attemptCountTrigger, startedAt, endedAt, durationSeconds]);
}

function finishRound({ roundNumber, winnerPlayerId, endedAt, totalGuesses }) {
  run(`UPDATE rounds SET ended_at = ?, winner_player_id = ?, total_guesses = ? WHERE round_number = ?`,
    [endedAt, winnerPlayerId, totalGuesses, roundNumber]);
}

function getOverview() {
  const totals = get(`
    SELECT
      (SELECT COUNT(*) FROM players) AS totalPlayers,
      (SELECT COUNT(*) FROM rounds) AS totalRounds,
      (SELECT COUNT(*) FROM guesses) AS totalGuesses,
      (SELECT COUNT(*) FROM guesses WHERE is_correct = 1) AS totalCracks,
      (SELECT COALESCE(SUM(duration_seconds), 0) FROM lockouts) AS totalLockoutSeconds,
      (SELECT COUNT(*) FROM lockouts) AS totalLockouts,
      (SELECT ROUND(AVG(CASE WHEN ended_at IS NOT NULL THEN (ended_at - started_at) / 1000.0 END), 1) FROM rounds) AS avgRoundSeconds
  `) || {};

  const recentWinners = all(`
    SELECT r.round_number, r.total_guesses, r.started_at, r.ended_at, COALESCE(p.name, 'Unknown') AS winner_name
    FROM rounds r
    LEFT JOIN players p ON p.id = r.winner_player_id
    WHERE r.winner_player_id IS NOT NULL
    ORDER BY r.round_number DESC
    LIMIT 10
  `);

  return { ...totals, recentWinners };
}

function getLeaderboardWinners(limit = 50) {
  return all(`
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
  `, [limit]);
}

function getLeaderboardCrackers(limit = 50) {
  return all(`
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
  `, [limit]);
}

function getLeaderboardLockouts(limit = 50) {
  return all(`
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
  `, [limit]);
}

function getRecentRounds(limit = 25) {
  return all(`
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
  `, [limit]);
}

function getPlayerStats(limit = 100) {
  return all(`
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
  `, [limit]);
}

module.exports = {
  init,
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
