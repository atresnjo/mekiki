// the numbers behind the overview cards: a time window, bucketed, against the window before it
import type { Review } from "./mekiki.ts"

export type Range = "24h" | "7d" | "30d"

export const RANGES: Record<Range, { readonly label: string; readonly ms: number; readonly buckets: number }> = {
  "24h": { label: "Past 24 hours", ms: 86_400_000, buckets: 48 },
  "7d": { label: "Past 7 days", ms: 7 * 86_400_000, buckets: 56 },
  "30d": { label: "Past 30 days", ms: 30 * 86_400_000, buckets: 60 },
}

export interface Metric {
  /** the value over the whole window; undefined: nothing to measure */
  readonly value: number | undefined
  /** the same over the window before, for the change arrow */
  readonly previous: number | undefined
  readonly series: Array<[number, number]>
}

/**
 * `measure` turns a set of finished reviews into one number. empty buckets are left out of the
 * series when `gaps` (an average of nothing isn't 0), kept as 0 otherwise (a count of nothing is)
 */
export const metric = (
  reviews: ReadonlyArray<Review>,
  range: Range,
  now: number,
  measure: (reviews: ReadonlyArray<Review>) => number | undefined,
  options: { readonly gaps?: boolean } = {},
): Metric => {
  const { ms, buckets } = RANGES[range]
  const finished = reviews.filter((r) => r.status !== "running")
  const start = now - ms
  const current = finished.filter((r) => r.startedAt >= start)
  const before = finished.filter((r) => r.startedAt >= start - ms && r.startedAt < start)
  const size = ms / buckets
  const series: Array<[number, number]> = []
  for (let i = 0; i < buckets; i++) {
    const from = start + i * size
    const inBucket = current.filter((r) => r.startedAt >= from && r.startedAt < from + size)
    const v = inBucket.length === 0 && options.gaps ? undefined : (measure(inBucket) ?? (options.gaps ? undefined : 0))
    if (v !== undefined) series.push([Math.round(from + size), v])
  }
  return { value: current.length === 0 ? undefined : measure(current), previous: before.length === 0 ? undefined : measure(before), series }
}

/** percent change, or undefined when there's nothing to compare against */
export const change = (m: Metric) =>
  m.value === undefined || m.previous === undefined || m.previous === 0 ? undefined : ((m.value - m.previous) / m.previous) * 100
