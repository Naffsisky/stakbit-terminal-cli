#!/usr/bin/env node
/**
 * Entry point.
 *
 * Hand-rolled argument parsing rather than a framework: the surface is nine commands and two flags,
 * and a dependency that has to be kept current is a worse trade than forty lines of `switch`. It also
 * keeps the install to zero runtime dependencies, which matters for a tool people run over SSH.
 *
 * ## Exit codes
 *
 *   0  success
 *   1  runtime failure (network, upstream, unexpected)
 *   2  usage error — wrong arguments, unknown command
 *   3  auth problem — no session, or a session Stockbit rejected
 *
 * Distinct codes matter because this is meant to be scriptable: `stakbit quote BBRI || exit` should
 * be able to tell "you are logged out" from "Stockbit is down".
 */
import { loadConfig } from "./config.js";
import { ApiError } from "./api/client.js";
import { AuthError, describeStore, logout, status as sessionStatus } from "./auth/session.js";
import { LoginError, loginWithBrowser, loginWithToken, promptForToken } from "./auth/login.js";
import { fetchOrderbook, fetchQuote, fetchTrades, fetchWatchlistSymbols, fetchWatchlists } from "./api/market.js";
import { sessionState, formatWibTime } from "./session-clock.js";
import { colorEnabled, bold, cyan, dim, formatCompact, formatInt, formatLot, formatPercent, formatPrice, formatChange, colorChange, pad, rule } from "./format/text.js";
import { renderQuoteDetail, renderOrderbook, renderTape } from "./tui/render.js";
import { printOnce, runLive } from "./tui/live.js";
import { addSymbols, readSettings, removeSymbols, resolveSymbols, UsageError } from "./settings.js";

const VERSION = "0.1.0";

const USAGE = `stakbit ${VERSION} — Stockbit tracker for the terminal

USAGE
  stakbit <command> [options]

COMMANDS
  login [--paste] [--keep-open]
      Sign in. Opens Stockbit's own login page in a browser and captures the session;
      --paste reads a token from stdin instead, for machines without a browser.

  logout
      Delete the stored session from this machine.

  status
      Show session state, market phase, and where the store lives.

  watch
      Live watchlist. Refreshes in place until you press Ctrl-C.
        --symbols BBRI,TLKM   override the saved list
        --interval 2000       poll interval in ms
        --always              poll even when the market is closed

  tape <SYMBOL>
      Live running-trade tape for one symbol.

  quote <SYMBOL>[,SYMBOL...]
      One-shot quote table. Scriptable: prints and exits.

  book <SYMBOL>
      One-shot orderbook ladder.

  watchlist <list|add|remove>
      Manage the saved symbol list.
        watchlist list
        watchlist add BBRI,TLKM
        watchlist remove BBRI
        watchlist remote        list the watchlists on your Stockbit account

  session
      Show the IDX session phase right now.

ENVIRONMENT
  STAKBIT_HOME            store directory (default ~/.stakbit)
  STAKBIT_POLL_MS         default poll interval
  STAKBIT_ALWAYS_POLL=1   poll outside market hours
  STAKBIT_STORE_SECRET    extra secret mixed into the store key
  STAKBIT_BROWSER         path to a Chromium-family browser for login
  STAKBIT_NO_ACCESS_CACHE=1  do not cache the access token on disk
  STAKBIT_DEBUG=1         print response shapes when parsing fails
  NO_COLOR                disable colour
`;

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  // `process.exit` can be swallowed by a pending promise chain in some Node versions, so the throw
  // makes the stop unconditional: nothing after a usage error should ever run.
  process.exit(code);
  throw new Error(message);
}

interface Parsed {
  command: string;
  positional: string[];
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Parsed {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [name, inline] = arg.slice(2).split("=", 2);
      if (!name) continue;
      if (inline !== undefined) {
        flags.set(name, inline);
        continue;
      }
      const next = rest[i + 1];
      // A flag takes the next token as its value unless that token is itself a flag or absent.
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        i++;
      } else {
        flags.set(name, true);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      flags.set(arg.slice(1), true);
      continue;
    }
    positional.push(arg);
  }
  return { command, positional, flags };
}

function flagString(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagBool(parsed: Parsed, name: string): boolean {
  return parsed.flags.has(name);
}

function theme() {
  return { color: colorEnabled() };
}

/* --------------------------------- commands -------------------------------- */

async function cmdLogin(parsed: Parsed): Promise<number> {
  if (flagBool(parsed, "paste")) {
    const token = await promptForToken();
    await loginWithToken(token);
    process.stdout.write("Session stored. Run `stakbit status` to confirm.\n");
    return 0;
  }
  await loginWithBrowser({
    ...(flagBool(parsed, "keep-open") ? { keepOpen: true } : {}),
    ...(flagString(parsed, "timeout") ? { timeoutMs: Number(flagString(parsed, "timeout")) * 1000 } : {}),
    log: (m) => process.stderr.write(`${m}\n`),
  });
  return 0;
}

function cmdLogout(): number {
  const { removed } = logout();
  process.stdout.write(removed ? "Session deleted from this machine.\n" : "There was no stored session.\n");
  return 0;
}

function cmdStatus(): number {
  const theme_ = theme();
  const status = sessionStatus();
  const session = sessionState();
  const store = describeStore();
  const settings = readSettings();
  const cfg = loadConfig();

  const lines: string[] = [];
  lines.push("");
  lines.push(` ${bold(`stakbit ${VERSION}`, theme_.color)}`);
  lines.push("");

  lines.push(` ${dim("session", theme_.color)}`);
  if (status.hasRefresh) {
    lines.push(`   ${cyan("✓", theme_.color)} signed in${status.account ? ` as ${status.account}` : ""}`);
    if (status.obtainedAt) lines.push(`   ${dim("stored", theme_.color)}  ${status.obtainedAt}`);
  } else {
    lines.push(`   ${dim("✗ not signed in", theme_.color)} — run \`stakbit login\``);
  }
  if (status.hasAccess && status.accessExpiresAt) {
    lines.push(`   ${dim("access", theme_.color)}  valid until ${new Date(status.accessExpiresAt).toISOString()}`);
  }

  lines.push("");
  lines.push(` ${dim("market", theme_.color)}`);
  lines.push(`   ${session.nowWib} WIB  ${session.live ? cyan(session.label, theme_.color) : dim(session.label, theme_.color)}`);

  lines.push("");
  lines.push(` ${dim("symbols", theme_.color)}  ${settings.symbols.length > 0 ? settings.symbols.join(", ") : dim("(none — defaults will be used)", theme_.color)}`);

  lines.push("");
  lines.push(` ${dim("store", theme_.color)}  ${store.dir}`);
  for (const file of store.files) {
    if (!file.exists) continue;
    lines.push(`   ${dim(pad(file.name, 14), theme_.color)} ${formatInt(file.bytes)} bytes`);
  }

  lines.push("");
  lines.push(` ${dim("poll", theme_.color)}    ${cfg.pollMs} ms${cfg.alwaysPoll ? " (always)" : ""}`);
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

async function cmdWatch(parsed: Parsed): Promise<number> {
  const explicit = flagString(parsed, "symbols");
  const { symbols, source } = resolveSymbols(explicit);
  const cfg = loadConfig();
  const interval = Number(flagString(parsed, "interval") ?? cfg.pollMs);
  const pollMs = Number.isFinite(interval) && interval >= 500 ? interval : cfg.pollMs;
  const always = flagBool(parsed, "always") || cfg.alwaysPoll;

  if (source === "default") {
    process.stderr.write(
      `No saved symbols — showing a default set (${symbols.join(", ")}).\n` +
        "Save your own with `stakbit watchlist add BBRI,TLKM`.\n\n",
    );
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  try {
    await runLive({
      symbols,
      pollMs,
      alwaysPoll: always,
      mode: "watchlist",
      ...(flagString(parsed, "frames") ? { maxFrames: Number(flagString(parsed, "frames")) } : {}),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

async function cmdTape(parsed: Parsed): Promise<number> {
  const symbol = parsed.positional[0];
  if (!symbol) fail("usage: stakbit tape <SYMBOL>", 2);
  const cfg = loadConfig();
  const interval = Number(flagString(parsed, "interval") ?? cfg.pollMs);

  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await runLive({
      symbols: [symbol.toUpperCase()],
      pollMs: Number.isFinite(interval) ? interval : cfg.pollMs,
      alwaysPoll: flagBool(parsed, "always") || cfg.alwaysPoll,
      mode: "tape",
      focus: symbol.toUpperCase(),
      ...(flagString(parsed, "frames") ? { maxFrames: Number(flagString(parsed, "frames")) } : {}),
      signal: controller.signal,
    });
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return 0;
}

async function cmdQuote(parsed: Parsed): Promise<number> {
  const { symbols } = resolveSymbols(parsed.positional.join(",") || flagString(parsed, "symbols"));
  const theme_ = theme();
  const session = sessionState();

  const lines: string[] = [];
  lines.push(
    ` ${formatWibTime(new Date())} WIB  ${session.live ? cyan(session.label, theme_.color) : dim(session.label, theme_.color)}`,
  );
  lines.push("");

  const columns = [
    { label: "SYMBOL", width: 8 },
    { label: "LAST", width: 9 },
    { label: "CHG", width: 8 },
    { label: "CHG%", width: 8 },
    { label: "VOL (LOT)", width: 12 },
    { label: "VALUE", width: 10 },
  ];
  lines.push(` ${dim(columns.map((c) => pad(c.label, c.width, "right")).join("  "), theme_.color)}`);

  let failed = 0;
  let lastAuthError: AuthError | null = null;

  for (const symbol of symbols) {
    try {
      const quote = await fetchQuote(symbol);
      const cells = [
        pad(bold(symbol, theme_.color), columns[0]!.width, "left"),
        pad(formatPrice(quote.lastPrice), columns[1]!.width, "right"),
        pad(colorChange(quote.change, formatChange(quote.change), theme_.color), columns[2]!.width, "right"),
        pad(colorChange(quote.changePercent, formatPercent(quote.changePercent), theme_.color), columns[3]!.width, "right"),
        pad(formatLot(quote.volume), columns[4]!.width, "right"),
        pad(formatCompact(quote.value), columns[5]!.width, "right"),
      ];
      lines.push(` ${cells.join("  ")}`);
    } catch (error) {
      failed++;
      if (error instanceof AuthError) lastAuthError = error;
      const message = error instanceof Error ? error.message : String(error);
      lines.push(` ${pad(bold(symbol, theme_.color), columns[0]!.width, "left")} ${dim(message.slice(0, 60), theme_.color)}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");

  // An auth failure is the more actionable of the two, so it wins the exit code: the user needs to
  // log in before a retry can possibly work. A partial failure still exits 0 — some rows were fine.
  if (lastAuthError) throw lastAuthError;
  return failed > 0 && failed === symbols.length ? 1 : 0;
}

async function cmdBook(parsed: Parsed): Promise<number> {
  const symbol = parsed.positional[0];
  if (!symbol) fail("usage: stakbit book <SYMBOL>", 2);
  const book = await fetchOrderbook(symbol);
  const width = process.stdout.columns && process.stdout.columns > 40 ? process.stdout.columns : 100;
  process.stdout.write(renderOrderbook(book, { theme: theme(), levels: 10, width }).join("\n") + "\n");
  return 0;
}

async function cmdWatchlist(parsed: Parsed): Promise<number> {
  const action = parsed.positional[0] ?? "list";
  const theme_ = theme();

  if (action === "add") {
    const symbols = parsed.positional.slice(1);
    if (symbols.length === 0) fail("usage: stakbit watchlist add BBRI[,TLKM]", 2);
    const list = addSymbols(symbols);
    process.stdout.write(`Saved ${list.length} symbol${list.length === 1 ? "" : "s"}: ${list.join(", ")}\n`);
    return 0;
  }

  if (action === "remove" || action === "rm") {
    const symbols = parsed.positional.slice(1);
    if (symbols.length === 0) fail("usage: stakbit watchlist remove BBRI", 2);
    const list = removeSymbols(symbols);
    process.stdout.write(`Saved ${list.length} symbol${list.length === 1 ? "" : "s"}: ${list.join(", ") || "(empty)"}\n`);
    return 0;
  }

  if (action === "remote") {
    const lists = await fetchWatchlists();
    if (lists.length === 0) {
      process.stdout.write("No watchlists found on the account.\n");
      return 0;
    }
    process.stdout.write(`\n ${dim("WATCHLISTS ON YOUR ACCOUNT", theme_.color)}\n\n`);
    for (const list of lists) {
      const marker = list.isDefault ? cyan(" *", theme_.color) : "  ";
      process.stdout.write(`${marker} ${pad(list.name, 30)} ${dim(list.id, theme_.color)}\n`);
    }
    process.stdout.write(`\n ${dim("* = default list", theme_.color)}\n`);
    return 0;
  }

  if (action === "list") {
    const settings = readSettings();
    if (settings.symbols.length === 0) {
      process.stdout.write("No saved symbols. Add some: stakbit watchlist add BBRI,TLKM\n");
      return 0;
    }
    process.stdout.write(`${settings.symbols.length} symbol${settings.symbols.length === 1 ? "" : "s"}:\n`);
    for (const symbol of settings.symbols) process.stdout.write(`  ${symbol}\n`);
    return 0;
  }

  fail(`unknown watchlist action "${action}" — expected list, add, remove, or remote`, 2);
}

function cmdSession(): number {
  const session = sessionState();
  const theme_ = theme();
  process.stdout.write(`\n ${formatWibTime(new Date())} WIB\n`);
  process.stdout.write(` ${session.live ? cyan(session.label, theme_.color) : dim(session.label, theme_.color)}\n`);
  process.stdout.write(` ${dim("phase", theme_.color)} ${session.phase}\n\n`);
  return 0;
}

/* ---------------------------------- main ---------------------------------- */

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(USAGE);
      return 0;
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "login":
      return cmdLogin(parsed);
    case "logout":
      return cmdLogout();
    case "status":
      return cmdStatus();
    case "watch":
      return cmdWatch(parsed);
    case "tape":
      return cmdTape(parsed);
    case "quote":
      return cmdQuote(parsed);
    case "book":
      return cmdBook(parsed);
    case "watchlist":
      return cmdWatchlist(parsed);
    case "session":
      return cmdSession();
    case "once": {
      const { symbols } = resolveSymbols(flagString(parsed, "symbols"));
      await printOnce({ symbols, mode: "watchlist" });
      return 0;
    }
    default:
      fail(`unknown command "${parsed.command}"\n\n${USAGE}`, 2);
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(2);
    }
    if (error instanceof AuthError) {
      process.stderr.write(`\n${error.message}\n${error.hint}\n`);
      process.exit(3);
    }
    if (error instanceof LoginError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(3);
    }
    if (error instanceof ApiError) {
      process.stderr.write(`\n${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n`);
    if (process.env.STAKBIT_DEBUG === "1" && error instanceof Error && error.stack) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exit(1);
  });
