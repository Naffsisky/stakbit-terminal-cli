/**
 * Wire -> domain projection.
 *
 * ## The rule this file follows
 *
 * Stockbit's API is undocumented and its shapes drift. Two failure modes are possible when a field
 * is missing or renamed:
 *
 *   - **Invent a zero.** A missing price becomes `0`, and then an alert fires, a percentage divides
 *     by zero, and a chart collapses its axis. Silent and expensive.
 *   - **Refuse the row.** A row with one unreadable field disappears from a watchlist, and the user
 *     sees a stock vanish with no explanation.
 *
 * Neither is acceptable, so the rule is: **a value that cannot be read is `null`, never `0`, and the
 * row survives.** `null` renders as `—` in the UI, which is honest, and it keeps "the field was
 * empty" distinguishable from "the price really is zero" (which for an equity it never is, but for
 * a change it legitimately can be).
 *
 * The one thing that IS refused is a row with no symbol at all — that row cannot be placed anywhere.
 *
 * ## Numbers arrive in several shapes
 *
 * Observed across this API: plain numbers, numeric strings, thousands-separated strings
 * (`"1,234"`), and objects like `{ raw: 1234, formatted: "1,234" }`. `toNumber` handles all four.
 * A string that is not a number returns `null` rather than `NaN`, because `NaN` propagates through
 * arithmetic and renders as `NaN` on screen.
 */

/** Read a number from any of the shapes this API uses. Returns `null` when it cannot. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Deliberately not `Number(trimmed)`: `Number("")` is 0, which would turn an empty field into a
    // real zero. Emptiness is handled before this point.
    if (trimmed === "" || trimmed === "-" || trimmed === "—") return null;
    const cleaned = trimmed.replace(/,/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object") {
    const obj = value as { raw?: unknown; value?: unknown };
    if (obj.raw !== undefined) return toNumber(obj.raw);
    if (obj.value !== undefined) return toNumber(obj.value);
  }
  return null;
}

/** Read a string field, trimming and refusing empty strings. */
export function toText(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Unwrap Stockbit's `{ data: ... }` envelope.
 *
 * Returns `undefined` when there is no envelope, so a caller can tell "empty payload" from
 * "unexpected shape" instead of both becoming `null`.
 */
export function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "data" in body) {
    return (body as { data: unknown }).data;
  }
  return undefined;
}

/** Find the first array inside a payload, at the top level or one envelope down. */
export function findArray(node: unknown, keys: string[] = [], depth = 0): unknown[] | null {
  if (depth > 4 || !node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  for (const key of keys) {
    const candidate = obj[key];
    if (Array.isArray(candidate)) return candidate;
  }
  if (Array.isArray(node)) return node;
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      const nested = findArray(value, keys, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** A row that can be projected at all. Anything without a symbol is dropped with a reason. */
export interface RawRow {
  [key: string]: unknown;
}

export function isRecord(value: unknown): value is RawRow {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
