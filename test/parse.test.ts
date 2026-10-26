/**
 * Tests for the wire projection.
 *
 * The theme is the same as the module's: a value that cannot be read must become `null`, never `0`,
 * and a row must survive. These tests exist because that rule is easy to state and easy to break —
 * one `?? 0` anywhere turns "we do not know the price" into "the price is zero".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findArray, toNumber, toText, unwrap } from "../src/api/parse.js";
import {
  projectOrderbook,
  projectQuote,
  projectTrades,
  projectWatchlistSymbols,
  projectWatchlists,
  normalizeSymbol,
} from "../src/api/market.js";

/* ---------------------------------- toNumber --------------------------------- */

test("toNumber reads a plain number", () => {
  assert.equal(toNumber(1234), 1234);
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber(-5.5), -5.5);
});

test("toNumber reads a numeric string", () => {
  assert.equal(toNumber("1234"), 1234);
  assert.equal(toNumber("  42  "), 42);
});

test("toNumber reads a thousands-separated string", () => {
  // Stockbit formats values this way in several places. Reading it as NaN would blank a column.
  assert.equal(toNumber("1,234"), 1234);
  assert.equal(toNumber("1,234,567"), 1234567);
});

test("toNumber reads the { raw, formatted } shape", () => {
  assert.equal(toNumber({ raw: 1234, formatted: "1,234" }), 1234);
  assert.equal(toNumber({ value: 99 }), 99);
});

test("an EMPTY field is null, not zero", () => {
  // The distinction this whole module exists for. `Number("")` is 0, so a naive implementation would
  // report a price of zero for an absent field.
  assert.equal(toNumber(""), null);
  assert.equal(toNumber("   "), null);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber("-"), null);
});

test("an unreadable string is null, not NaN", () => {
  assert.equal(toNumber("n/a"), null);
  assert.equal(toNumber("abc"), null);
  // NaN would propagate through arithmetic and render as "NaN" on screen.
  assert.ok(Number.isNaN(Number("abc")));
});

test("a real zero is preserved as zero", () => {
  // Zero is a value the wire can legitimately mean for a change, a percentage, or a foreign net.
  assert.equal(toNumber(0), 0);
  assert.equal(toNumber("0"), 0);
  assert.equal(toNumber("0.00"), 0);
});

test("Infinity and NaN are refused rather than passed through", () => {
  assert.equal(toNumber(Infinity), null);
  assert.equal(toNumber(NaN), null);
});

/* ---------------------------------- toText ----------------------------------- */

test("toText trims and refuses empty strings", () => {
  assert.equal(toText("  BBRI "), "BBRI");
  assert.equal(toText(""), null);
  assert.equal(toText("   "), null);
  assert.equal(toText(42), "42");
  assert.equal(toText(null), null);
});

/* ---------------------------------- unwrap ----------------------------------- */

test("unwrap pulls the data envelope", () => {
  assert.deepEqual(unwrap({ data: { a: 1 } }), { a: 1 });
});

test("unwrap distinguishes a missing envelope from an empty payload", () => {
  // `undefined` means "there was no envelope", which is a shape problem. `null` means "the envelope
  // held null", which is an empty answer. Collapsing them would hide a schema drift.
  assert.equal(unwrap({}), undefined);
  assert.equal(unwrap({ data: null }), null);
  assert.equal(unwrap(null), undefined);
});

/* --------------------------------- findArray --------------------------------- */

test("findArray locates an array one envelope down", () => {
  const payload = { data: { result: [{ a: 1 }] } };
  assert.deepEqual(findArray(payload, ["result"]), [{ a: 1 }]);
});

test("findArray falls back to any array when the named keys are absent", () => {
  const payload = { data: { items: [{ a: 1 }] } };
  assert.deepEqual(findArray(payload, ["result"]), [{ a: 1 }]);
});

test("findArray returns null rather than an empty array when nothing is there", () => {
  // An empty array would read as "there are no rows", which is a claim. `null` is "not found".
  assert.equal(findArray({ data: {} }), null);
  assert.equal(findArray(null), null);
});

/* ---------------------------------- quote ------------------------------------ */

test("projectQuote reads the wire spellings, including lastprice without an underscore", () => {
  const quote = projectQuote(
    {
      data: {
        symbol: "BBRI",
        lastprice: 4500,
        change: -50,
        percentage_change: -1.1,
        open: 4550,
        high: 4600,
        low: 4480,
        volume: 1234567,
        value: { raw: 5500000000 },
        frequency: 4321,
        fbuy: 100,
        fsell: 200,
        fnet: -100,
      },
    },
    "BBRI",
  );
  assert.equal(quote.symbol, "BBRI");
  assert.equal(quote.lastPrice, 4500);
  assert.equal(quote.change, -50);
  assert.equal(quote.changePercent, -1.1);
  assert.equal(quote.volume, 1234567);
  assert.equal(quote.value, 5500000000);
  assert.equal(quote.foreignNet, -100);
});

test("projectQuote leaves an absent price null instead of inventing zero", () => {
  const quote = projectQuote({ data: { symbol: "XXXX" } }, "XXXX");
  assert.equal(quote.lastPrice, null);
  assert.equal(quote.change, null);
  assert.equal(quote.volume, null);
});

test("projectQuote accepts the underscore spelling as a fallback", () => {
  const quote = projectQuote({ data: { last_price: 1000 } }, "TEST");
  assert.equal(quote.lastPrice, 1000);
});

test("projectQuote reads per-board market data when present", () => {
  const quote = projectQuote(
    {
      data: {
        lastprice: 100,
        market_data: [
          { board: "RG", volume: 10, value: 1000, frequency: 2 },
          { board: "TN", volume: 20, value: 2000, frequency: 3 },
        ],
      },
    },
    "TEST",
  );
  assert.equal(quote.marketData?.length, 2);
  assert.equal(quote.marketData?.[0]?.board, "RG");
});

test("projectQuote omits marketData entirely when the array is absent", () => {
  // Absent must stay absent so the renderer can skip the section, rather than printing an empty one.
  const quote = projectQuote({ data: { lastprice: 100 } }, "TEST");
  assert.equal(quote.marketData, undefined);
});

/* -------------------------------- orderbook ---------------------------------- */

test("projectOrderbook sorts bids descending and offers ascending", () => {
  const book = projectOrderbook(
    {
      data: {
        lastprice: 100,
        bid: [
          { price: 98, lot: 10 },
          { price: 99, lot: 20 },
        ],
        offer: [
          { price: 102, lot: 30 },
          { price: 101, lot: 40 },
        ],
      },
    },
    "TEST",
  );
  assert.equal(book.bids[0]?.price, 99);
  assert.equal(book.offers[0]?.price, 101);
  assert.equal(book.bestBid?.price, 99);
  assert.equal(book.bestOffer?.price, 101);
  assert.equal(book.mid, 100);
});

test("projectOrderbook drops levels with no price rather than drawing them at zero", () => {
  const book = projectOrderbook(
    {
      data: {
        bid: [
          { price: 99, lot: 10 },
          { lot: 5 }, // no price
        ],
      },
    },
    "TEST",
  );
  assert.equal(book.bids.length, 1);
});

test("projectOrderbook drops levels with zero size", () => {
  const book = projectOrderbook(
    { data: { bid: [{ price: 99, lot: 0 }, { price: 98, lot: 10 }] } },
    "TEST",
  );
  assert.equal(book.bids.length, 1);
  assert.equal(book.bids[0]?.price, 98);
});

test("projectOrderbook falls back to the last price for mid when one side is empty", () => {
  const book = projectOrderbook({ data: { lastprice: 500, bid: [{ price: 499, lot: 1 }] } }, "TEST");
  assert.equal(book.bestOffer, null);
  assert.equal(book.mid, 500);
});

test("projectOrderbook totals lots per side for the imbalance reading", () => {
  const book = projectOrderbook(
    {
      data: {
        bid: [
          { price: 99, lot: 10 },
          { price: 98, lot: 15 },
        ],
        offer: [{ price: 101, lot: 5 }],
      },
    },
    "TEST",
  );
  assert.equal(book.bidLot, 25);
  assert.equal(book.offerLot, 5);
});

test("projectOrderbook accepts the alternative array names", () => {
  const book = projectOrderbook({ data: { bids: [{ price: 99, lot: 1 }], asks: [{ price: 101, lot: 2 }] } }, "TEST");
  assert.equal(book.bestBid?.price, 99);
  assert.equal(book.bestOffer?.price, 101);
});

/* ---------------------------------- trades ----------------------------------- */

test("projectTrades reads the running_trade array and the aggressor side", () => {
  const trades = projectTrades({
    data: {
      running_trade: [
        { id: "1", symbol: "BBRI", time: "09:00:01", action: "buy", price: 4500, lot: 10, value: { raw: 4500000 } },
        { id: "2", symbol: "BBRI", time: "09:00:02", action: "sell", price: 4490, lot: 5, value: { raw: 2245000 } },
      ],
    },
  });
  assert.equal(trades.length, 2);
  assert.equal(trades[0]?.side, "buy");
  assert.equal(trades[1]?.side, "sell");
  assert.equal(trades[0]?.price, 4500);
  assert.equal(trades[0]?.value, 4500000);
});

test("projectTrades derives value from price and lots when the wire omits it", () => {
  const trades = projectTrades({
    data: { running_trade: [{ id: "1", price: 1000, lot: 2, action: "buy" }] },
  });
  // 1 lot is 100 shares, so 2 lots at 1000 is 200,000 IDR.
  assert.equal(trades[0]?.value, 200_000);
});

test("projectTrades marks brokers absent when the flag says so", () => {
  const trades = projectTrades({
    data: {
      running_trade: [
        { id: "1", price: 1000, lot: 1, action: "buy", buyer: "XX", seller: "YY", is_broker_exists: false },
      ],
    },
  });
  // A placeholder code rendered as a real broker is worse than a dash.
  assert.equal(trades[0]?.brokersPresent, false);
});

test("projectTrades marks brokers present when the flag says so", () => {
  const trades = projectTrades({
    data: {
      running_trade: [{ id: "1", price: 1000, lot: 1, action: "buy", buyer: "ZP", seller: "CC", is_broker_exists: true }],
    },
  });
  assert.equal(trades[0]?.brokersPresent, true);
});

test("projectTrades infers brokers present from two-letter codes when the flag is absent", () => {
  const trades = projectTrades({
    data: { running_trade: [{ id: "1", price: 1000, lot: 1, action: "buy", buyer: "ZP", seller: "CC" }] },
  });
  assert.equal(trades[0]?.brokersPresent, true);
});

test("projectTrades refuses a row with no readable price", () => {
  const trades = projectTrades({
    data: { running_trade: [{ id: "1", lot: 1, action: "buy" }] },
  });
  assert.equal(trades.length, 0);
});

test("projectTrades returns an empty list rather than throwing on an empty payload", () => {
  assert.deepEqual(projectTrades({ data: {} }), []);
  assert.deepEqual(projectTrades(null), []);
});

/* -------------------------------- watchlists --------------------------------- */

test("projectWatchlists reads ids, names and the default flag", () => {
  const lists = projectWatchlists({
    data: [
      { id: "abc", name: "Main", is_default: true },
      { id: "def", name: "Watch 2", is_default: false },
    ],
  });
  assert.equal(lists.length, 2);
  assert.equal(lists[0]?.isDefault, true);
  assert.equal(lists[1]?.isDefault, false);
});

test("projectWatchlists drops a row without an id, since it cannot be fetched", () => {
  const lists = projectWatchlists({ data: [{ name: "No id" }, { id: "x", name: "Has id" }] });
  assert.equal(lists.length, 1);
  assert.equal(lists[0]?.id, "x");
});

test("projectWatchlistSymbols reads bare tickers and objects alike", () => {
  const symbols = projectWatchlistSymbols({
    data: { result: ["BBRI", { symbol: "TLKM" }, { code: "asii" }] },
  });
  assert.deepEqual(symbols, ["BBRI", "TLKM", "ASII"]);
});

test("projectWatchlistSymbols de-duplicates", () => {
  const symbols = projectWatchlistSymbols({ data: { result: ["BBRI", "BBRI", { symbol: "BBRI" }] } });
  assert.deepEqual(symbols, ["BBRI"]);
});

/* --------------------------------- symbols ----------------------------------- */

test("normalizeSymbol uppercases and accepts a warrant suffix", () => {
  assert.equal(normalizeSymbol("bbri"), "BBRI");
  assert.equal(normalizeSymbol(" buka-w "), "BUKA-W");
  assert.equal(normalizeSymbol("IHSG"), "IHSG");
});

test("normalizeSymbol refuses something that is not a ticker", () => {
  assert.throws(() => normalizeSymbol("not a ticker"));
  assert.throws(() => normalizeSymbol("TOOLONGSYMBOL"));
  assert.throws(() => normalizeSymbol(""));
});
