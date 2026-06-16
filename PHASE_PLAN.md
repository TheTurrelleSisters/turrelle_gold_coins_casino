# Gold Coins Casino Lobby — Phase Plan
## Repo: turrelle_gold_coins_casino
## Source of truth: zip archives. GitHub is behind.

---

## Current Version: v3.3 (cache: lobby-v3.3)

---

## Repo Overview
Casino lobby PWA. Age gate + nickname entry. Shows all 5 game cards with live
progressive jackpot display. Reads from Supabase `progressive` table (id=1).
Broadcasts progressive hit celebrations to lobby visitors.

---

## Stack
- Vanilla ES5 JS inline in index.html
- Supabase: gdmmoeggkqsvqnqyrubx.supabase.co (legacy JWT anon key)
- Service worker: lobby-v3.3
- Key files: index.html, service-worker.js, manifest.json
- progressive.js in root is UNUSED — not loaded by index.html, dead file

---

## Phase History

### v3.0–v3.2 — Foundation
- Age gate + nickname flow
- 5-game carousel with progressive jackpot display
- Live progressive value via Supabase postgres_changes subscription
- Progressive hit celebration overlay (video + amount)
- Install prompt (Android + iOS)
- Operator message banner via broadcast_messages table
- Service worker: lobby-v3.2

### v3.3 — Service Worker Hardening (this session)
- Added non-GET request guard (POST/PATCH/PUT/DELETE never intercepted)
- Added 206 Partial Content guard (audio/video range requests not cached)
- Added supabase.co bypass (API responses never cached)
- Added pokeher_splash.jpg and maxine_splash.jpg to CACHE_URLS
- Cache bust: lobby-v3.3

---

## Pending
- [ ] Poke-Her progressive jackpot — currently shows local/hardcoded value;
      needs to subscribe to shared progressive table same as bingo games
- [ ] Virtual Wallet — standalone PWA for cross-game player balance
- [ ] WABC PHASE_PLAN needs to be rewritten from scratch (currently a copy of
      Progressive Operator's history — inaccurate)
- [ ] Lobby version display — no splash-ver element; consider adding a small
      version indicator for debugging

---

## Rules
- ES5 only
- All logic inline in index.html
- Cache bust on every single build
- progressive.js in root is dead code — do not reference or update it
