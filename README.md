# Lockscreen Game

Massively multiplayer iPad lockscreen guessing game built with Node.js, Express, and Socket.IO.

## What It Does

Players join with a display name, enter 4-digit guesses on an iPad-style lockscreen, and race to crack the current passcode before someone else does. The server tracks a shared round, broadcasts live player and guess stats, and starts a new round automatically after a win.

## Features

- Real-time multiplayer updates over Socket.IO
- Persistent player identity via `localStorage`
- Per-player lockout timers that survive refreshes
- Duplicate-guess prevention within a round
- Winner overlay with automatic next-round countdown
- Live player list and round stats
- Single-tab guard using `BroadcastChannel`
- Multi-language UI support
- Optional OpenAI-backed display-name moderation

## Stack

- Node.js 18+
- Express
- Socket.IO
- Static frontend in [`public/index.html`](/Users/josephruocco/ipad-lockscreen-game/public/index.html)
- Server in [`server.js`](/Users/josephruocco/ipad-lockscreen-game/server.js)

## Run Locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Environment Variables

- `PORT`: Server port. Defaults to `3000`.
- `OPENAI_API_KEY`: Optional. If set, player display names are checked for offensive/slur content before acceptance. If unset, name moderation is skipped.

## Game Rules

- Each round uses a random 4-digit passcode.
- Guesses must be exactly 4 digits.
- A player's repeated guess in the same round is rejected.
- Lockout escalates based on failed attempts:
  - After 6 attempts: 60 seconds
  - After 7 attempts: 5 minutes
  - After 8 attempts: 15 minutes
  - After 9 attempts: 1 hour
  - After 10 attempts: 2 hours
  - After 11 attempts: 4 hours
- When someone wins, the passcode is revealed and the next round begins 8 seconds later.

## Deployment

The repo includes [`render.yaml`](/Users/josephruocco/ipad-lockscreen-game/render.yaml) for deployment on Render.

## Notes

- There is no test suite in this repo right now.
- The current server keeps game state in memory, so restarting the process resets the active round and connected player session state.
