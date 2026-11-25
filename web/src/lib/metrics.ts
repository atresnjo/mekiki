// the numbers behind the overview charts: a time window cut into buckets, against the window before it. windows end
// on a calendar edge (the next whole hour for 24 hours, the next midnight for days), so a bar is "Tue" or "14:00"
// and not the 24 hours before 14:37
import type { Review } from "./mekiki.ts"

export type Range = "24h" | "7d" | "30d"

/** "fine": a bar per hour or day, for the wide bar charts. "coarse": a dozen at most, for the narrow cards */
export type Grain = "fine" | "coarse"

interface Cut {
  readonly unit: "hour" | "day"
  /** units per bucket */
  readonly size: number
  readonly count: number
}

export const RANGES: Record<Range, { readonly label: string; readonly short: string; readonly cuts: Record<Grain, Cut> }> = {
  "24h": { label: "Past 24 hours", short: "24h", cuts: { fine: { unit: "hour", size: 1, count: 24 }, coarse: { unit: "hour", size: 3, count: 8 } } },
  "7d": { label: "Past 7 days", short: "7d", cuts: { fine: { unit: "day", size: 1, count: 7 }, coarse: { unit: "day", size: 1, count: 7 } } },
  "30d": { label: "Past 30 days", short: "30d", cuts: { fine: { unit: "day", size: 1, count: 30 }, coarse: { unit: "day", size: 5, count: 6 } } },
}

export const RANGE_KEYS = Object.keys(RANGES) as ReadonlyArray<Range>

export interface Bucket {
  readonly start: number
  readonly end: number
  /** under the bar ("Tue", "14:00", "Nov 3") */
  readonly label: string
  /** in the tooltip ("Tue, Nov 25", "Nov 25, 14:00", "Nov 3 – 7") */
  readonly title: string
  /** the finished reviews started in it */
  readonly reviews: ReadonlyArray<Review>
}

/** a boundary `k` units after the one at or after `now` (in local time, so a day is a calendar day across DST) */
const edge = (now: number, unit: Cut["unit"], k: number) => {
  const d = new Date(now)
  if (unit === "hour") {
    d.setMinutes(0, 0, 0)
    if (d.getTime() < now) d.setHours(d.getHours() + 1)
    d.setHours(d.getHours() + k)
  } else {
    d.setHours(0, 0, 0, 0)
    if (d.getTime() < now) d.setDate(d.getDate() + 1)
    d.setDate(d.getDate() + k)
  }
  return d.getTime()
}

const fmt = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(undefined, options)
const HOUR = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const HOUR_SHORT = fmt({ hour: "numeric", hourCycle: "h23" })
const WEEKDAY = fmt({ weekday: "short" })
const DAY = fmt({ month: "short", day: "numeric" })
const LONG_DAY = fmt({ weekday: "short", month: "short", day: "numeric" })

const finished = (reviews: ReadonlyArray<Review>) => reviews.filter((r) => r.status !== "running")
const between = (reviews: ReadonlyArray<Review>, from: number, to: number) => reviews.filter((r) => r.startedAt >= from && r.startedAt < to)

/** the range's window and the one before it, the same length */
export const windows = (range: Range, now: number) => {
  const { unit, size, count } = RANGES[range].cuts.fine
  const end = edge(now, unit, 0)
  const start = edge(now, unit, -size * count)
  return { start, end, previous: { start: edge(now, unit, -2 * size * count), end: start } }
}

/** the finished reviews in the range's window, and in the window before */
export const inWindow = (reviews: ReadonlyArray<Review>, range: Range, now: number) => {
  const w = windows(range, now)
  const done = finished(reviews)
  return { current: between(done, w.start, w.end), previous: between(done, w.previous.start, w.previous.end) }
}

export const buckets = (reviews: ReadonlyArray<Review>, range: Range, now: number, grain: Grain): ReadonlyArray<Bucket> => {
  const { unit, size, count } = RANGES[range].cuts[grain]
  const done = finished(reviews)
  return Array.from({ length: count }, (_, i) => {
    const start = edge(now, unit, -size * (count - i))
    const end = edge(now, unit, -size * (count - i - 1))
    const label =
      unit === "hour" ? (size === 1 ? HOUR.format(start) : `${HOUR_SHORT.format(start)}h`) : range === "7d" ? WEEKDAY.format(start) : DAY.format(start)
    const title =
      unit === "hour"
        ? `${DAY.format(start)}, ${HOUR.format(start)}–${HOUR.format(end)}`
        : size === 1
          ? LONG_DAY.format(start)
          : `${DAY.format(start)} – ${DAY.format(end - 1)}`
    return { start, end, label, title, reviews: between(done, start, end) }
  })
}

/** percent change, or undefined when there's nothing to compare against */
export const change = (value: number | undefined, previous: number | undefined) =>
  value === undefined || previous === undefined || previous === 0 ? undefined : ((value - previous) / previous) * 100

/** four whole-number ticks from zero that hold `max`: an axis of counts never reads 2.5 */
export const countTicks = (max: number) => {
  const raw = Math.max(1, max / 3)
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = ([1, 2, 5, 10].find((s) => s * power >= raw) ?? 10) * power
  return [0, step, 2 * step, 3 * step]
}
