/**
 * The live view: fetch, render, wait, repeat.
 *
 * ## Why a diffing renderer
 *
 * Redrawing by clearing the screen makes a terminal flicker, and over SSH it makes it scroll. Instead
 * each frame is compared line by line against the previous one and only changed lines are rewritten,
 * using cursor-up plus `\r` and `\u001b[K`. On a quiet market almost nothing is written; on an active
 * one the updates are small and local.
 *
 * ## Why the poller degrades instead of failing
 *
 * A single failed quote must not blank the table — the other rows are still good, and a tracker that
 * disappears because one symbol 404'd is worse than one showing a stale row with a marker. Failures
 * are attached per row. Only a session-wide failure (auth, network down) is promoted to the footer.
 *
 * ## Why the session clock gates polling
 *
 * Outside IDX hours nothing changes, so polling at 2s just burns the account's rate limit. The delay
 * stretches to a heartbeat and the header says why.
 */
import { fetchQuote, fetchTrades } from "../api/market.js";
import { ApiError } from "../api/client.js";
import { AuthError } from "../auth/session.js";
import { formatWibTime, nextPollDelay, sessionState } from "../session-clock.js";
import { colorEnabled } from "../format/text.js";
import type { Quote, Trade, WatchRow } from "../types.js";
import { frame, renderFooter, renderHeader, renderTape, renderWatchlist, watchRowFromError, watchRowFromQuote } from "./render.js";

export interface LiveOptions {
  symbols: string[];
  pollMs: number;
  alwaysPoll: boolean;
  /** Which panel gets the space: the table, or a symbol's tape. */
  mode: "watchlist" | "tape";
  /** For tape mode. */
  focus?: string;
  /** Stop after this many frames. Used by tests and by `--frames`. */
  maxFrames?: number;
  /** Write a frame; defaults to stdout. Injected by tests. */
  write?: (text: string) => void;
  /** Read terminal size; defaults to the real one. */
  size?: () => { width: number; height: number };
  /** Stop signal. */
  signal?: AbortSignal;
}

const HIDE_CURSOR = "\u001b[?25l";
const SHOW_CURSOR = "\u001b[?25h";
const CLEAR_LINE = "\u001b[K";

function defaultSize(): { width: number; height: number } {
  return {
    width: process.stdout.columns && process.stdout.columns > 20 ? process.stdout.columns : 100,
    height: process.stdout.rows && process.stdout.rows > 10 ? process.stdout.rows : 30,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Write a frame, rewriting only the lines that changed. */
export class FrameWriter {
  private previous: string[] = [];
  private firstFrame = true;
  private readonly out: (text: string) => void;

  constructor(out: (text: string) => void) {
    this.out = out;
  }

  start(): void {
    this.out(HIDE_CURSOR);
  }

  stop(): void {
    this.out(SHOW_CURSOR);
  }

  draw(lines: string[]): void {
    if (this.firstFrame) {
      // No previous frame, so there is nothing to move over: print it plainly.
      this.out(lines.join("\n") + "\n");
      this.previous = lines;
      this.firstFrame = false;
      return;
    }

    let buffer = "";
    let moved = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === this.previous[i]) continue;
      if (!moved) {
        // Move from the bottom of the previous frame to its first line.
        buffer += `\u001b[${this.previous.length}A`;
        moved = true;
      }
      // Absolute row, then clear to end of line, then the new content.
      buffer += `\u001b[${i + 1};1H${lines[i]}${CLEAR_LINE}`;
    }
    if (moved) {
      buffer += `\u001b[${lines.length};1H`;
    }
    if (buffer) this.out(buffer);
    this.previous = lines;
  }
}

/**
 * Run the live loop until aborted or `maxFrames` frames are drawn.
 *
 * Returns the last frame, which is what the tests assert on.
 */
export async function runLive(options: LiveOptions): Promise<string[]> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const size = options.size ?? defaultSize;
  const theme = { color: colorEnabled() };
  const writer = new FrameWriter(write);
  const symbols = options.symbols.map((s) => s.toUpperCase());

  let rows: WatchRow[] = symbols.map((symbol) => ({
    symbol,
    lastPrice: null,
    change: null,
    changePercent: null,
    volume: null,
    value: null,
  }));
  let quotes = new Map<string, Quote>();
  let trades: Trade[] = [];
  let sessionError: string | undefined;
  let lastUpdate: string | null = null;
  let frames = 0;
  let lastLines: string[] = [];

  writer.start();
  try {
    while (!options.signal?.aborted) {
      const session = sessionState();
      const { width, height } = size();

      // Fetch. Independent failures stay independent: a bad symbol must not blank the table.
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => {
          const quote = await fetchQuote(symbol);
          return { symbol, quote };
        }),
      );

      sessionError = undefined;
      const nextRows: WatchRow[] = [];
      results.forEach((result, index) => {
        const symbol = symbols[index]!;
        if (result.status === "fulfilled") {
          quotes.set(symbol, result.value.quote);
          nextRows.push(watchRowFromQuote(result.value.quote));
          return;
        }
        const error = result.reason;
        if (error instanceof AuthError) {
          sessionError = `${error.message} ${error.hint}`;
        } else if (error instanceof ApiError) {
          sessionError ??= error.message;
        } else {
          sessionError ??= error instanceof Error ? error.message : String(error);
        }
        // Keep the last good reading, marked stale, rather than replacing it with dashes.
        const previous = rows.find((r) => r.symbol === symbol);
        nextRows.push(
          previous && previous.lastPrice !== null
            ? { ...previous, error: "stale" }
            : watchRowFromError(symbol, "unavailable"),
        );
      });
      rows = nextRows;

      if (options.mode === "tape" && options.focus) {
        try {
          trades = await fetchTrades({ symbol: options.focus, limit: 60 });
        } catch (error) {
          if (error instanceof AuthError) sessionError = `${error.message} ${error.hint}`;
        }
      }

      if (!sessionError) lastUpdate = formatWibTime(new Date());

      // Compose the frame.
      const lines: string[] = [];
      lines.push(renderHeader(session, { theme, notice: sessionError ? "last refresh failed" : undefined }));
      lines.push("");

      if (options.mode === "tape" && options.focus) {
        lines.push(...renderTape(trades, { theme, limit: Math.max(5, height - 6) }));
      } else {
        lines.push(...renderWatchlist(rows, { theme }));
      }

      // Footer is pinned to the bottom so the layout does not jump as rows are added.
      while (lines.length < height - 1) lines.push("");
      lines.push(
        renderFooter({
          theme,
          keys: ["q quit", "r refresh", "1 watchlist", "2 tape"],
          pollMs: options.pollMs,
          lastUpdate,
          ...(sessionError ? { error: sessionError } : {}),
        }),
      );

      const composed = frame(lines, width, height);
      writer.draw(composed.lines);
      lastLines = composed.lines;
      frames++;

      if (options.maxFrames !== undefined && frames >= options.maxFrames) break;

      await sleep(nextPollDelay(options.pollMs, session, options.alwaysPoll), options.signal);
    }
  } finally {
    writer.stop();
  }

  return lastLines;
}

/**
 * Print one frame and exit. This is the `--once` path: useful in a script, over a slow link, or to
 * prove the pipeline works before trusting the live view.
 */
export async function printOnce(options: {
  symbols: string[];
  mode: "watchlist" | "tape";
  focus?: string;
  write?: (text: string) => void;
  size?: () => { width: number; height: number };
}): Promise<void> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const size = options.size ?? defaultSize;
  const theme = { color: colorEnabled() };
  const session = sessionState();

  const rows: WatchRow[] = [];
  if (options.mode === "tape" && options.focus) {
    const trades = await fetchTrades({ symbol: options.focus, limit: 30 });
    const lines = [renderHeader(session, { theme, symbol: options.focus }), "", ...renderTape(trades, { theme, limit: 30 })];
    write(lines.join("\n") + "\n");
    return;
  }

  for (const symbol of options.symbols) {
    try {
      const quote = await fetchQuote(symbol);
      rows.push(watchRowFromQuote(quote));
    } catch (error) {
      rows.push(watchRowFromError(symbol, error instanceof Error ? error.message : String(error)));
    }
  }

  const { width } = size();
  const lines = [renderHeader(session, { theme }), "", ...renderWatchlist(rows, { theme })];
  write(lines.map((line) => line.padEnd(width)).join("\n").trimEnd() + "\n");
}
