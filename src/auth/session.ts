/**
 * Session handling for the market-data domain.
 *
 * ## The one behaviour that shapes this whole file: refresh ROTATES
 *
 * A successful `/login/refresh` mints a new refresh token and retires the one you presented. Two
 * consequences, both of which cause the failure people blame on "the API is flaky":
 *
 *   1. **The new token must be persisted before anything else happens.** If the process dies between
 *      receiving it and writing it, the old token is already dead and the user is logged out with no
 *      way to tell why. So the write happens before the access token is handed to any caller.
 *
 *   2. **Two processes refreshing at once retire each other.** This is not theoretical: a tracker
 *      running in one terminal and a `quote` command in another is the normal way this tool gets
 *      used. So refreshes take a cross-process lock, and a process that loses the race re-reads the
 *      store rather than refreshing on its own.
 *
 * The access token is cached on disk for the same reason: minting one per process would rotate the
 * refresh token on every invocation. `STAKBIT_NO_ACCESS_CACHE=1` turns that off for anyone who would
 * rather pay one rotation per process.
 *
 * ## Why the error messages are long
 *
 * A 401 from this API can mean five different things — no session, revoked session, superseded by
 * another login, wrong domain, or a genuinely expired token. They are indistinguishable from the
 * outside. Saying "unauthorized" and stopping would send the user to the wrong fix, so the message
 * names the actions in order of likelihood.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { loadConfig, storePaths, type Config } from "../config.js";
import { CredentialError, readSecret, removeSecret, writeSecret } from "./store.js";

const ACCESS_MARGIN_MS = 60_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 20_000;

export class AuthError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "AuthError";
    this.hint = hint;
  }
}

interface StoredRefresh {
  /** The rotating refresh token. */
  refresh: string;
  /** When it was obtained, for diagnostics only — it carries no expiry of its own. */
  obtainedAt: string;
  /** Account label, if the login flow could read one. Never a credential. */
  account?: string;
}

interface CachedAccess {
  access: string;
  /** Epoch millis. Derived from the JWT `exp` when present, else a conservative 20 minutes. */
  expiresAt: number;
}

export interface SessionStatus {
  hasRefresh: boolean;
  hasAccess: boolean;
  accessExpiresAt: number | null;
  obtainedAt: string | null;
  account: string | null;
}

function paths() {
  return storePaths(loadConfig());
}

export function readRefresh(): StoredRefresh | null {
  return readSecret<StoredRefresh>(paths().refresh);
}

export function status(): SessionStatus {
  const refresh = readRefresh();
  const access = readSecret<CachedAccess>(paths().access);
  return {
    hasRefresh: refresh !== null,
    hasAccess: access !== null && access.expiresAt > Date.now(),
    accessExpiresAt: access?.expiresAt ?? null,
    obtainedAt: refresh?.obtainedAt ?? null,
    account: refresh?.account ?? null,
  };
}

export function saveRefresh(refresh: string, account?: string): void {
  const record: StoredRefresh = {
    refresh,
    obtainedAt: new Date().toISOString(),
    ...(account ? { account } : {}),
  };
  writeSecret(paths().refresh, record);
}

export function logout(): { removed: boolean } {
  const p = paths();
  const a = removeSecret(p.refresh);
  const b = removeSecret(p.access);
  return { removed: a || b };
}

/* ------------------------------- access cache ------------------------------- */

function decodeExp(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function readCachedAccess(): CachedAccess | null {
  if (process.env.STAKBIT_NO_ACCESS_CACHE === "1") return null;
  const cached = readSecret<CachedAccess>(paths().access);
  if (!cached) return null;
  return cached.expiresAt - ACCESS_MARGIN_MS > Date.now() ? cached : null;
}

function writeCachedAccess(access: string): CachedAccess {
  const exp = decodeExp(access);
  // The JWT expiry is authoritative when present. Without one, 20 minutes is deliberately shorter
  // than the 24 hours this token is believed to live, so a wrong guess fails early rather than
  // producing a mysterious mid-session 401.
  const expiresAt = exp ?? Date.now() + 20 * 60_000;
  const record: CachedAccess = { access, expiresAt };
  if (process.env.STAKBIT_NO_ACCESS_CACHE !== "1") {
    try {
      writeSecret(paths().access, record);
    } catch {
      // A read-only home is not a reason to refuse to work; the token still lives in memory.
    }
  }
  return record;
}

/* --------------------------------- the lock --------------------------------- */

interface LockHandle {
  release: () => void;
}

function lockPath(): string {
  return `${paths().dir}/refresh.lock`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Take the cross-process refresh lock.
 *
 * `wx` makes creation atomic, so two processes cannot both believe they won. A lock older than
 * `LOCK_STALE_MS` is broken rather than honoured: a crashed process must not lock the user out
 * forever, and a refresh never legitimately takes 30 seconds.
 */
async function acquireLock(): Promise<LockHandle> {
  const path = lockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    try {
      writeFileSync(path, `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: 0o600 });
      return {
        release: () => {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;

      // Somebody holds it. Break it if it is stale, otherwise wait and retry.
      try {
        const age = Date.now() - statSync(path).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(path);
          continue;
        }
      } catch {
        continue; // vanished between EEXIST and stat — try again immediately
      }
      await sleep(120);
    }
  }

  throw new AuthError(
    "Timed out waiting for the token refresh lock.",
    `Another stakbit process has been refreshing for ${LOCK_WAIT_MS / 1000}s. If none is running, ` +
      `delete ${path} and retry.`,
  );
}

/* -------------------------------- refreshing -------------------------------- */

let inFlight: Promise<string> | null = null;

async function postRefresh(cfg: Config, refreshToken: string): Promise<{ access: string; refresh: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${cfg.hosts.exodus}/login/refresh`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en;q=0.9",
        authorization: `Bearer ${refreshToken}`,
        origin: cfg.hosts.web,
        referer: `${cfg.hosts.web}/`,
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AuthError(
      "The stored Stockbit session was rejected.",
      "It is present but Stockbit no longer accepts it — revoked, or superseded by a login " +
        "elsewhere. Run `stakbit login` again.",
    );
  }
  if (!res.ok) {
    throw new AuthError(
      `Stockbit refresh failed with HTTP ${res.status}.`,
      "This is not a credential problem. Retry; if it persists, Stockbit is having trouble.",
    );
  }

  const body = (await res.json()) as unknown;
  const parsed = parseRefreshResponse(body);
  if (!parsed) {
    throw new AuthError(
      "Stockbit's refresh response did not contain a token.",
      "The upstream envelope changed shape. Run with STAKBIT_DEBUG=1 to print the response keys " +
        "(values are never printed) and report it.",
    );
  }
  return parsed;
}

/**
 * Pull `access` and `refresh` out of the envelope by structure rather than by a fixed path.
 *
 * The envelope has already moved once across API versions, and the documented shape is a nested
 * `data` object while some responses put the token at the top level. Walking for the first matching
 * key name survives both without a version check.
 */
export function parseRefreshResponse(body: unknown): { access: string; refresh: string } | null {
  let access: string | null = null;
  let refresh: string | null = null;
  const seen = new Set<object>();

  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 20) {
        if (/^(access|access_token)$/i.test(key) && !access) access = value;
        if (/^(refresh|refresh_token)$/i.test(key) && !refresh) refresh = value;
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };

  walk(body, 0);
  if (process.env.STAKBIT_DEBUG === "1" && (!access || !refresh)) {
    process.stderr.write(`[stakbit] refresh response keys: ${describeShape(body)}\n`);
  }
  // A response without a new refresh token would leave the old one already retired upstream, so it
  // is treated as a failure rather than reused.
  if (!access || !refresh) return null;
  return { access, refresh };
}

function describeShape(node: unknown, depth = 0): string {
  if (depth > 3 || !node || typeof node !== "object") return typeof node;
  const entries = Object.entries(node as Record<string, unknown>).map(
    ([k, v]) => `${k}:${v && typeof v === "object" ? describeShape(v, depth + 1) : typeof v}`,
  );
  return `{${entries.join(",")}}`;
}

async function refreshOnce(cfg: Config): Promise<string> {
  const stored = readRefresh();
  if (!stored) {
    throw new AuthError(
      "No Stockbit session stored.",
      "Run `stakbit login` first. It opens a browser window where you sign in to Stockbit " +
        "yourself — no password or OTP is ever asked for by this tool.",
    );
  }

  const lock = await acquireLock();
  try {
    // Re-read under the lock. Whoever held it before us may have rotated the token, in which case
    // our copy is already dead and refreshing with it would log the user out.
    const current = readRefresh();
    if (current && current.refresh !== stored.refresh) {
      const cached = readCachedAccess();
      if (cached) return cached.access;
    }

    const fresh = await postRefresh(cfg, (current ?? stored).refresh);
    // Persist BEFORE returning. See the header: the old token is already retired at this point.
    saveRefresh(fresh.refresh, (current ?? stored).account);
    writeCachedAccess(fresh.access);
    return fresh.access;
  } finally {
    lock.release();
  }
}

/**
 * A valid access token, refreshing if needed.
 *
 * Concurrent calls in one process share a single in-flight refresh — without this, ten watchlist
 * rows refreshing at once would fire ten rotations and retire nine of them.
 */
export async function getAccessToken(cfg: Config = loadConfig()): Promise<string> {
  const cached = readCachedAccess();
  if (cached) return cached.access;
  if (inFlight) return inFlight;

  inFlight = refreshOnce(cfg).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Force a fresh token after a 401.
 *
 * Deliberately bypasses the cache: the caller has already established that the cached token is not
 * accepted, so handing the same one back would loop.
 */
export async function forceRefresh(cfg: Config = loadConfig()): Promise<string> {
  if (inFlight) return inFlight;
  inFlight = refreshOnce(cfg).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Diagnostics for `stakbit status` — never returns a token. */
export function describeStore(): { dir: string; files: { name: string; exists: boolean; bytes: number }[] } {
  const p = paths();
  const names = ["refresh.enc", "access.enc", "meta.json", "settings.json"];
  return {
    dir: p.dir,
    files: names.map((name) => {
      const full = `${p.dir}/${name}`;
      const exists = existsSync(full);
      return { name, exists, bytes: exists ? statSync(full).size : 0 };
    }),
  };
}

export { CredentialError };
