/**
 * Tests for the session clock.
 *
 * The schedule is the part people get wrong (Friday is different, and the break moves), so each
 * boundary is asserted explicitly rather than sampled.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWibTime, nextPollDelay, sessionState, toWib } from "../src/session-clock.js";

/** Build a Date for a given WIB wall-clock time on a known date. */
function wib(isoDate: string, hh: number, mm: number): Date {
  // 2026-10-26 is a Monday; 2026-10-30 is a Friday.
  const utcMs = Date.parse(`${isoDate}T00:00:00Z`) + (hh * 60 + mm - 7 * 60) * 60_000;
  return new Date(utcMs);
}

test("WIB conversion shifts by seven hours", () => {
  const now = new Date("2026-10-26T00:00:00Z");
  assert.equal(toWib(now).getUTCHours(), 7);
});

test("formatWibTime prints zero-padded HH:MM:SS", () => {
  assert.equal(formatWibTime(wib("2026-10-26", 9, 5)), "09:05:00");
  assert.equal(formatWibTime(wib("2026-10-26", 15, 50)), "15:50:00");
});

test("Saturday and Sunday are the weekend", () => {
  // 2026-10-31 is a Saturday, 2026-11-01 a Sunday.
  assert.equal(sessionState(wib("2026-10-31", 10, 0)).phase, "weekend");
  assert.equal(sessionState(wib("2026-11-01", 10, 0)).phase, "weekend");
  assert.equal(sessionState(wib("2026-10-31", 10, 0)).live, false);
});

test("Monday pre-opening starts at 08:45", () => {
  assert.equal(sessionState(wib("2026-10-26", 8, 44)).phase, "closed");
  assert.equal(sessionState(wib("2026-10-26", 8, 45)).phase, "pre-opening");
  assert.equal(sessionState(wib("2026-10-26", 8, 59)).phase, "pre-opening");
});

test("Monday session 1 runs 09:00 to 12:00 and is live", () => {
  const state = sessionState(wib("2026-10-26", 9, 0));
  assert.equal(state.phase, "session-1");
  assert.equal(state.live, true);
  assert.equal(sessionState(wib("2026-10-26", 11, 59)).phase, "session-1");
});

test("Monday break runs 12:00 to 13:30 and is not live", () => {
  const state = sessionState(wib("2026-10-26", 12, 0));
  assert.equal(state.phase, "break");
  assert.equal(state.live, false);
  assert.equal(sessionState(wib("2026-10-26", 13, 29)).phase, "break");
});

test("Monday session 2 runs 13:30 to 15:50 and is live", () => {
  assert.equal(sessionState(wib("2026-10-26", 13, 30)).phase, "session-2");
  assert.equal(sessionState(wib("2026-10-26", 15, 49)).phase, "session-2");
  assert.equal(sessionState(wib("2026-10-26", 13, 30)).live, true);
});

test("post-closing runs to 16:15 and then the market is shut", () => {
  assert.equal(sessionState(wib("2026-10-26", 15, 50)).phase, "post-closing");
  assert.equal(sessionState(wib("2026-10-26", 16, 14)).phase, "post-closing");
  assert.equal(sessionState(wib("2026-10-26", 16, 15)).phase, "closed");
  assert.equal(sessionState(wib("2026-10-26", 23, 0)).phase, "closed");
});

test("Friday has its own schedule: session 1 ends at 11:30", () => {
  // 2026-10-30 is a Friday.
  assert.equal(sessionState(wib("2026-10-30", 11, 29)).phase, "session-1");
  assert.equal(sessionState(wib("2026-10-30", 11, 30)).phase, "break");
});

test("Friday session 2 opens at 14:00, not 13:30", () => {
  assert.equal(sessionState(wib("2026-10-30", 13, 45)).phase, "break");
  assert.equal(sessionState(wib("2026-10-30", 14, 0)).phase, "session-2");
});

test("every phase carries a label and the WIB clock", () => {
  const state = sessionState(wib("2026-10-26", 10, 0));
  assert.ok(state.label.length > 0);
  assert.match(state.nowWib, /^\d{2}:\d{2}:\d{2}$/);
});

test("polling backs off outside a live session", () => {
  const closed = sessionState(wib("2026-10-26", 20, 0));
  assert.ok(nextPollDelay(2000, closed, false) >= 15_000);
});

test("polling keeps the configured interval inside a session", () => {
  const live = sessionState(wib("2026-10-26", 10, 0));
  assert.equal(nextPollDelay(2000, live, false), 2000);
});

test("--always overrides the back-off", () => {
  const closed = sessionState(wib("2026-10-26", 20, 0));
  assert.equal(nextPollDelay(2000, closed, true), 2000);
});
