# Privacy Policy

_Last updated: April 20, 2026_

Lockscreen Game is a small multiplayer browser game. It's free, there are no ads, and we don't want your data. This page is short on purpose.

## The short version

- No account. No email. No sign-up.
- No advertising, no advertising trackers, no third-party analytics.
- We don't sell, share, or rent any data about you. There's nothing to sell.
- The only things we store are the things we need to run a game of guessing 4-digit codes: a display name you choose, a random browser ID, your guesses, and how long you've been locked out.

If that's all you wanted to know, you can stop reading.

## What is stored in your browser

When you open the game, your browser saves two things in its own local storage:

- **`playerId`** — a random ID (a UUID) generated in your browser the first time you visit. It lets the server remember you across refreshes and enforce lockout timers. It is not linked to your real identity and we never try to link it to one.
- **`playerName`** — the display name you typed in, so we can show it back to you on reload.

Both live on your device. Clear your browser storage for this site and they're gone. There's no fingerprinting, no ad ID, no cross-site tracking, no cookies used for tracking.

## What is stored on the server

To run the game we keep a small SQLite database with:

- Your `playerId` and the display name you chose.
- The guesses you submit (the four-digit code, whether it was correct, how many digits matched, and when).
- Lockout records (when a lockout started and ended, and how many failed attempts triggered it).
- Round metadata (round number, passcode, start/end time, winner).
- First-seen and last-seen timestamps for your `playerId`.

We don't store your IP address, email, phone number, location, device fingerprint, or anything tied to your real-world identity, because we never ask for any of that.

Our hosting provider (Render) keeps standard server access logs for operational reasons (uptime, abuse, security). We do not use those logs for analytics or advertising.

## Display-name moderation

If the operator has configured an OpenAI API key, the display name you submit is sent to OpenAI's moderation endpoint to check whether it's a slur or hate speech. Only the name itself is sent — not your guesses, not your `playerId`. If no key is configured, this step is skipped entirely. OpenAI's use of data is governed by their own [privacy policy](https://openai.com/policies/privacy-policy).

## What we don't do

- No ads.
- No advertising trackers, no Google Analytics, no Facebook Pixel, no Segment, Mixpanel, or similar.
- No selling or sharing of player data with any third party.
- No marketing emails — we don't have your email.
- No training of AI models on your gameplay.

## Leaderboards and public visibility

Your chosen display name, your aggregate stats (rounds won, guesses, total lockout time), and recent round results appear on public leaderboards inside the game. Don't use your real name as your display name if that bothers you — use a nickname. You can change it by clearing site data and picking a new one.

## Children

The game doesn't knowingly collect any information from children under 13 beyond the display name and gameplay data described above. If you're a parent or guardian and want us to delete a specific `playerId`'s data, contact us (see below) and we'll remove it.

## Data deletion

Because there's no account, the simplest way to wipe your data on your end is:

1. Clear the site's local storage in your browser. That deletes your `playerId` and `playerName` from your device.
2. If you also want your historical records (guesses, lockouts, leaderboard entries) removed from the server database, email us the old `playerId` and we'll delete it.

## Changes to this policy

If we ever change what we collect, we'll update this page and the "Last updated" date at the top. If a change is significant (for example, introducing any form of tracking or third-party sharing), we'll put a visible notice on the game itself.

## Contact

Questions or deletion requests: [josephruocco.net/contact](https://josephruocco.net/contact)
