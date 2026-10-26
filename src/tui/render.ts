/**
 * Frame rendering: pure functions from state to lines.
 *
 * ## Why this is separate from the terminal handling
 *
 * Everything in this file takes data and returns an array of strings. No `process.stdout`, no
 * cursor movement, no timers. That makes the whole layout testable — the tests in `test/render.test.ts`
 * assert on exact output without a pseudo-terminal — and it means a future `--once` mode that prints
 * a single frame and exits gets the same rendering for free.
 *
 * ## The width contract
 *
 * Every line is padded or truncated to exactly the terminal width. A frame that is one character
 * short leaves a stale column from the previous frame, which looks like corruption. The `frame`
 * helper enforces this once rather than in every renderer.
 */
import {
  bold,
  colorChange,
  cyan,
  dim,
  formatChange,
  formatCompact,
  formatInt,
  formatLot,
  formatPercent,
  formatPrice,
  pad,
  red,
  rule,
  stripAnsi,
  yellow,
} from "../format/text.js";
import type { Orderbook, Quote, SessionState, Trade, WatchRow } from "../types.js";

export interface Theme {
  color: boolean;
}

export interface Frame {
  lines: string[];
  width: number;
  height: number;
}

/** Pad every line to `width` and clamp the list to `height`. */
export function frame(lines: string[], width: number, height: number): Frame {
  const out: string[] = [];
  for (let i = 0; i < height; i++) {
    const line = lines[i] ?? "";
    const visible = stripAnsi(line);
    if (visible.length > width) {
      // Truncation happens on the visible string, then colour is dropped for that line: cutting an
      // escape sequence in half would leak the code into the rest of the terminal.
      out.push(visible.slice(0, width));
    } else {
      out.push(line + " ".repeat(width - visible.length));
    }
  }
  return { lines: out, width, height };
}

/* ---------------------------------- header ---------------------------------- */

export function renderHeader(state: SessionState, opts: { symbol?: string; theme: Theme; notice?: string }): string {
  const { theme } = opts;
  const clock = bold(state.nowWib, theme.color);
  const phase = state.live ? cyan(state.label, theme.color) : dim(state.label, theme.color);
  const live = state.live ? ` ${red("● LIVE", theme.color)}` : ` ${dim("○ idle", theme.color)}`;
  const symbol = opts.symbol ? `  ${bold(opts.symbol, theme.color)}` : "";
  const notice = opts.notice ? `  ${yellow(opts.notice, theme.color)}` : "";
  return ` ${clock} WIB  ${phase}${live}${symbol}${notice}`;
}

/* -------------------------------- watchlist -------------------------------- */

const WATCH_COLUMNS = [
  { key: "symbol", label: "SYMBOL", width: 8, align: "left" as const },
  { key: "last", label: "LAST", width: 9, align: "right" as const },
  { key: "change", label: "CHG", width: 8, align: "right" as const },
  { key: "percent", label: "CHG%", width: 8, align: "right" as const },
  { key: "volume", label: "VOL (LOT)", width: 12, align: "right" as const },
  { key: "value", label: "VALUE", width: 10, align: "right" as const },
];

export function renderWatchlist(rows: WatchRow[], opts: { theme: Theme; selected?: number }): string[] {
  const { theme } = opts;
  const lines: string[] = [];

  const header = WATCH_COLUMNS.map((c) => pad(c.label, c.width, c.align)).join("  ");
  lines.push(` ${dim(header, theme.color)}`);

  if (rows.length === 0) {
    lines.push(` ${dim("no symbols — add some with 'stakbit watchlist add BBRI'", theme.color)}`);
    return lines;
  }

  rows.forEach((row, index) => {
    const isSelected = opts.selected === index;
    const marker = isSelected ? cyan("▸", theme.color) : " ";
    const stale = row.error ? dim(" !", theme.color) : "";

    const cells = [
      pad(bold(row.symbol, theme.color), WATCH_COLUMNS[0]!.width, "left"),
      pad(formatPrice(row.lastPrice), WATCH_COLUMNS[1]!.width, "right"),
      pad(colorChange(row.change, formatChange(row.change), theme.color), WATCH_COLUMNS[2]!.width, "right"),
      pad(colorChange(row.changePercent, formatPercent(row.changePercent), theme.color), WATCH_COLUMNS[3]!.width, "right"),
      pad(formatLot(row.volume), WATCH_COLUMNS[4]!.width, "right"),
      pad(formatCompact(row.value), WATCH_COLUMNS[5]!.width, "right"),
    ];
    lines.push(`${marker}${cells.join("  ")}${stale}`);
  });

  return lines;
}

/* -------------------------------- orderbook -------------------------------- */

/**
 * Depth ladder.
 *
 * Offers are printed top-down (highest first) so the best offer sits next to the spread, matching
 * every trading terminal's convention. A ladder that ran the other way would be read as inverted
 * prices by anyone who has used one before.
 */
export function renderOrderbook(book: Orderbook, opts: { theme: Theme; levels?: number; width: number }): string[] {
  const { theme } = opts;
  // Never render more rungs than there is data for: a ladder padded with blank rows pushes the
  // spread line off the bottom and reads as missing depth rather than as a short book.
  const levels = Math.max(1, Math.min(opts.levels ?? 5, Math.max(book.bids.length, book.offers.length)));
  const lines: string[] = [];
  const half = Math.max(12, Math.floor((opts.width - 6) / 2));

  lines.push(` ${dim("ORDERBOOK", theme.color)}  ${bold(book.symbol, theme.color)}`);
  lines.push(` ${dim(`${pad("BID", half - 2, "left")}  ${pad("OFFER", half - 2, "right")}`, theme.color)}`);

  const offers = [...book.offers].slice(0, levels).reverse();
  const bids = [...book.bids].slice(0, levels);

  for (let i = 0; i < levels; i++) {
    const bid = bids[i];
    const offer = offers[i];
    const bidCell = bid
      ? `${pad(formatPrice(bid.price), 8, "right")} ${pad(formatLot(bid.lot), 9, "right")}`
      : pad("", 18, "right");
    const offerCell = offer
      ? `${pad(formatLot(offer.lot), 9, "left")} ${pad(formatPrice(offer.price), 8, "left")}`
      : pad("", 18, "left");
    const bidText = bid ? colorChange(1, bidCell, theme.color) : dim(bidCell, theme.color);
    const offerText = offer ? colorChange(-1, offerCell, theme.color) : dim(offerCell, theme.color);
    lines.push(` ${pad(bidText, half, "left")}  ${offerText}`);
  }

  lines.push(` ${dim(rule(opts.width - 2), theme.color)}`);
  const spread =
    book.bestBid && book.bestOffer ? book.bestOffer.price - book.bestBid.price : null;
  const spreadPct =
    spread !== null && book.mid !== null && book.mid > 0 ? (spread / book.mid) * 100 : null;
  lines.push(
    ` ${dim("spread", theme.color)} ${formatPrice(spread)}` +
      `  ${dim("imbalance", theme.color)} ${formatImbalance(book, theme)}`,
  );
  if (spreadPct !== null) {
    lines.push(` ${dim("spread %", theme.color)} ${spreadPct.toFixed(2)}%`);
  }
  return lines;
}

/**
 * Bid/offer size imbalance as a percentage.
 *
 * Positive means more lots resting on the bid than the offer. It is a coarse signal — resting size
 * can be withdrawn — so it is labelled, not coloured as a recommendation.
 */
export function formatImbalance(book: Orderbook, theme: Theme): string {
  const total = book.bidLot + book.offerLot;
  if (total === 0) return dim("—", theme.color);
  const pct = ((book.bidLot - book.offerLot) / total) * 100;
  const sign = pct > 0 ? "+" : "";
  return colorChange(pct, `${sign}${pct.toFixed(1)}%`, theme.color);
}

/* ----------------------------------- tape ---------------------------------- */

const TAPE_COLUMNS = [
  { label: "TIME", width: 8, align: "left" as const },
  { label: "SIDE", width: 4, align: "left" as const },
  { label: "PRICE", width: 8, align: "right" as const },
  { label: "LOT", width: 8, align: "right" as const },
  { label: "VALUE", width: 10, align: "right" as const },
  { label: "BUYER", width: 5, align: "left" as const },
  { label: "SELLER", width: 6, align: "left" as const },
];

export function renderTape(trades: Trade[], opts: { theme: Theme; limit?: number }): string[] {
  const { theme } = opts;
  const limit = opts.limit ?? 12;
  const lines: string[] = [];

  const header = TAPE_COLUMNS.map((c) => pad(c.label, c.width, c.align)).join(" ");
  lines.push(` ${dim(header, theme.color)}`);

  if (trades.length === 0) {
    lines.push(` ${dim("no prints yet", theme.color)}`);
    return lines;
  }

  for (const trade of trades.slice(0, limit)) {
    const side = trade.side === "buy" ? colorChange(1, "BUY ", theme.color) : colorChange(-1, "SELL", theme.color);
    // A broker code is only shown when the row says the brokers are real. A placeholder rendered as
    // a broker is worse than a dash: it looks like information.
    const buyer = trade.brokersPresent ? (trade.buyer ?? "—") : dim("·", theme.color);
    const seller = trade.brokersPresent ? (trade.seller ?? "—") : dim("·", theme.color);
    const cells = [
      pad(trade.time.slice(0, 8), TAPE_COLUMNS[0]!.width, "left"),
      pad(side, TAPE_COLUMNS[1]!.width, "left"),
      pad(colorChange(trade.side === "buy" ? 1 : -1, formatPrice(trade.price), theme.color), TAPE_COLUMNS[2]!.width, "right"),
      pad(formatLot(trade.lot), TAPE_COLUMNS[3]!.width, "right"),
      pad(formatCompact(trade.value), TAPE_COLUMNS[4]!.width, "right"),
      pad(buyer, TAPE_COLUMNS[5]!.width, "left"),
      pad(seller, TAPE_COLUMNS[6]!.width, "left"),
    ];
    lines.push(` ${cells.join(" ")}`);
  }
  return lines;
}

/* ---------------------------------- footer --------------------------------- */

export function renderFooter(opts: {
  theme: Theme;
  keys: string[];
  pollMs: number;
  lastUpdate: string | null;
  error?: string;
}): string {
  const { theme } = opts;
  if (opts.error) return ` ${red(`✗ ${opts.error}`, theme.color)}`;
  const keys = opts.keys.map((k) => dim(k, theme.color)).join(dim(" · ", theme.color));
  const updated = opts.lastUpdate ? `${dim("updated", theme.color)} ${opts.lastUpdate}` : dim("loading…", theme.color);
  return ` ${keys}   ${updated}   ${dim(`every ${(opts.pollMs / 1000).toFixed(1)}s`, theme.color)}`;
}

/* ------------------------------ quote detail ------------------------------ */

export function renderQuoteDetail(quote: Quote, opts: { theme: Theme }): string[] {
  const { theme } = opts;
  const lines: string[] = [];
  const title = `${bold(quote.symbol, theme.color)}${quote.name ? `  ${dim(quote.name, theme.color)}` : ""}`;
  lines.push(` ${title}`);
  lines.push(
    ` ${bold(formatPrice(quote.lastPrice), theme.color)}  ` +
      `${colorChange(quote.change, formatChange(quote.change), theme.color)}  ` +
      `${colorChange(quote.changePercent, formatPercent(quote.changePercent), theme.color)}`,
  );
  lines.push("");

  const pairs: [string, string][] = [
    ["Open", formatPrice(quote.open)],
    ["High", formatPrice(quote.high)],
    ["Low", formatPrice(quote.low)],
    ["Prev", formatPrice(quote.previousClose)],
    ["Vol (lot)", formatLot(quote.volume)],
    ["Value", formatCompact(quote.value)],
    ["Freq", formatInt(quote.frequency)],
    ["Foreign net", formatCompact(quote.foreignNet)],
  ];
  if (quote.autoRejectUpper != null) pairs.push(["ARA", formatPrice(quote.autoRejectUpper)]);
  if (quote.autoRejectLower != null) pairs.push(["ARB", formatPrice(quote.autoRejectLower)]);

  for (const [label, value] of pairs) {
    lines.push(` ${dim(pad(label, 12, "left"), theme.color)} ${value}`);
  }

  if (quote.marketData && quote.marketData.length > 0) {
    lines.push("");
    lines.push(` ${dim("PER BOARD", theme.color)}`);
    for (const board of quote.marketData) {
      lines.push(
        ` ${dim(pad(board.board, 10, "left"), theme.color)} ` +
          `${pad(formatLot(board.volume), 10, "right")} lot  ${pad(formatCompact(board.value), 10, "right")}`,
      );
    }
  }
  return lines;
}

/* ---------------------------------- watch row --------------------------------- */

/** Build a `WatchRow` from a quote, preserving an error message when the fetch failed. */
export function watchRowFromQuote(quote: Quote): WatchRow {
  return {
    symbol: quote.symbol,
    ...(quote.name ? { name: quote.name } : {}),
    lastPrice: quote.lastPrice,
    change: quote.change,
    changePercent: quote.changePercent,
    volume: quote.volume,
    value: quote.value,
  };
}

export function watchRowFromError(symbol: string, error: string): WatchRow {
  return {
    symbol,
    lastPrice: null,
    change: null,
    changePercent: null,
    volume: null,
    value: null,
    error,
  };
}
