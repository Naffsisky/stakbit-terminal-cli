/**
 * Configuration and paths.
 *
 * Everything lives under `~/.stakbit` unless `STAKBIT_HOME` says otherwise, so a user can keep
 * several accounts apart, and so tests never touch a real store.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  /** Directory holding the token store, cache and logs. */
  home: string;
  /** Where the refresh token and access cache are written. */
  storeDir: string;
  /** Stockbit backend hosts. Named so a test can point them somewhere harmless. */
  hosts: {
    /** Market data: quotes, orderbook, running trade, charts. */
    exodus: string;
    /** Stockbit Sekuritas: the brokerage account. Read-only here. */
    carina: string;
    /** Website origin, used for the Origin/Referer headers the API expects. */
    web: string;
  };
  /** Default watchlist id, when the user pinned one. */
  watchlistId?: string;
  /** Poll interval for the live views, in milliseconds. */
  pollMs: number;
  /** Whether to skip the market-hours check and poll anyway. */
  alwaysPoll: boolean;
}

export const DEFAULT_POLL_MS = 2000;

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.STAKBIT_HOME?.trim();
  return raw ? resolve(expandHome(raw)) : join(homedir(), ".stakbit");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = resolveHome(env);
  const pollRaw = Number(env.STAKBIT_POLL_MS);
  const pollMs = Number.isFinite(pollRaw) && pollRaw >= 500 ? Math.floor(pollRaw) : DEFAULT_POLL_MS;
  const watchlistId = env.STAKBIT_WATCHLIST_ID?.trim();

  return {
    home,
    storeDir: home,
    hosts: {
      exodus: env.STAKBIT_EXODUS_URL?.trim() || "https://exodus.stockbit.com",
      carina: env.STAKBIT_CARINA_URL?.trim() || "https://carina.stockbit.com",
      web: env.STAKBIT_WEB_URL?.trim() || "https://stockbit.com",
    },
    ...(watchlistId ? { watchlistId } : {}),
    pollMs,
    alwaysPoll: env.STAKBIT_ALWAYS_POLL === "1",
  };
}

/** Files inside the store. Kept in one place so a backup is obvious. */
export function storePaths(cfg: Config) {
  return {
    dir: cfg.storeDir,
    refresh: join(cfg.storeDir, "refresh.enc"),
    access: join(cfg.storeDir, "access.enc"),
    meta: join(cfg.storeDir, "meta.json"),
    settings: join(cfg.storeDir, "settings.json"),
  };
}
