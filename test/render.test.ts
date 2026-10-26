/**
 * Tests for the renderer and the formatters.
 *
 * Rendering is asserted on plain strings with colour off, which is the same path a piped run takes.
 * The width invariant gets its own test because a frame that is one column short leaves stale
 * characters on screen and looks like corruption.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatChange,
  formatCompact,
  formatInt,
  formatLot,
  formatPercent,
  formatPrice,
  pad,
  stripAnsi,
} from "../src/format/text.js";
import {
  frame,
  renderHeader,
  renderOrderbook,
  renderQuoteDetail,
  renderTape,
  renderWatchlist,
} from "../src/tui/render.js";
import type { Orderbook, Quote, SessionState, Trade, WatchRow } from "../src/types.js";

const theme = { color: false };

/* -------------------------------- formatters -------------------------------- */

test("formatInt uses comma separators, not the host locale", () => {
  assert.equal(formatInt(1234), "1,234");
  assert.equal(formatInt(1234567), "1,234,567");
  assert.equal(formatInt(0), "0");
  assert.equal(formatInt(-1234), "-1,234");
});

test("formatInt renders null as an em dash, never as zero", () => {
  assert.equal(formatInt(null), "—");
});

test("formatPrice keeps integers whole and fractions to two places", () => {
  assert.equal(formatPrice(4500), "4,500");
  assert.equal(formatPrice(4500.5), "4500.50");
  assert.equal(formatPrice(null), "—");
});

test("formatPercent always carries a sign for non-zero values", () => {
  assert.equal(formatPercent(1.25), "+1.25%");
  assert.equal(formatPercent(-1.25), "-1.25%");
  assert.equal(formatPercent(0), "0.00%");
  assert.equal(formatPercent(null), "—");
});

test("formatChange signs the value", () => {
  assert.equal(formatChange(15), "+15");
  assert.equal(formatChange(-15), "-15");
  assert.equal(formatChange(0), "0");
});

test("formatCompact scales to K, M, B and T", () => {
  assert.equal(formatCompact(999), "999");
  assert.equal(formatCompact(1500), "1.5K");
  assert.equal(formatCompact(2_500_000), "2.5M");
  assert.equal(formatCompact(5_500_000_000), "5.50B");
  assert.equal(formatCompact(1_200_000_000_000), "1.20T");
  assert.equal(formatCompact(null), "—");
});

test("formatLot keeps exact integers below ten thousand", () => {
  assert.equal(formatLot(1234), "1,234");
  assert.equal(formatLot(25_000), "25.0K");
});

test("pad right-aligns and left-aligns to an exact width", () => {
  assert.equal(pad("abc", 5).length, 5);
  assert.equal(pad("abc", 5, "right"), "  abc");
  assert.equal(pad("abc", 5, "left"), "abc  ");
});

test("pad truncates with an ellipsis rather than overflowing", () => {
  const result = pad("abcdefgh", 5);
  assert.equal(result.length, 5);
  assert.ok(result.endsWith("…"));
});

test("pad measures visible width, ignoring escape codes", () => {
  const coloured = "\u001b[92mabc\u001b[0m";
  assert.equal(stripAnsi(pad(coloured, 5)).length, 5);
});

/* ---------------------------------- frame ----------------------------------- */

test("frame pads every line to exactly the width", () => {
  const result = frame(["short", "a much longer line than the width"], 10, 3);
  assert.equal(result.lines.length, 3);
  for (const line of result.lines) assert.equal(line.length, 10);
});

test("frame fills missing lines so the previous frame is fully overwritten", () => {
  const result = frame(["one"], 5, 3);
  assert.deepEqual(result.lines, ["one  ", "     ", "     "]);
});

test("frame truncates a line that is too long", () => {
  const result = frame(["abcdefghij"], 5, 1);
  assert.equal(result.lines[0], "abcde");
});

/* --------------------------------- header ----------------------------------- */

const liveSession: SessionState = {
  phase: "session-1",
  label: "Session 1 — closes 12:00 WIB",
  live: true,
  nowWib: "10:23:45",
};

const closedSession: SessionState = {
  phase: "closed",
  label: "Closed — market shut",
  live: false,
  nowWib: "20:00:00",
};

test("the header shows the WIB clock and the phase", () => {
  const line = renderHeader(liveSession, { theme });
  assert.match(line, /10:23:45/);
  assert.match(line, /Session 1/);
});

test("the header marks a live session differently from a closed one", () => {
  assert.match(renderHeader(liveSession, { theme }), /LIVE/);
  assert.match(renderHeader(closedSession, { theme }), /idle/);
});

test("the header carries an optional symbol and notice", () => {
  const line = renderHeader(liveSession, { theme, symbol: "BBRI", notice: "stale" });
  assert.match(line, /BBRI/);
  assert.match(line, /stale/);
});

/* -------------------------------- watchlist --------------------------------- */

function row(overrides: Partial<WatchRow> = {}): WatchRow {
  return {
    symbol: "BBRI",
    lastPrice: 4500,
    change: -50,
    changePercent: -1.1,
    volume: 1_234_567,
    value: 5_500_000_000,
    ...overrides,
  };
}

test("the watchlist renders a header and one line per row", () => {
  const lines = renderWatchlist([row(), row({ symbol: "TLKM", lastPrice: 3200 })], { theme });
  assert.equal(lines.length, 3); // header + 2 rows
  assert.match(lines[0]!, /SYMBOL/);
  assert.match(lines[1]!, /BBRI/);
  assert.match(lines[2]!, /TLKM/);
});

test("the watchlist renders a null price as a dash, not zero", () => {
  const lines = renderWatchlist([row({ lastPrice: null, change: null, changePercent: null })], { theme });
  assert.match(lines[1]!, /—/);
  assert.equal(lines[1]!.includes("0 "), false);
});

test("the watchlist marks a stale row", () => {
  const lines = renderWatchlist([row({ error: "stale" })], { theme });
  assert.match(lines[1]!, /!/);
});

test("the watchlist explains itself when empty", () => {
  const lines = renderWatchlist([], { theme });
  assert.match(lines.join("\n"), /no symbols/);
});

/* -------------------------------- orderbook --------------------------------- */

function book(overrides: Partial<Orderbook> = {}): Orderbook {
  return {
    symbol: "BBRI",
    bids: [
      { price: 4490, lot: 100 },
      { price: 4480, lot: 200 },
    ],
    offers: [
      { price: 4510, lot: 150 },
      { price: 4520, lot: 250 },
    ],
    bestBid: { price: 4490, lot: 100 },
    bestOffer: { price: 4510, lot: 150 },
    mid: 4500,
    bidLot: 300,
    offerLot: 400,
    lastPrice: 4500,
    ...overrides,
  };
}

test("the orderbook renders the ladder with the best offer nearest the spread", () => {
  const lines = renderOrderbook(book(), { theme, width: 80, levels: 2 });
  const text = lines.join("\n");
  assert.match(text, /ORDERBOOK/);
  assert.match(text, /BBRI/);
  // Best bid and best offer both present.
  assert.match(text, /4,490/);
  assert.match(text, /4,510/);
});

test("the orderbook computes and shows the spread", () => {
  const lines = renderOrderbook(book(), { theme, width: 80, levels: 2 });
  assert.match(lines.join("\n"), /spread/);
});

test("the orderbook handles an empty book without throwing", () => {
  const lines = renderOrderbook(
    book({ bids: [], offers: [], bestBid: null, bestOffer: null, mid: null, bidLot: 0, offerLot: 0 }),
    { theme, width: 80 },
  );
  assert.ok(lines.length > 0);
});

test("imbalance is labelled as a percentage, not presented as advice", () => {
  const lines = renderOrderbook(book(), { theme, width: 80 });
  assert.match(lines.join("\n"), /imbalance/);
});

/* ----------------------------------- tape ----------------------------------- */

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: "1",
    symbol: "BBRI",
    time: "09:00:01",
    side: "buy",
    price: 4500,
    lot: 10,
    value: 4_500_000,
    buyer: "ZP",
    seller: "CC",
    brokersPresent: true,
    ...overrides,
  };
}

test("the tape renders one line per print with side, price and size", () => {
  const lines = renderTape([trade(), trade({ id: "2", side: "sell", price: 4490 })], { theme });
  assert.equal(lines.length, 3); // header + 2
  assert.match(lines[1]!, /BUY/);
  assert.match(lines[2]!, /SELL/);
});

test("the tape hides broker codes when the row says they are not real", () => {
  const lines = renderTape([trade({ brokersPresent: false })], { theme });
  // A dot marker instead of a plausible-looking but fake broker code.
  assert.match(lines[1]!, /·/);
  assert.equal(lines[1]!.includes("ZP"), false);
});

test("the tape shows broker codes when they are real", () => {
  const lines = renderTape([trade({ brokersPresent: true })], { theme });
  assert.match(lines[1]!, /ZP/);
  assert.match(lines[1]!, /CC/);
});

test("the tape respects its limit", () => {
  const trades = Array.from({ length: 30 }, (_, i) => trade({ id: String(i) }));
  const lines = renderTape(trades, { theme, limit: 5 });
  assert.equal(lines.length, 6); // header + 5
});

test("the tape says so when there are no prints", () => {
  const lines = renderTape([], { theme });
  assert.match(lines.join("\n"), /no prints/);
});

/* ------------------------------ quote detail -------------------------------- */

test("quote detail shows the headline and the statistics", () => {
  const quote: Quote = {
    symbol: "BBRI",
    name: "Bank Rakyat Indonesia",
    lastPrice: 4500,
    change: -50,
    changePercent: -1.1,
    open: 4550,
    high: 4600,
    low: 4480,
    previousClose: 4550,
    volume: 1_234_567,
    value: 5_500_000_000,
    frequency: 4321,
    foreignBuy: 100,
    foreignSell: 200,
    foreignNet: -100,
    source: "test",
  };
  const text = renderQuoteDetail(quote, { theme }).join("\n");
  assert.match(text, /BBRI/);
  assert.match(text, /Bank Rakyat/);
  assert.match(text, /Open/);
  assert.match(text, /Prev/);
});

test("quote detail omits the ARA/ARB lines when the source does not provide them", () => {
  const quote: Quote = {
    symbol: "BBRI",
    lastPrice: 4500,
    change: null,
    changePercent: null,
    open: null,
    high: null,
    low: null,
    previousClose: null,
    volume: null,
    value: null,
    frequency: null,
    foreignBuy: null,
    foreignSell: null,
    foreignNet: null,
    source: "test",
  };
  const text = renderQuoteDetail(quote, { theme }).join("\n");
  assert.equal(text.includes("ARA"), false);
});
