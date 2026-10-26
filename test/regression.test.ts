/**
 * Regression tests for bugs found while exercising the CLI end to end.
 *
 * Each one failed at some point, so each gets a test rather than only a fix — the point of this file
 * is that these specific mistakes cannot come back silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeSymbol, projectOrderbook } from "../src/api/market.js";
import { renderOrderbook } from "../src/tui/render.js";
import { UsageError, addSymbols, readSettings, resolveSymbols } from "../src/settings.js";

/** Point the store at a throwaway directory for the duration of a test. */
function withTempHome<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), "stakbit-reg-"));
  const previous = process.env.STAKBIT_HOME;
  process.env.STAKBIT_HOME = dir;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.STAKBIT_HOME;
    else process.env.STAKBIT_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------- BUG 1: a phrase became two plausible tickers ------------------- */

test("a symbol containing whitespace is refused, not split into two tickers", () => {
  // `quote "bukan saham"` used to become BUKAN and SAHAM, each of which then 404'd separately —
  // which hides the actual mistake behind two unrelated-looking upstream errors.
  assert.throws(() => normalizeSymbol("bukan saham"), /whitespace/);
});

test("resolveSymbols refuses a phrase instead of splitting it", () => {
  withTempHome(() => {
    assert.throws(() => resolveSymbols("bukan saham"), (err: unknown) => err instanceof UsageError);
  });
});

test("resolveSymbols still accepts comma-separated symbols with spaces", () => {
  withTempHome(() => {
    const { symbols } = resolveSymbols("BBRI, TLKM");
    assert.deepEqual(symbols, ["BBRI", "TLKM"]);
  });
});

test("resolveSymbols de-duplicates", () => {
  withTempHome(() => {
    assert.deepEqual(resolveSymbols("BBRI,BBRI,TLKM").symbols, ["BBRI", "TLKM"]);
  });
});

/* ---------------------- BUG 2: the orderbook padded with empty rungs ---------------------- */

test("the orderbook never renders more rungs than there is data for", () => {
  // Asking for 10 levels against a 3-deep book used to print seven blank rows, which reads as
  // missing depth rather than as a short book, and pushes the spread line off the bottom.
  const book = projectOrderbook(
    {
      data: {
        bid: [
          { price: 99, lot: 1 },
          { price: 98, lot: 2 },
          { price: 97, lot: 3 },
        ],
        offer: [
          { price: 101, lot: 1 },
          { price: 102, lot: 2 },
          { price: 103, lot: 3 },
        ],
      },
    },
    "TEST",
  );
  const lines = renderOrderbook(book, { theme: { color: false }, width: 80, levels: 10 });
  const blank = lines.filter((line) => line.trim() === "");
  assert.equal(blank.length, 0, "the ladder contains blank rungs");
  // title + column header + 3 rungs + rule + spread + spread %
  assert.equal(lines.length, 8);
});

test("the orderbook renders a single rung when only one side has one level", () => {
  const book = projectOrderbook({ data: { bid: [{ price: 99, lot: 1 }] } }, "TEST");
  const lines = renderOrderbook(book, { theme: { color: false }, width: 80, levels: 10 });
  assert.ok(lines.length >= 3);
});

/* ------------------------ BUG 3: an empty watchlist hid the reason ------------------------ */

test("an empty saved list falls back to defaults rather than showing nothing", () => {
  withTempHome(() => {
    const { symbols, source } = resolveSymbols();
    assert.equal(source, "default");
    assert.ok(symbols.length > 0);
  });
});

test("a saved list wins over the defaults", () => {
  withTempHome(() => {
    addSymbols(["BBRI"]);
    const { symbols, source } = resolveSymbols();
    assert.equal(source, "settings");
    assert.deepEqual(symbols, ["BBRI"]);
  });
});

test("settings survive a round trip", () => {
  withTempHome(() => {
    addSymbols(["BBRI", "TLKM"]);
    assert.deepEqual(readSettings().symbols, ["BBRI", "TLKM"]);
  });
});

test("a corrupt settings file does not stop the tool", () => {
  withTempHome(() => {
    const dir = process.env.STAKBIT_HOME!;
    writeFileSync(join(dir, "settings.json"), "{not json");
    // Falling back to defaults is the right failure: the alternative is refusing to run because a
    // convenience file was truncated.
    assert.equal(readSettings().symbols.length, 0);
    assert.equal(resolveSymbols().source, "default");
  });
});
