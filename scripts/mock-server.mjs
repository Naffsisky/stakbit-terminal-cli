#!/usr/bin/env node
/**
 * A mock Stockbit backend, for end-to-end checks without a real account.
 *
 * Serves the three shapes the tracker reads, on the endpoints it actually calls, with the wire
 * spellings Stockbit uses (including `lastprice` without an underscore and `{ raw }` value objects).
 * The refresh route rotates the token exactly like the real one, which is what makes it a useful
 * test of the rotation handling rather than a stub that always says yes.
 *
 *   node scripts/mock-server.mjs [port]
 *
 * Point the CLI at it:
 *   STAKBIT_EXODUS_URL=http://127.0.0.1:8787 STAKBIT_HOME=/tmp/stakbit-e2e \
 *     node dist/cli.js quote BBRI
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const port = Number(process.argv[2] ?? 8787);

/** A token the CLI will accept as a refresh token: a JWT-shaped string. */
const INITIAL_REFRESH = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.initial_refresh_signature";

let refresh = INITIAL_REFRESH;
let rotations = 0;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function quoteBody(symbol, price, change, pct) {
  return {
    data: {
      symbol,
      name: `Mock ${symbol}`,
      lastprice: price,
      change,
      percentage_change: pct,
      open: price - change,
      high: price + 20,
      low: price - 30,
      close: price - change,
      volume: 1_234_567,
      value: { raw: 5_500_000_000, formatted: "5.5B" },
      frequency: 4321,
      fbuy: 1000,
      fsell: 2500,
      fnet: -1500,
      ara: Math.round(price * 1.35),
      arb: Math.round(price * 0.65),
      market_data: [
        { board: "RG", volume: 900_000, value: { raw: 4_000_000_000 }, frequency: 3000 },
        { board: "TN", volume: 334_567, value: { raw: 1_500_000_000 }, frequency: 1321 },
      ],
      bid: [
        { price: price - 10, lot: 120 },
        { price: price - 20, lot: 340 },
        { price: price - 30, lot: 80 },
      ],
      offer: [
        { price: price + 10, lot: 90 },
        { price: price + 20, lot: 210 },
        { price: price + 30, lot: 60 },
      ],
    },
  };
}

const PRICES = {
  BBRI: [4500, -50, -1.1],
  TLKM: [3200, 25, 0.79],
  BBCA: [9850, 0, 0],
};

let printId = 1000;
function tradesBody(symbol) {
  const base = PRICES[symbol]?.[0] ?? 4500;
  const rows = Array.from({ length: 20 }, (_, i) => {
    const buy = i % 3 !== 0;
    return {
      id: String(printId++),
      symbol,
      time: `09:${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}`,
      action: buy ? "buy" : "sell",
      price: buy ? base + 10 : base - 10,
      lot: 10 + i * 3,
      value: { raw: (base + (buy ? 10 : -10)) * (10 + i * 3) * 100 },
      market_board: "RG",
      buyer: buy ? "ZP" : "CC",
      seller: buy ? "CC" : "YP",
      buyer_type: "local",
      seller_type: buy ? "foreign" : "local",
      is_broker_exists: true,
    };
  });
  return { data: { running_trade: rows } };
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const path = url.pathname;

  // The refresh route rotates, exactly like the real one.
  if (path === "/login/refresh" && req.method === "POST") {
    const auth = req.headers.authorization ?? "";
    const presented = auth.replace(/^Bearer\s+/i, "");
    if (!presented) {
      json(res, 401, { message: "missing token" });
      return;
    }
    // Accept the current token only. A stale one gets a 401, which is the behaviour the CLI's
    // rotation handling has to survive.
    if (presented !== refresh) {
      json(res, 401, { message: "refresh token already retired" });
      return;
    }
    rotations++;
    process.stderr.write(`[mock] rotation ${rotations} from ...${presented.slice(-8)}\n`);
    refresh = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "test", n: rotations })).toString("base64url")}.rotated_${rotations}`;
    const accessPayload = Buffer.from(
      JSON.stringify({ sub: "test", exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url");
    json(res, 200, {
      data: {
        access_token: `eyJhbGciOiJIUzI1NiJ9.${accessPayload}.access_${rotations}`,
        refresh_token: refresh,
      },
    });
    return;
  }

  // Everything else needs a bearer.
  const auth = req.headers.authorization ?? "";
  if (!/^Bearer\s+eyJ/.test(auth)) {
    json(res, 401, { message: "unauthorized" });
    return;
  }

  const orderbookMatch = path.match(/^\/company-price-feed\/v2\/orderbook\/companies\/([A-Z-]+)$/);
  if (orderbookMatch) {
    const symbol = orderbookMatch[1];
    const entry = PRICES[symbol];
    if (!entry) {
      json(res, 404, { message: "symbol not found" });
      return;
    }
    json(res, 200, quoteBody(symbol, entry[0], entry[1], entry[2]));
    return;
  }

  if (path === "/order-trade/running-trade") {
    const symbol = url.searchParams.get("symbols") ?? "BBRI";
    json(res, 200, tradesBody(symbol));
    return;
  }

  if (path === "/watchlist") {
    json(res, 200, {
      data: [
        { id: "wl-1", name: "Main", is_default: true },
        { id: "wl-2", name: "Bandar", is_default: false },
      ],
    });
    return;
  }

  if (/^\/watchlist\/[^/]+\/symbols$/.test(path)) {
    json(res, 200, { data: { result: ["BBRI", "TLKM", "BBCA"], total: 3 } });
    return;
  }

  if (path === "/company-price-feed/market-time/session") {
    json(res, 200, { data: { session: "open" } });
    return;
  }

  json(res, 404, { message: `no mock for ${path}` });
});

server.listen(port, "127.0.0.1", () => {
  // Write the initial token to a file so a test can seed the store without guessing it.
  const out = process.env.MOCK_TOKEN_FILE;
  if (out) writeFileSync(out, INITIAL_REFRESH);
  process.stdout.write(`mock stockbit on http://127.0.0.1:${port}\n`);
});
