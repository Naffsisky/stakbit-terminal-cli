/**
 * Local settings: the symbol list, and the last watchlist id.
 *
 * Kept in `settings.json` rather than a database because the whole state is a few dozen tickers. A
 * SQLite file would be more machinery than the problem needs, and it would make `cat` the wrong tool
 * for inspecting it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, storePaths } from "./config.js";
import { normalizeSymbol } from "./api/market.js";

export interface Settings {
  /** Symbols shown by default when no `--symbols` is given. */
  symbols: string[];
  /** Last watchlist id used, so the next run does not re-resolve it. */
  watchlistId?: string;
  /** Last focus symbol for tape mode. */
  focus?: string;
}

/**
 * A problem with what the user typed, as opposed to a problem with the network or the account.
 *
 * Kept separate so the CLI can exit 2 and print the usage line, which is the difference between
 * "you made a typo" and "Stockbit is down" for anything scripting this.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const EMPTY: Settings = { symbols: [] };

export function readSettings(): Settings {
  const path = storePaths(loadConfig()).settings;
  if (!existsSync(path)) return { ...EMPTY };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    return {
      symbols: Array.isArray(raw.symbols) ? raw.symbols.filter((s): s is string => typeof s === "string") : [],
      ...(typeof raw.watchlistId === "string" ? { watchlistId: raw.watchlistId } : {}),
      ...(typeof raw.focus === "string" ? { focus: raw.focus } : {}),
    };
  } catch {
    // A corrupt settings file must not stop the tool from running. It is regenerated on next write.
    return { ...EMPTY };
  }
}

export function writeSettings(settings: Settings): void {
  const path = storePaths(loadConfig()).settings;
  mkdirSync(loadConfig().home, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

/** Add symbols, de-duplicated and normalised. Returns the resulting list. */
export function addSymbols(input: string[]): string[] {
  const settings = readSettings();
  const set = new Set(settings.symbols);
  for (const raw of input) {
    // Accept a comma-separated argument as well as repeated ones: `add BBRI,TLKM` is what people type.
    for (const part of raw.split(/[,\s]+/)) {
      if (!part) continue;
      set.add(normalizeSymbol(part));
    }
  }
  const symbols = [...set];
  writeSettings({ ...settings, symbols });
  return symbols;
}

export function removeSymbols(input: string[]): string[] {
  const settings = readSettings();
  const drop = new Set<string>();
  for (const raw of input) {
    for (const part of raw.split(/[,\s]+/)) {
      if (!part) continue;
      drop.add(normalizeSymbol(part));
    }
  }
  const symbols = settings.symbols.filter((s) => !drop.has(s));
  writeSettings({ ...settings, symbols });
  return symbols;
}

/**
 * Resolve the symbol list for a run.
 *
 * Precedence: explicit flag, then the saved list, then a small default set so a fresh install shows
 * something instead of an empty screen. The defaults are liquid large caps that are almost always
 * quoted, which makes the first run a useful smoke test rather than a wall of dashes.
 */
export function resolveSymbols(explicit?: string): { symbols: string[]; source: "flag" | "settings" | "default" } {
  if (explicit && explicit.trim()) {
    // Normalise each token, but keep the invalid one in the error message: "bukan saham" becoming
    // "BUKAN" and then a 404 from Stockbit tells the user nothing about what they typed wrong.
    // Split on commas only. Splitting on whitespace too would turn `quote "bukan saham"` into two
    // plausible tickers that each 404 separately, hiding the real mistake.
    const symbols = explicit
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((raw) => {
        try {
          return normalizeSymbol(raw);
        } catch {
          throw new UsageError(`"${raw}" is not an IDX ticker — expected 2-6 letters, optional -X suffix`);
        }
      });
    return { symbols: [...new Set(symbols)], source: "flag" };
  }
  const saved = readSettings();
  if (saved.symbols.length > 0) return { symbols: saved.symbols, source: "settings" };
  return { symbols: ["BBCA", "BBRI", "BMRI", "TLKM", "ASII"], source: "default" };
}
