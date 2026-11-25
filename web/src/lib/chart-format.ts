// Number formatting shared by the chart cards. Formatters are cached per locale/currency/option set, so formatting
// on every animation frame stays cheap.

const cache = new Map<string, Intl.NumberFormat>()

function formatter(locale: string, options: Intl.NumberFormatOptions) {
  const key = `${locale}|${JSON.stringify(options)}`
  let format = cache.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, options)
    cache.set(key, format)
  }
  return format
}

export type CurrencyFormatOptions = {
  locale?: string
  currency?: string
  /** "always" adds a "+" to positive values ("+$4,250.00"); "auto" only marks negatives. */
  signDisplay?: "auto" | "always" | "exceptZero"
  /** Fraction digits; currency default (2 for USD) when omitted. */
  maximumFractionDigits?: number
  /** false drops the thousands separators ("$4000"), as some Figma axes write amounts. */
  useGrouping?: boolean
}

/** 320418.16 → "$320,418.16", -120.62 → "-$120.62". */
export function formatCurrency(
  value: number,
  { locale = "en-US", currency = "USD", signDisplay = "auto", maximumFractionDigits, useGrouping }: CurrencyFormatOptions = {},
) {
  return formatter(locale, {
    style: "currency",
    currency,
    signDisplay,
    ...(maximumFractionDigits !== undefined ? { maximumFractionDigits, minimumFractionDigits: Math.min(maximumFractionDigits, 2) } : {}),
    ...(useGrouping === false ? { useGrouping: false } : {}),
  }).format(value)
}

export type PercentFormatOptions = Omit<CurrencyFormatOptions, "currency" | "useGrouping"> & {
  /** Fixed digits: 2 shows 13.7 as "13.70%" (by default trailing zeros are dropped). */
  minimumFractionDigits?: number
}

/** -1.16 → "-1.16%", 12 → "+12%" with signDisplay "always". The value is in percent, not a fraction. */
export function formatPercent(
  value: number,
  { locale = "en-US", signDisplay = "auto", maximumFractionDigits = 2, minimumFractionDigits }: PercentFormatOptions = {},
) {
  return formatter(locale, {
    style: "percent",
    signDisplay,
    maximumFractionDigits: Math.max(maximumFractionDigits, minimumFractionDigits ?? 0),
    ...(minimumFractionDigits !== undefined ? { minimumFractionDigits } : {}),
  }).format(value / 100)
}

export type NumberFormatOptions = {
  locale?: string
  signDisplay?: "auto" | "always" | "exceptZero"
  /** "compact" shortens large numbers: 18_800_000 → "18.8M". */
  notation?: "standard" | "compact"
  maximumFractionDigits?: number
  minimumFractionDigits?: number
}

/** Counts and plain amounts: 1234 → "1,234", 18_800_000 → "18.8M" with notation "compact". */
export function formatNumber(
  value: number,
  {
    locale = "en-US",
    signDisplay = "auto",
    notation = "standard",
    maximumFractionDigits = notation === "compact" ? 1 : 0,
    minimumFractionDigits,
  }: NumberFormatOptions = {},
) {
  return formatter(locale, {
    signDisplay,
    notation,
    maximumFractionDigits: Math.max(maximumFractionDigits, minimumFractionDigits ?? 0),
    ...(minimumFractionDigits !== undefined ? { minimumFractionDigits } : {}),
  }).format(value)
}

/**
 * The currency symbol and the number apart, for totals that draw the symbol smaller ("$" + "320,418.16").
 * `symbolFirst` says which side the symbol goes on in this locale.
 */
export function formatCurrencyParts(
  value: number,
  { locale = "en-US", currency = "USD", maximumFractionDigits }: Omit<CurrencyFormatOptions, "signDisplay" | "useGrouping"> = {},
) {
  const parts = formatter(locale, {
    style: "currency",
    currency,
    ...(maximumFractionDigits !== undefined ? { maximumFractionDigits, minimumFractionDigits: Math.min(maximumFractionDigits, 2) } : {}),
  }).formatToParts(value)
  const at = parts.findIndex((part) => part.type === "currency")
  const number = parts
    .filter((part) => part.type !== "currency")
    .map((part) => part.value)
    .join("")
    .trim()
  return {
    symbol: parts[at]?.value ?? "",
    number,
    symbolFirst: at <= 0 || parts.slice(0, at).every((part) => part.type === "literal" || part.type === "minusSign"),
  }
}

export type CompactCurrencyFormatOptions = Pick<CurrencyFormatOptions, "locale" | "currency" | "signDisplay"> & {
  /** Digits after the K, M or B; 1 by default ("$12.5K"). */
  maximumFractionDigits?: number
  /** Fixed digits: 1 shows 70_000_000 as "$70.0M" (by default trailing zeros are dropped: "$70M"). */
  minimumFractionDigits?: number
}

/** Axis amounts: 25000 → "$25K", 12500 → "$12.5K", 0 → "$0". */
export function formatCompactCurrency(
  value: number,
  { locale = "en-US", currency = "USD", signDisplay = "auto", maximumFractionDigits = 1, minimumFractionDigits }: CompactCurrencyFormatOptions = {},
) {
  return formatter(locale, {
    style: "currency",
    currency,
    notation: "compact",
    signDisplay,
    maximumFractionDigits: Math.max(maximumFractionDigits, minimumFractionDigits ?? 0),
    ...(minimumFractionDigits !== undefined ? { minimumFractionDigits } : {}),
  }).format(value)
}

/**
 * Whole percents that add up to 100 (largest remainder first), for shares shown side by side, where rounding each on
 * its own can add up to 99 or 101: [1, 1, 1] → [34, 33, 33]. Amounts in, percents out (all 0 when they sum to 0).
 */
export function wholePercents(values: number[]) {
  const sum = values.reduce((total, value) => total + value, 0)
  if (!(sum > 0)) return values.map(() => 0)
  const exact = values.map((value) => (value / sum) * 100)
  const whole = exact.map(Math.floor)
  let left = 100 - whole.reduce((total, value) => total + value, 0)
  for (const { i } of exact.map((value, i) => ({ i, rest: value - whole[i]! })).sort((a, b) => b.rest - a.rest)) {
    if (left-- <= 0) break
    whole[i]!++
  }
  return whole
}

const dateCache = new Map<string, Intl.DateTimeFormat>()

/**
 * A calendar day ("2025-04-17") in the locale, with no time-zone shift: `{ month: "short" }` → "Apr",
 * `{ month: "long" }` → "April". Text that isn't a date comes back unchanged.
 */
export function formatDay(date: string, options: Intl.DateTimeFormatOptions, locale = "en-US") {
  const key = `${locale}|${JSON.stringify(options)}`
  let format = dateCache.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
    dateCache.set(key, format)
  }
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date)
  return Number.isNaN(time) ? date : format.format(time)
}

const timeCache = new Map<string, Intl.DateTimeFormat>()

/** A time (ms) in the locale, read in UTC so the server and the browser print the same: `{ hour: "numeric" }` → "6 PM". */
export function formatTime(time: number, options: Intl.DateTimeFormatOptions, locale = "en-US") {
  const key = `${locale}|${JSON.stringify(options)}`
  let format = timeCache.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" })
    timeCache.set(key, format)
  }
  return format.format(time)
}
