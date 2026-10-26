/**
 * Tests for argument parsing and the token validator.
 *
 * The parser is hand-rolled, so it needs more coverage than a framework would: every shape a user
 * might type has to land somewhere predictable, and an unknown flag must not silently become a
 * symbol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";
import { decodeExpiry, extractRefreshFromBody, looksLikeRefreshToken } from "../src/auth/login.js";
import { parseRefreshResponse } from "../src/auth/session.js";

/* -------------------------------- parseArgs --------------------------------- */

test("a bare command has no positional or flags", () => {
  const parsed = parseArgs(["status"]);
  assert.equal(parsed.command, "status");
  assert.deepEqual(parsed.positional, []);
  assert.equal(parsed.flags.size, 0);
});

test("a positional argument is collected", () => {
  const parsed = parseArgs(["tape", "BBRI"]);
  assert.equal(parsed.command, "tape");
  assert.deepEqual(parsed.positional, ["BBRI"]);
});

test("several positionals are collected in order", () => {
  const parsed = parseArgs(["watchlist", "add", "BBRI", "TLKM"]);
  assert.deepEqual(parsed.positional, ["add", "BBRI", "TLKM"]);
});

test("a flag with a value takes the next token", () => {
  const parsed = parseArgs(["watch", "--symbols", "BBRI,TLKM"]);
  assert.equal(parsed.flags.get("symbols"), "BBRI,TLKM");
  assert.deepEqual(parsed.positional, []);
});

test("a flag with an inline value is parsed", () => {
  const parsed = parseArgs(["watch", "--interval=5000"]);
  assert.equal(parsed.flags.get("interval"), "5000");
});

test("a boolean flag does not swallow the next flag", () => {
  const parsed = parseArgs(["watch", "--always", "--interval", "3000"]);
  assert.equal(parsed.flags.get("always"), true);
  assert.equal(parsed.flags.get("interval"), "3000");
});

test("a boolean flag at the end is true", () => {
  const parsed = parseArgs(["login", "--paste"]);
  assert.equal(parsed.flags.get("paste"), true);
});

test("a boolean flag before a positional does not swallow it", () => {
  // `--always` takes no value, so BBRI must stay a positional rather than becoming its value.
  const parsed = parseArgs(["tape", "--always", "BBRI"]);
  assert.equal(parsed.flags.get("always"), true);
  assert.deepEqual(parsed.positional, ["BBRI"]);
});

test("-- stops flag parsing", () => {
  const parsed = parseArgs(["quote", "--", "--not-a-flag"]);
  assert.deepEqual(parsed.positional, ["--not-a-flag"]);
});

test("a short flag is accepted", () => {
  const parsed = parseArgs(["status", "-v"]);
  assert.equal(parsed.flags.get("v"), true);
});

test("no arguments defaults to help", () => {
  assert.equal(parseArgs([]).command, "help");
});

/* ----------------------------- token validation ----------------------------- */

const FAKE_JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

test("a well-formed JWT is accepted", () => {
  const result = looksLikeRefreshToken(FAKE_JWT);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.token, FAKE_JWT);
});

test("a Bearer prefix is stripped", () => {
  const result = looksLikeRefreshToken(`Bearer ${FAKE_JWT}`);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.token, FAKE_JWT);
});

test("surrounding quotes are stripped", () => {
  const result = looksLikeRefreshToken(`"${FAKE_JWT}"`);
  assert.equal(result.ok, true);
});

test("whitespace is trimmed", () => {
  const result = looksLikeRefreshToken(`  ${FAKE_JWT}  `);
  assert.equal(result.ok, true);
});

test("an empty paste is refused with a clear reason", () => {
  const result = looksLikeRefreshToken("   ");
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /nothing/);
});

test("a non-JWT is refused and the reason names the segment count", () => {
  // This is the common mistake: pasting the short bearer instead of the refresh JWT.
  const result = looksLikeRefreshToken("abc123");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /JWT/);
    assert.match(result.reason, /1 dot/);
  }
});

test("decodeExpiry reads the exp claim", () => {
  // eyJ... payload decodes to {"exp": 1700000000} in this fixture.
  const payload = Buffer.from(JSON.stringify({ exp: 1_700_000_000 })).toString("base64url");
  const token = `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`;
  const expiry = decodeExpiry(token);
  assert.equal(expiry?.getTime(), 1_700_000_000_000);
});

test("decodeExpiry returns null for a token without exp", () => {
  const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
  assert.equal(decodeExpiry(`eyJhbGciOiJIUzI1NiJ9.${payload}.sig`), null);
});

test("decodeExpiry returns null for garbage rather than throwing", () => {
  assert.equal(decodeExpiry("not-a-jwt"), null);
  assert.equal(decodeExpiry("a.b.c"), null);
});

/* --------------------------- refresh body parsing --------------------------- */

test("extractRefreshFromBody finds a nested refresh_token", () => {
  const body = JSON.stringify({ data: { access_token: "a".repeat(30), refresh_token: FAKE_JWT } });
  assert.equal(extractRefreshFromBody(body), FAKE_JWT);
});

test("extractRefreshFromBody finds a top-level refresh key", () => {
  const body = JSON.stringify({ refresh: FAKE_JWT, access: "b".repeat(30) });
  assert.equal(extractRefreshFromBody(body), FAKE_JWT);
});

test("extractRefreshFromBody ignores a body that is not the login response", () => {
  assert.equal(extractRefreshFromBody(JSON.stringify({ data: { quote: 4500 } })), null);
});

test("extractRefreshFromBody ignores a non-JWT value in a refresh field", () => {
  const body = JSON.stringify({ refresh_token: "short-value" });
  assert.equal(extractRefreshFromBody(body), null);
});

test("extractRefreshFromBody survives malformed JSON", () => {
  assert.equal(extractRefreshFromBody("{not json"), null);
});

/* --------------------------- refresh response parse -------------------------- */

test("parseRefreshResponse reads the documented nested envelope", () => {
  const parsed = parseRefreshResponse({
    data: { access_token: "a".repeat(30), refresh_token: "r".repeat(30) },
  });
  assert.equal(parsed?.access, "a".repeat(30));
  assert.equal(parsed?.refresh, "r".repeat(30));
});

test("parseRefreshResponse reads a flat envelope", () => {
  const parsed = parseRefreshResponse({ access: "a".repeat(30), refresh: "r".repeat(30) });
  assert.equal(parsed?.access, "a".repeat(30));
});

test("parseRefreshResponse refuses a response without a new refresh token", () => {
  // Reusing the old one is not safe: upstream has already retired it, so the caller must fail loudly.
  const parsed = parseRefreshResponse({ data: { access_token: "a".repeat(30) } });
  assert.equal(parsed, null);
});

test("parseRefreshResponse refuses a response with no tokens at all", () => {
  assert.equal(parseRefreshResponse({ data: { message: "ok" } }), null);
});

test("parseRefreshResponse ignores a short string that merely looks like a key name", () => {
  assert.equal(parseRefreshResponse({ access: "short", refresh: "short" }), null);
});
