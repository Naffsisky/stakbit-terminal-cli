/**
 * The HTTP client: one place that knows how to talk to Stockbit.
 *
 * ## Why the politeness machinery is not optional
 *
 * This is an undocumented private API behind Cloudflare. Hammering it gets an account rate-limited
 * or blocked, and the failure looks like a broken tool rather than a consequence of how it was
 * called. So requests are capped in concurrency and spaced out, retries back off, and a 429 is
 * honoured rather than ignored. It costs a few hundred milliseconds and buys not being banned.
 *
 * ## Why a 401 retries exactly once
 *
 * Access tokens are cached and shared, so a 401 usually means the cache is stale — another process
 * rotated the refresh token and our bearer is dead. One forced refresh fixes that. Retrying more
 * than once would loop against a genuinely revoked session, which is a different problem with a
 * different fix.
 *
 * ## Redirects are refused
 *
 * `redirect: "manual"` and a thrown error on 3xx. Following a redirect would replay the
 * Authorization header at an origin nothing here approved, and there is no legitimate reason for
 * these endpoints to redirect.
 */
import { loadConfig, type Config } from "../config.js";
import { AuthError, forceRefresh, getAccessToken } from "../auth/session.js";

const MAX_CONCURRENT = 3;
const MIN_SPACING_MS = 150;
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const TIMEOUT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number | null;
  readonly key: string | null;
  constructor(message: string, status: number | null = null, key: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.key = key;
  }
}

/* ------------------------------- rate limiting ------------------------------ */

let active = 0;
let lastStart = 0;
const queue: (() => void)[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => queue.push(resolve));
  }
  active++;
  try {
    // Space starts apart so a burst of watchlist rows does not arrive as a burst upstream.
    const wait = Math.max(0, lastStart + MIN_SPACING_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return await fn();
  } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}

/* ---------------------------------- request --------------------------------- */

export interface RequestOptions {
  /** Query parameters. `undefined` values are dropped, not sent as the string "undefined". */
  query?: Record<string, string | number | boolean | undefined>;
  /** Skip the access token entirely — used by the refresh route itself. */
  anonymous?: boolean;
  /** Override the timeout for a slow endpoint. */
  timeoutMs?: number;
}

function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path, base);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export function defaultHeaders(cfg: Config): Record<string, string> {
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: cfg.hosts.web,
    referer: `${cfg.hosts.web}/`,
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  };
}

async function once(url: string, cfg: Config, token: string | null, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        ...defaultHeaders(cfg),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A short, safe description of an upstream error body. Never echoes tokens. */
function describeErrorBody(text: string): { message: string; key: string | null } {
  try {
    const parsed = JSON.parse(text) as { message?: unknown; error?: unknown; key?: unknown };
    const message =
      (typeof parsed.message === "string" && parsed.message) ||
      (typeof parsed.error === "string" && parsed.error) ||
      text.slice(0, 200);
    const key = typeof parsed.key === "string" ? parsed.key : null;
    return { message, key };
  } catch {
    return { message: text.slice(0, 200), key: null };
  }
}

/**
 * GET a Stockbit endpoint and return the parsed JSON body.
 *
 * `path` is joined onto `base`, so a caller passes `/emitten/BBRI/info` and gets the host for free.
 */
export async function getJson<T = unknown>(
  path: string,
  options: RequestOptions & { base?: string; cfg?: Config } = {},
): Promise<T> {
  const cfg = options.cfg ?? loadConfig();
  const base = options.base ?? cfg.hosts.exodus;
  const url = buildUrl(base, path, options.query);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  let token: string | null = null;
  if (!options.anonymous) token = await getAccessToken(cfg);

  let attempt = 0;
  let refreshed = false;

  for (;;) {
    attempt++;
    let res: Response;
    try {
      res = await withSlot(() => once(url, cfg, token, timeoutMs));
    } catch (err) {
      if (attempt > MAX_RETRIES) {
        throw new ApiError(
          `Cannot reach Stockbit (${err instanceof Error ? err.message : String(err)}).`,
        );
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    if (res.status >= 300 && res.status < 400) {
      throw new ApiError("Stockbit answered with a redirect, which this client refuses to follow.", res.status);
    }

    if (res.status === 401) {
      // Cached access is stale (another process rotated the refresh token). One forced refresh.
      if (refreshed) {
        throw new AuthError(
          "Stockbit rejected a freshly minted token.",
          "The session is revoked, not merely expired. Run `stakbit login` again.",
        );
      }
      refreshed = true;
      token = await forceRefresh(cfg);
      attempt = 0;
      continue;
    }

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : BACKOFF_BASE_MS * 4;
      if (attempt > MAX_RETRIES) {
        throw new ApiError(
          `Stockbit is rate limiting this account (HTTP 429). Wait ${Math.ceil(waitMs / 1000)}s and retry.`,
          429,
        );
      }
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500) {
      if (attempt > MAX_RETRIES) {
        throw new ApiError(`Stockbit returned HTTP ${res.status}. This is upstream, not your session.`, res.status);
      }
      await sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
      continue;
    }

    const text = await res.text();
    if (!res.ok) {
      const { message, key } = describeErrorBody(text);
      throw new ApiError(`Stockbit refused the request: ${message}`, res.status, key);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ApiError("Stockbit returned something that is not JSON.", res.status);
    }
  }
}
