/**
 * Getting a refresh token into the store.
 *
 * ## Two routes, because they fail in different places
 *
 * **Browser capture** is the good experience: open Stockbit's own login page in a real browser, let
 * the user sign in there — password, OTP, captcha, all on Stockbit's page, never touching this tool
 * — and read the refresh JWT off the network response as it flies past. It needs a Chromium-family
 * browser on the same machine, which is fine on a laptop and often absent on a server.
 *
 * **Paste** is the fallback and the one that always works: the user copies the refresh token out of
 * their browser's DevTools and pastes it. Worse ergonomics, no dependencies, and it is the only
 * option over SSH.
 *
 * ## Why the browser route does not ask for credentials
 *
 * It must not, and this is a design rule rather than a convenience. A tool that asks for a password
 * is a tool that can leak one, and there is no version of this where the assistant or the CLI needs
 * to see it. The user types into Stockbit's page; we only observe the token that Stockbit itself
 * hands out.
 *
 * ## CDP, and why two capture routes
 *
 * The token arrives in a response body, and reading a response body over CDP has a race: the target
 * must still exist when `Network.getResponseBody` runs. A login that finishes in a popup which then
 * closes itself destroys the body on the way out — the same shape every OAuth provider uses. So
 * `Fetch` interception (which pauses the request while the body is read) is the primary route, and
 * `Network` events are a fallback for tokens arriving somewhere the URL pattern did not match.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig, type Config } from "../config.js";
import { saveRefresh } from "./session.js";

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

/* ------------------------------ token validation ------------------------------ */

/**
 * A Stockbit refresh token is a JWT. Checking the shape before storing it turns the most common
 * mistake — pasting the access token, or a bearer prefix, or half a line — into an immediate
 * message instead of a confusing 401 on the next command.
 */
export function looksLikeRefreshToken(raw: string): { ok: true; token: string } | { ok: false; reason: string } {
  const token = raw.trim().replace(/^bearer\s+/i, "").replace(/^["']|["']$/g, "");
  if (!token) return { ok: false, reason: "nothing was pasted" };
  const parts = token.split(".");
  if (parts.length !== 3) {
    return {
      ok: false,
      reason:
        `that is not a JWT (it has ${parts.length} dot-separated part${parts.length === 1 ? "" : "s"}, ` +
        "a JWT has 3). The refresh token is the long `eyJ...` string, not the short bearer.",
    };
  }
  if (!/^ey[A-Za-z0-9_-]+$/.test(parts[0]!)) {
    return { ok: false, reason: "the header segment does not look like base64url JSON" };
  }
  return { ok: true, token };
}

/** Read the `exp` of an access token, for the status command. Never used to authorise anything. */
export function decodeExpiry(token: string): Date | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: number };
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/* --------------------------------- paste route -------------------------------- */

export async function loginWithToken(raw: string): Promise<void> {
  const checked = looksLikeRefreshToken(raw);
  if (!checked.ok) throw new LoginError(`That does not look like a refresh token: ${checked.reason}`);
  saveRefresh(checked.token);
}

export async function promptForToken(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    process.stdout.write(
      "\n" +
        "Paste the Stockbit refresh token and press Enter.\n" +
        "\n" +
        "How to find it:\n" +
        "  1. Open https://stockbit.com and sign in.\n" +
        "  2. Open DevTools (F12) -> Network tab -> filter for `refresh`.\n" +
        "  3. Reload the page. Click the `login/refresh` request.\n" +
        "  4. Response tab: copy the `refresh_token` value (the long eyJ... string).\n" +
        "\n" +
        "The token is stored encrypted in your home directory, never sent anywhere but Stockbit.\n" +
        "Token: ",
    );
    const answer = await new Promise<string>((resolve) => rl.question("", resolve));
    return answer;
  } finally {
    rl.close();
  }
}

/* -------------------------------- browser route ------------------------------- */

/** Where a Chromium-family browser usually lives. First match wins. */
const CANDIDATES: Record<NodeJS.Platform, string[]> = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/usr/bin/microsoft-edge",
    "/usr/bin/brave-browser",
  ],
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  aix: [],
  android: [],
  freebsd: [],
  haiku: [],
  openbsd: [],
  sunos: [],
  cygwin: [],
  netbsd: [],
};

export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.STAKBIT_BROWSER?.trim();
  if (explicit) return existsSync(explicit) ? explicit : null;
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface CdpTarget {
  id: string;
  type: string;
  webSocketDebuggerUrl?: string;
}

async function waitForDevtools(port: number, timeoutMs: number): Promise<CdpTarget[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (res.ok) {
        const targets = (await res.json()) as CdpTarget[];
        if (Array.isArray(targets) && targets.length > 0) return targets;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new LoginError("The browser did not open a debugging port in time.");
}

/** Minimal CDP client over the native WebSocket in Node 22+. */
class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private listeners = new Set<(method: string, params: unknown) => void>();
  private ready: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve(), { once: true });
      this.ws.addEventListener("error", () => reject(new LoginError("Cannot talk to the browser.")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (typeof msg.id === "number") {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new LoginError(msg.error.message));
        else waiter.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners) fn(msg.method, msg.params);
      }
    });
  }

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    await this.ready;
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new LoginError(`CDP ${method} timed out`));
      }, 20_000);
    });
  }

  on(fn: (method: string, params: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Search a response body for a refresh JWT. Returns null when this body is not the one. */
export function extractRefreshFromBody(body: string): string | null {
  // Cheap pre-filter: most responses on the wire are not the login response.
  if (!body.includes("refresh")) return null;
  try {
    const parsed = JSON.parse(body) as unknown;
    let found: string | null = null;
    const seen = new Set<object>();
    const walk = (node: unknown, depth: number): void => {
      if (found || !node || typeof node !== "object" || depth > 6 || seen.has(node)) return;
      seen.add(node);
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === "string" && /^(refresh|refresh_token)$/i.test(key) && value.split(".").length === 3) {
          found = value;
          return;
        }
        if (value && typeof value === "object") walk(value, depth + 1);
      }
    };
    walk(parsed, 0);
    return found;
  } catch {
    return null;
  }
}

export interface BrowserLoginOptions {
  /** How long to wait for the user to finish signing in. */
  timeoutMs?: number;
  /** Keep the browser window open afterwards. */
  keepOpen?: boolean;
  /** Print progress. */
  log?: (message: string) => void;
}

export async function loginWithBrowser(options: BrowserLoginOptions = {}): Promise<void> {
  const cfg = loadConfig();
  const log = options.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;

  const browser = findBrowser();
  if (!browser) {
    throw new LoginError(
      "No Chromium-family browser found. Install Chrome/Chromium, set STAKBIT_BROWSER to its path, " +
        "or use `stakbit login --paste` to paste a token instead.",
    );
  }

  const port = 9000 + Math.floor(Math.random() * 900);
  const profileDir = `${cfg.home}/browser-profile`;
  log(`Opening ${browser.split("/").pop()} — sign in to Stockbit there.`);

  const child = spawn(
    browser,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=Translate",
      "https://stockbit.com/login",
    ],
    { stdio: "ignore", detached: false },
  );

  let cdp: Cdp | null = null;
  try {
    const targets = await waitForDevtools(port, 20_000);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new LoginError("The browser opened, but no page was available to attach to.");

    cdp = new Cdp(page.webSocketDebuggerUrl);
    const token = await captureToken(cdp, timeoutMs, log);
    saveRefresh(token);
    log("\nSigned in. The token is stored encrypted; you will not need to do this again for a while.");
  } finally {
    cdp?.close();
    if (!options.keepOpen) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/**
 * Watch the page's network traffic until a refresh token appears.
 *
 * Two routes run at once; see the file header for why neither is sufficient alone.
 */
async function captureToken(cdp: Cdp, timeoutMs: number, log: (m: string) => void): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (token: string | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (token) resolve(token);
      else reject(error ?? new LoginError("No refresh token appeared. Did the sign-in complete?"));
    };

    const timer = setTimeout(() => {
      finish(
        null,
        new LoginError(
          `Gave up after ${Math.round(timeoutMs / 1000)}s. If you did sign in, try ` +
            "`stakbit login --paste` instead.",
        ),
      );
    }, timeoutMs);

    // Route 1: Fetch interception. The body is read while the request is paused, so a popup closing
    // cannot destroy it.
    cdp.on((method, params) => {
      if (settled) return;
      if (method === "Fetch.requestPaused") {
        const p = params as { requestId: string; request: { url: string }; responseStatusCode?: number };
        const url = p.request.url;
        if (!/login\/refresh|\/login|refresh_token/i.test(url)) {
          void cdp.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
          return;
        }
        void (async () => {
          try {
            const result = (await cdp.send("Fetch.getResponseBody", { requestId: p.requestId })) as {
              body: string;
              base64Encoded: boolean;
            };
            const raw = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
            const found = extractRefreshFromBody(raw);
            if (found) {
              log("Captured the token from the login response.");
              finish(found);
            }
          } catch {
            /* body already gone — the Network fallback may still catch it */
          } finally {
            void cdp.send("Fetch.continueRequest", { requestId: p.requestId }).catch(() => {});
          }
        })();
      }

      // Route 2: Network events, for a token that arrived outside the URL pattern above.
      if (method === "Network.responseReceived") {
        const p = params as { requestId: string; response: { url: string; mimeType?: string } };
        if (!/login|refresh/i.test(p.response.url)) return;
        void (async () => {
          try {
            const result = (await cdp.send("Network.getResponseBody", { requestId: p.requestId })) as {
              body: string;
              base64Encoded: boolean;
            };
            const raw = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
            const found = extractRefreshFromBody(raw);
            if (found) {
              log("Captured the token from the network response.");
              finish(found);
            }
          } catch {
            /* the target went away; route 1 is the one that survives this */
          }
        })();
      }
    });

    void (async () => {
      try {
        await cdp.send("Network.enable");
        await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Response" }] });
        log("Waiting for you to sign in…");
      } catch (err) {
        finish(null, err instanceof Error ? err : new LoginError(String(err)));
      }
    })();
  });
}
