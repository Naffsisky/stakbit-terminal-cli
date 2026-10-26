/**
 * The market-data endpoints this tracker uses.
 *
 * ## Why these three and not more
 *
 * `stockbit-mcp` exposes ~150 tools because a model can ask anything. A terminal tracker is looked
 * at, not queried, so it needs the handful of things that answer "what is happening right now":
 *
 *   - a quote per symbol, for the watchlist table
 *   - the orderbook, for depth
 *   - the running-trade tape, for prints
 *
 * Everything else (bandarmology, fundamentals, charts) is a different product and is deliberately
 * absent rather than half-built.
 *
 * ## Traps recorded here so they are not rediscovered
 *
 *   - **`symbols`, plural.** The running-trade filter is `symbols`. `symbol` is accepted and
 *     silently ignored, so asking for BRMS returns rows for whatever else was in the account's
 *     list. A dropped filter is worse than an error because the answer looks right.
 *   - **`order_by` is required.** Omitting it is a hard `400 OrderBy is a required field`.
 *   - **The tape is capped at 100 rows** regardless of `limit`, and its window always starts at the
 *     session open. There is no pagination: `offset` and `page` were measured to move nothing.
 *   - **Broker codes may be placeholders.** IDX stopped publishing broker identity in live running
 *     trade in 2021; `is_broker_exists` is the per-row flag, and it is carried through rather than
 *     assumed true.
 */
import { getJson } from "./client.js";
import { findArray, isRecord, toNumber, toText, unwrap } from "./parse.js";
import type {
  MarketBoardRow,
  Orderbook,
  OrderbookLevel,
  Quote,
  Symbol,
  Trade,
  TradeSide,
  WatchlistSummary,
} from "../types.js";

/** The largest tape window the endpoint will answer. See the header. */
export const RUNNING_TRADE_MAX_LIMIT = 100;

export function normalizeSymbol(raw: string): Symbol {
  const trimmed = raw.trim();
  // A token containing whitespace was never a ticker — it is two words the shell split apart, or a
  // phrase. Refusing it here keeps `quote "bukan saham"` from becoming two plausible-looking tickers
  // that then 404 one at a time.
  if (/\s/.test(trimmed)) {
    throw new Error(`"${raw}" is not an IDX ticker (it contains whitespace)`);
  }
  const cleaned = trimmed.toUpperCase();
  if (!/^[A-Z]{2,6}(-[A-Z])?$/.test(cleaned)) {
    throw new Error(`"${raw}" is not an IDX ticker (expected 2-6 letters, optional -X suffix)`);
  }
  return cleaned;
}

/* ---------------------------------- quote ---------------------------------- */

function projectBoards(value: unknown): MarketBoardRow[] | undefined {
  const rows = findArray(value);
  if (!rows) return undefined;
  const out: MarketBoardRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const board = toText(row.board ?? row.board_type ?? row.name ?? row.market_board);
    if (!board) continue;
    out.push({
      board,
      volume: toNumber(row.volume ?? row.lot),
      value: toNumber(row.value),
      frequency: toNumber(row.frequency ?? row.freq),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Project one symbol's orderbook payload into a `Quote`.
 *
 * The same route answers both "quote" and "depth", which is why one call serves both views. Fields
 * are read defensively: `lastprice` (no underscore) is the wire spelling, but `last_price` has been
 * seen too, so both are tried rather than trusting one.
 */
export function projectQuote(body: unknown, symbol: Symbol): Quote {
  const data = unwrap(body);
  const row = isRecord(data) ? data : isRecord(body) ? body : {};

  const lastPrice = toNumber(row.lastprice ?? row.last_price ?? row.close ?? row.price);
  const previousClose = toNumber(row.previous ?? row.prev_close ?? row.previous_close ?? row.close);
  const change = toNumber(row.change);
  const changePercent = toNumber(row.percentage_change ?? row.change_percentage ?? row.percent);

  const quote: Quote = {
    symbol: toText(row.symbol) ?? symbol,
    lastPrice,
    change,
    changePercent,
    open: toNumber(row.open),
    high: toNumber(row.high),
    low: toNumber(row.low),
    previousClose,
    volume: toNumber(row.volume),
    value: toNumber(row.value),
    frequency: toNumber(row.frequency),
    foreignBuy: toNumber(row.fbuy ?? row.foreign_buy),
    foreignSell: toNumber(row.fsell ?? row.foreign_sell),
    foreignNet: toNumber(row.fnet ?? row.net_foreign),
    source: "orderbook.companies",
  };

  const name = toText(row.name ?? row.company_name);
  if (name) quote.name = name;

  const boards = projectBoards(row.market_data);
  if (boards) quote.marketData = boards;

  // Auto-rejection bands appear as `ara`/`arb` or nested in a band object; both spellings are tried
  // because only one of them has been observed on this route.
  const upper = toNumber(row.ara ?? row.auto_reject_upper ?? (isRecord(row.band) ? row.band.upper : undefined));
  const lower = toNumber(row.arb ?? row.auto_reject_lower ?? (isRecord(row.band) ? row.band.lower : undefined));
  if (upper !== null) quote.autoRejectUpper = upper;
  if (lower !== null) quote.autoRejectLower = lower;

  return quote;
}

export async function fetchQuote(symbol: Symbol): Promise<Quote> {
  const sym = normalizeSymbol(symbol);
  const body = await getJson(`/company-price-feed/v2/orderbook/companies/${encodeURIComponent(sym)}`);
  return projectQuote(body, sym);
}

/* -------------------------------- orderbook -------------------------------- */

function projectLevels(value: unknown, priceKeys: string[]): OrderbookLevel[] {
  const rows = findArray(value);
  if (!rows) return [];
  const out: OrderbookLevel[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    let price: number | null = null;
    for (const key of priceKeys) {
      price = toNumber(row[key]);
      if (price !== null) break;
    }
    const lot = toNumber(row.lot ?? row.volume ?? row.lots ?? row.qty);
    // A level with no price cannot be placed on the ladder; a level with no size is legitimately
    // absent rather than zero, so it is dropped rather than drawn as an empty rung.
    if (price === null || lot === null || lot <= 0) continue;
    out.push({
      price,
      lot,
      frequency: toNumber(row.frequency ?? row.freq ?? row.order_count),
    });
  }
  return out;
}

/**
 * Project depth from the same orderbook payload the quote comes from.
 *
 * Bid/offer arrays have appeared under several names. Each candidate is tried in order and the
 * first non-empty one wins, rather than merging them — merging two different renderings of the same
 * book would double-count size.
 */
export function projectOrderbook(body: unknown, symbol: Symbol): Orderbook {
  const data = unwrap(body);
  const row = isRecord(data) ? data : isRecord(body) ? body : {};

  const bidSource = row.bid ?? row.bids ?? row.buy ?? row.buyer;
  const offerSource = row.offer ?? row.offers ?? row.ask ?? row.asks ?? row.sell ?? row.seller;

  const bids = projectLevels(bidSource, ["price", "bid", "bid_price"]).sort((a, b) => b.price - a.price);
  const offers = projectLevels(offerSource, ["price", "offer", "ask", "offer_price"]).sort(
    (a, b) => a.price - b.price,
  );

  const bestBid = bids[0] ?? null;
  const bestOffer = offers[0] ?? null;
  const lastPrice = toNumber(row.lastprice ?? row.last_price ?? row.close ?? row.price);
  const mid =
    bestBid && bestOffer ? (bestBid.price + bestOffer.price) / 2 : lastPrice;

  return {
    symbol,
    bids,
    offers,
    bestBid,
    bestOffer,
    mid,
    bidLot: bids.reduce((sum, l) => sum + l.lot, 0),
    offerLot: offers.reduce((sum, l) => sum + l.lot, 0),
    lastPrice,
  };
}

export async function fetchOrderbook(symbol: Symbol): Promise<Orderbook> {
  const sym = normalizeSymbol(symbol);
  const body = await getJson(`/company-price-feed/v2/orderbook/companies/${encodeURIComponent(sym)}`);
  return projectOrderbook(body, sym);
}

/** One call for both views, so the watchlist does not fetch the same payload twice. */
export async function fetchQuoteAndBook(symbol: Symbol): Promise<{ quote: Quote; book: Orderbook }> {
  const sym = normalizeSymbol(symbol);
  const body = await getJson(`/company-price-feed/v2/orderbook/companies/${encodeURIComponent(sym)}`);
  return { quote: projectQuote(body, sym), book: projectOrderbook(body, sym) };
}

/* ------------------------------ running trade ------------------------------ */

function projectSide(value: unknown): TradeSide {
  const text = (toText(value) ?? "").toLowerCase();
  return text.includes("sell") ? "sell" : "buy";
}

export function projectTrades(body: unknown): Trade[] {
  const data = unwrap(body);
  const rows = findArray(data, ["running_trade", "runningTrade", "trades", "items"]) ?? [];
  const out: Trade[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const price = toNumber(row.price);
    const lot = toNumber(row.lot ?? row.volume);
    if (price === null || lot === null) continue;

    const id = toText(row.id ?? row.trade_id ?? row.running_trade_id) ?? `${row.time}:${price}:${lot}`;
    const buyer = toText(row.buyer ?? row.buyer_code);
    const seller = toText(row.seller ?? row.seller_code);
    // The flag is authoritative when present; without it, a code is only trusted if it looks like
    // one (two letters). An empty string is not a broker, it is an absent field.
    const flag = row.is_broker_exists;
    const brokersPresent =
      typeof flag === "boolean" ? flag : Boolean(buyer && seller && /^[A-Z]{2}$/.test(buyer) && /^[A-Z]{2}$/.test(seller));

    const trade: Trade = {
      id,
      symbol: toText(row.symbol ?? row.code) ?? "",
      time: toText(row.time) ?? "",
      side: projectSide(row.action ?? row.action_type ?? row.side),
      price,
      lot,
      value: toNumber(row.value) ?? price * lot * 100,
      brokersPresent,
    };
    const board = toText(row.market_board ?? row.board);
    if (board) trade.marketBoard = board;
    if (buyer) trade.buyer = buyer;
    if (seller) trade.seller = seller;
    const buyerType = toText(row.buyer_type);
    const sellerType = toText(row.seller_type);
    if (buyerType) trade.buyerType = buyerType;
    if (sellerType) trade.sellerType = sellerType;

    out.push(trade);
  }
  return out;
}

export interface FetchTradesOptions {
  symbol?: Symbol;
  side?: "ALL" | "BUY" | "SELL";
  limit?: number;
  /** 1 = chronological, 2 and 3 are the other two orderings the endpoint accepts. */
  orderBy?: 1 | 2 | 3;
}

export async function fetchTrades(options: FetchTradesOptions = {}): Promise<Trade[]> {
  const limit = Math.min(options.limit ?? RUNNING_TRADE_MAX_LIMIT, RUNNING_TRADE_MAX_LIMIT);
  const body = await getJson("/order-trade/running-trade", {
    query: {
      // Plural. The singular form is accepted and silently ignored — see the file header.
      symbols: options.symbol ? normalizeSymbol(options.symbol) : undefined,
      action_type: options.side && options.side !== "ALL" ? `RUNNING_TRADE_ACTION_TYPE_${options.side}` : undefined,
      limit,
      // Always sent: omitting it is a hard 400.
      order_by: options.orderBy ?? 1,
      sort: "DESC",
    },
  });
  return projectTrades(body);
}

/* -------------------------------- watchlist -------------------------------- */

export function projectWatchlists(body: unknown): WatchlistSummary[] {
  const data = unwrap(body);
  const rows = Array.isArray(data) ? data : (findArray(data, ["result", "watchlist"]) ?? []);
  const out: WatchlistSummary[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = toText(row.id ?? row.watchlist_id);
    const name = toText(row.name ?? row.title);
    if (!id || !name) continue;
    out.push({ id, name, isDefault: row.is_default === true || row.default === true });
  }
  return out;
}

export async function fetchWatchlists(): Promise<WatchlistSummary[]> {
  const body = await getJson("/watchlist");
  return projectWatchlists(body);
}

/** Symbols in a watchlist, in the order Stockbit returns them. */
export function projectWatchlistSymbols(body: unknown): Symbol[] {
  const data = unwrap(body);
  const rows = findArray(data, ["result", "symbols", "items"]) ?? [];
  const out: Symbol[] = [];
  for (const row of rows) {
    if (isRecord(row)) {
      const symbol = toText(row.symbol ?? row.code ?? row.emiten_code);
      if (symbol) out.push(symbol.toUpperCase());
    } else {
      const symbol = toText(row);
      if (symbol) out.push(symbol.toUpperCase());
    }
  }
  return [...new Set(out)];
}

export async function fetchWatchlistSymbols(id: string): Promise<Symbol[]> {
  const body = await getJson(`/watchlist/${encodeURIComponent(id)}/symbols`, {
    // `limit` is REQUIRED here — the endpoint does not default to "all", and omitting it returns a
    // short page that looks complete.
    query: { limit: 500 },
  });
  return projectWatchlistSymbols(body);
}

/* ------------------------------ market session ------------------------------ */

export function projectSession(body: unknown): unknown {
  return unwrap(body);
}

export async function fetchMarketSession(): Promise<unknown> {
  const body = await getJson("/company-price-feed/market-time/session");
  return projectSession(body);
}
