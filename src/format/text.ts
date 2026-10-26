/**
 * Rendering helpers: numbers, money, colour.
 *
 * ## Why formatting is a module and not inline template strings
 *
 * Because the rules are the interesting part. An IDX quote in a terminal is read in a glance, and
 * the difference between `1,234` and `1.234` is a thousandfold error to a reader who is used to the
 * other convention. So the choices are made once, here, and tested.
 *
 * ## Colour is opt-in and degrades
 *
 * `NO_COLOR` (the de-facto standard) and a non-TTY stdout both disable it. A tracker piped into
 * `less` or a log file should be plain text, not escape soup.
 */

const NO_COLOR = Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";
const FORCE_COLOR = process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "true";

export function colorEnabled(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (NO_COLOR) return false;
  if (FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

type Code = 31 | 32 | 33 | 36 | 37 | 90 | 91 | 92 | 93 | 96 | 97;

function paint(text: string, code: Code, enabled: boolean): string {
  return enabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

/** IDX convention: green up, red down, and a flat line for unchanged. */
export function colorChange(value: number | null, text: string, enabled: boolean): string {
  if (value === null) return paint(text, 90, enabled);
  if (value > 0) return paint(text, 92, enabled);
  if (value < 0) return paint(text, 91, enabled);
  return paint(text, 90, enabled);
}

export function dim(text: string, enabled: boolean): string {
  return paint(text, 90, enabled);
}

export function bold(text: string, enabled: boolean): string {
  return enabled ? `\u001b[1m${text}\u001b[0m` : text;
}

export function cyan(text: string, enabled: boolean): string {
  return paint(text, 96, enabled);
}

export function yellow(text: string, enabled: boolean): string {
  return paint(text, 93, enabled);
}

export function red(text: string, enabled: boolean): string {
  return paint(text, 91, enabled);
}

export function green(text: string, enabled: boolean): string {
  return paint(text, 92, enabled);
}

/* ---------------------------------- numbers --------------------------------- */

/**
 * Integer with thousands separators, using `,`.
 *
 * Deliberately not `toLocaleString()`: that follows the host locale, so the same tool would print
 * `1.234` on an Indonesian machine and `1,234` on an American one. A trader reading a price needs
 * one convention, and this one matches Stockbit's own display.
 */
export function formatInt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A price: integers stay integers, fractions keep up to two decimals. */
export function formatPrice(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Number.isInteger(value)) return formatInt(value);
  return value.toFixed(2);
}

/** Percentage with an explicit sign, e.g. `+1.25%`. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/** Signed absolute change, e.g. `+15`. */
export function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatPrice(value)}`;
}

/**
 * Compact IDR: `1.2B`, `345.0M`, `12.3K`.
 *
 * Uses B/M/K rather than the Indonesian rb/jt/M because it is unambiguous at a glance and fits the
 * column. Values below 1000 keep full precision, since "12" is more useful than "12.0".
 */
export function formatCompact(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1_000_000_000_000) return `${sign}${(abs / 1_000_000_000_000).toFixed(2)}T`;
  if (abs >= 1_000_000_000) return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${formatInt(abs)}`;
}

/** Lots as a readable size: `1,234` below 10k, `12.3K` above. */
export function formatLot(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 10_000) return formatCompact(value);
  return formatInt(value);
}

/** Fixed-width, right-aligned, never wider than `width`. Truncates with an ellipsis. */
export function pad(value: string, width: number, align: "left" | "right" = "left"): string {
  // Escape codes have no display width, so pad against the visible length.
  const visible = stripAnsi(value);
  if (visible.length > width) {
    const cut = Math.max(0, width - 1);
    const plain = visible.slice(0, cut) + (width > 1 ? "…" : "");
    return align === "right" ? plain.padStart(width) : plain.padEnd(width);
  }
  const fill = " ".repeat(width - visible.length);
  return align === "right" ? fill + value : value + fill;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** A horizontal rule that respects terminal width. */
export function rule(width: number, char = "─"): string {
  return char.repeat(Math.max(0, width));
}
