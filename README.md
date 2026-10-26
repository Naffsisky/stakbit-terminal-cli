# stakbit — Stockbit tracker for the terminal

Live watchlist, orderbook and running-trade tape for the Indonesian exchange (IDX), in your terminal.

```
 09:45:12 WIB  Session 1 — closes 12:00 WIB ● LIVE
  SYMBOL         LAST       CHG      CHG%     VOL (LOT)       VALUE
  BBRI          4,500       -50    -1.10%          1.2M       5.50B
  TLKM          3,200       +25    +0.79%        845.0K       2.70B
  BBCA          9,850         0     0.00%        312.0K       3.07B
 q quit · r refresh · 1 watchlist · 2 tape   updated 09:45:13   every 2.0s
```

Unofficial, and not affiliated with Stockbit or IDX. It reads Stockbit's private API with **your own
account's session**.

> **This tool cannot trade.** There is no order route, no deposit, no withdrawal. It reads market
> data and prints it. That is a deliberate boundary, not a missing feature.

---

## Install

```bash
git clone https://github.com/Naffsisky/stakbit-terminal-cli.git
cd stakbit-terminal-cli
npm ci
npm run build
npm link          # or: node dist/cli.js <command>
```

Requires **Node 20 or newer**. No runtime dependencies — the whole install is TypeScript's compiler.

## Sign in

```bash
stakbit login
```

This opens Stockbit's own login page in a Chromium-family browser. Sign in **there** — this tool never
asks for your password, OTP or PIN, and never sees them. It watches the network response for the
session token and stores it encrypted.

No browser on this machine (a server, or over SSH)? Paste the token instead:

```bash
stakbit login --paste
```

It prints where to find the token in DevTools. To confirm:

```bash
stakbit status
```

## Use it

```bash
stakbit watch                    # live watchlist, refreshes in place
stakbit watch --symbols BBRI,TLKM,ASII
stakbit tape BBRI                # live running-trade tape
stakbit quote BBRI,TLKM          # one-shot table, for scripts
stakbit book BBRI                # orderbook ladder
stakbit session                  # what phase is IDX in right now
```

Manage the saved list:

```bash
stakbit watchlist add BBRI,TLKM,ASII
stakbit watchlist list
stakbit watchlist remove TLKM
stakbit watchlist remote         # the lists on your Stockbit account, with ids
```

Press `Ctrl-C` to leave a live view.

## What it shows, and what it refuses to guess

| Field | Source | Notes |
|---|---|---|
| Last, change, % | orderbook route | wire spelling is `lastprice`; both spellings are read |
| Volume | lots | **1 lot = 100 shares.** Shown in lots, as IDX does |
| Value | IDR | compacted to `5.50B` |
| Foreign buy/sell/net | orderbook route | |
| ARA / ARB | orderbook route | shown only when the source provides them |
| Bid/offer ladder | orderbook route | sorted best-first, empty rungs dropped |
| Running trade | tape route | capped at 100 prints by the API itself |
| Broker codes | tape route | **hidden when the row says they are placeholders** |

Two rules the whole codebase follows:

1. **A value that cannot be read is `—`, never `0`.** A missing price rendered as zero would make an
   alert fire, a percentage divide by zero, and a chart collapse.
2. **A row that fails keeps its last good reading, marked stale**, rather than vanishing. A stock
   disappearing from a watchlist looks like a bug in the tool, not like an upstream hiccup.

### Broker codes on the tape

IDX stopped publishing broker identity in live running trade in **December 2021**. Stockbit still
populates the fields on some routes and leaves them empty on others, without always saying which. The
tape reads the `is_broker_exists` flag per row and renders a `·` instead of a code when the brokers
are not real. A placeholder shown as a broker is worse than a dash — it looks like information.

## Market hours

The header always says which phase IDX is in, because half of what looks like a broken tracker is
really "the market is shut".

| Phase | Mon–Thu (WIB) | Friday (WIB) |
|---|---|---|
| Pre-opening | 08:45 – 09:00 | 08:45 – 09:00 |
| Session 1 | 09:00 – 12:00 | 09:00 – 11:30 |
| Break | 12:00 – 13:30 | 11:30 – 14:00 |
| Session 2 | 13:30 – 15:50 | 14:00 – 15:50 |
| Post-closing | 15:50 – 16:15 | 15:50 – 16:15 |

Outside a live session the poller drops to a 15-second heartbeat, because nothing can change and
polling only spends the account's rate limit. `--always` overrides that.

**Holidays are not modelled.** They move every year, and a hard-coded table would be confidently
wrong the first time it went stale — worse than the smaller lie of saying "open" while quotes sit
still.

## Where your session lives

`~/.stakbit/` (`STAKBIT_HOME` overrides it):

| File | Contents |
|---|---|
| `refresh.enc` | the rotating refresh token, AES-256-GCM |
| `access.enc` | the cached 24-hour access token, AES-256-GCM |
| `settings.json` | your saved symbol list — plain text, no secrets |
| `refresh.lock` | transient, only while a refresh is in flight |

Files are mode `0600`, the directory `0700`.

**Be honest about what that encryption is worth.** The key is derived from your machine's hostname and
your username, with a random salt per file. Anything running as you on this machine can derive the
same key and read these files. It keeps the token out of a `.env` that gets committed, out of shell
history, and out of `ps`. **On a shared host or a VPS, treat it as "the token is on disk"** and protect
the account accordingly.

Want a secret this machine cannot derive on its own? Set `STAKBIT_STORE_SECRET` before logging in.

`stakbit logout` deletes both files.

## Environment

| Variable | Purpose |
|---|---|
| `STAKBIT_HOME` | store directory (default `~/.stakbit`) |
| `STAKBIT_POLL_MS` | default poll interval (default `2000`, floor `500`) |
| `STAKBIT_ALWAYS_POLL=1` | poll even when the market is closed |
| `STAKBIT_STORE_SECRET` | extra secret mixed into the store key |
| `STAKBIT_BROWSER` | path to a Chromium-family browser, for `login` |
| `STAKBIT_NO_ACCESS_CACHE=1` | do not cache the access token on disk |
| `STAKBIT_DEBUG=1` | print response *shapes* (never values) when parsing fails |
| `NO_COLOR` | disable colour |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | success (a partial quote failure still exits 0 — some rows were fine) |
| `1` | runtime failure: network, upstream, or every symbol failed |
| `2` | usage error: unknown command, bad argument, not a ticker |
| `3` | auth problem: no session, or a session Stockbit rejected |

`quote` is meant to be scriptable:

```bash
stakbit quote BBRI >/dev/null || echo "could not read BBRI"
```

## How the session stays alive

A successful refresh **rotates** the token: the old one is retired the moment the new one is minted.
Two consequences shaped the design:

- The new token is written to disk **before** the access token is handed to any caller. A crash
  between those two steps would leave the old token already dead.
- Refreshes take a cross-process lock, and a process that loses the race re-reads the store instead of
  refreshing on its own. Without this, running `stakbit watch` in one terminal and `stakbit quote` in
  another would log you out at random.

The access token is cached on disk for the same reason: minting one per process would rotate the
refresh token on every invocation. Measured: eight processes started simultaneously against an empty
cache produce **exactly one** rotation.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # 105 tests, offline, no account needed
npm run build        # emits dist/
```

Everything is tested without touching Stockbit. The projection tests feed real wire shapes
(`lastprice`, `{ raw }` objects, thousands-separated strings) into the parsers; the renderer tests
assert on plain strings with colour off, which is the same path a piped run takes.

An end-to-end check against a mock backend, with no account:

```bash
node scripts/mock-server.mjs 8787 &
export STAKBIT_HOME=/tmp/stakbit-e2e STAKBIT_EXODUS_URL=http://127.0.0.1:8787
node dist/cli.js login --paste   # paste the JWT from /tmp/mock-token.txt
node dist/cli.js quote BBRI
```

## Known limits

- **Undocumented API.** Shapes drift without notice. Every field read is defensive, and an unreadable
  field becomes `—` rather than a wrong number, but a rename upstream can still blank a column.
- **Rate limits are not published.** Requests are capped at 3 concurrent with 150 ms spacing, and a
  429 is honoured. Very large watchlists may still be throttled.
- **The tape is capped at 100 prints**, and its window always starts at the session open. That is the
  API's limit, not a setting.
- **Terms of service.** This reads a private API with your session. Whether automated access is
  permitted is Stockbit's call, not this project's. Use your own account and your own judgement.
- **Not investment advice.** Nothing here is a recommendation, and the imbalance reading is a coarse
  measurement of resting size, not a signal.

## Licence

MIT.
