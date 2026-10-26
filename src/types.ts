/**
 * Shared types for the tracker.
 *
 * Everything here is already normalised: the API layer's job is to turn Stockbit's wire shapes into
 * these, and the TUI's job is to never see a wire key. That separation is what lets the renderer be
 * tested without a network, and it is why `quote` has a `lastPrice` field rather than the API's
 * `lastprice` — the wire spelling stops at `src/api/`.
 */

/** An IDX ticker: uppercase, optional single hyphenated suffix (`BUKA-W`, `BBRI-R`). */
export type Symbol = string;

export interface Quote {
  symbol: Symbol;
  name?: string;
  lastPrice: number | null;
  /** Absolute change against the previous close, in IDR. */
  change: number | null;
  /** Percentage change, e.g. `-1.25` for -1.25%. */
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** Previous close — the reference `change` is measured from. */
  previousClose: number | null;
  /** Volume in LOTS. One lot is 100 shares; the wire sends lots and we keep them. */
  volume: number | null;
  /** Traded value in IDR. */
  value: number | null;
  frequency: number | null;
  foreignBuy: number | null;
  foreignSell: number | null;
  foreignNet: number | null;
  /** Exchange-imposed rejection bands for the session, when the source provides them. */
  autoRejectUpper?: number | null;
  autoRejectLower?: number | null;
  /** Per-board breakdown, when the orderbook route supplied one. */
  marketData?: MarketBoardRow[];
  /** Where this reading came from, so a stale cache is visible rather than implied. */
  source: string;
}

export interface MarketBoardRow {
  board: string;
  volume: number | null;
  value: number | null;
  frequency: number | null;
}

export interface OrderbookLevel {
  price: number;
  /** Lots resting at this price. */
  lot: number;
  /** Number of orders at this price, when the source counts them. */
  frequency?: number | null;
}

export interface Orderbook {
  symbol: Symbol;
  bids: OrderbookLevel[];
  offers: OrderbookLevel[];
  /** Best bid and offer, pre-resolved because every caller wants them. */
  bestBid: OrderbookLevel | null;
  bestOffer: OrderbookLevel | null;
  /** Midpoint of best bid/offer, or the last price when one side is empty. */
  mid: number | null;
  /** Total lots resting on each side, for imbalance readings. */
  bidLot: number;
  offerLot: number;
  lastPrice: number | null;
}

/** Aggressor side of a print. `buy` means the buyer crossed the spread. */
export type TradeSide = "buy" | "sell";

export interface Trade {
  /** Upstream print id. Used to dedupe across polls, never shown. */
  id: string;
  symbol: Symbol;
  time: string;
  side: TradeSide;
  price: number;
  /** Lots. */
  lot: number;
  /** IDR value of the print. */
  value: number;
  marketBoard?: string;
  buyer?: string | null;
  seller?: string | null;
  buyerType?: string | null;
  sellerType?: string | null;
  /**
   * Whether the broker codes on this row are real.
   *
   * IDX stopped publishing broker identity in live running trade in December 2021. Stockbit still
   * populates the fields on some routes and leaves them empty on others, and it does not always say
   * which. Rendering a broker code that is actually a placeholder is worse than rendering nothing,
   * so this flag is carried through to the UI.
   */
  brokersPresent: boolean;
}

export interface WatchlistSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

/** One row in the watchlist table. */
export interface WatchRow {
  symbol: Symbol;
  name?: string;
  lastPrice: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
  value: number | null;
  /** Set when the last refresh for this row failed, so the UI can show a stale marker. */
  error?: string;
}

/** IDX session phase, computed locally from the clock (holidays are not modelled). */
export type SessionPhase =
  | "pre-opening"
  | "session-1"
  | "break"
  | "session-2"
  | "post-closing"
  | "closed"
  | "weekend";

export interface SessionState {
  phase: SessionPhase;
  /** Human label in WIB, e.g. `Session 1 — closes 12:00 WIB`. */
  label: string;
  /** True when quotes can still move. */
  live: boolean;
  nowWib: string;
}
