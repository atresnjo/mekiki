// Geometry and scales for the chart cards (from the mebius charts kit, trimmed to what the cards here use): lines and
// their areas, the morph between two lines, axis ticks and Figma's dash fitting. A series is points at x ∈ [0, 1]
// (position along the period) with a value; the path helpers take pixel points ({ x, y }).

export type SeriesPoint = { x: number; value: number }

/** Scales a series into a width × height box: x across, values on [0, max] bottom to top. */
export function seriesToPixels(points: SeriesPoint[], width: number, height: number, max = Math.max(0, ...points.map((p) => p.value))) {
  return points.map((p) => ({ x: p.x * width, y: max > 0 ? height * (1 - p.value / max) : height }))
}

/** "M x y L x y …" through the points. */
export function linePath(points: { x: number; y: number }[]) {
  return points.map((p, i) => `${i ? "L" : "M"} ${round(p.x)} ${round(p.y)}`).join(" ")
}

/** The closed area under a line, its top edge `offset` px below the line (the Keitoto area fills start 1.5px under the stroke). */
export function areaPath(points: { x: number; y: number }[], height: number, offset = 0) {
  if (!points.length) return ""
  const top = points.map((p) => ({ x: p.x, y: Math.min(p.y + offset, height) }))
  return `${linePath(top)} L ${round(top[top.length - 1]!.x)} ${round(height)} L ${round(top[0]!.x)} ${round(height)} Z`
}

/** y of a polyline at x (linear between vertices, clamped at the ends). */
export function valueAt(points: { x: number; y: number }[], x: number) {
  const first = points[0]
  if (!first) return 0
  if (x <= first.x) return first.y
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
  }
  return points[points.length - 1]!.y
}

/**
 * Two lines resampled on the same x positions (every vertex of both, plus `extra` evenly spaced ones), so a morph can
 * interpolate y alone: at 0 it is exactly the first line, at 1 exactly the second. `curveAt` reads a line at x: its
 * straight segments (valueAt) by default.
 */
export function alignPolylines(
  from: { x: number; y: number }[],
  to: { x: number; y: number }[],
  extra = 24,
  curveAt: (line: { x: number; y: number }[]) => (x: number) => number = (line) => (x) => valueAt(line, x),
) {
  const left = Math.min(from[0]?.x ?? 0, to[0]?.x ?? 0)
  const right = Math.max(from[from.length - 1]?.x ?? 0, to[to.length - 1]?.x ?? 0)
  const xs = new Set<number>([...from.map((p) => p.x), ...to.map((p) => p.x)])
  for (let i = 0; i <= extra; i++) xs.add(left + ((right - left) * i) / extra)
  const sorted = [...xs].sort((a, b) => a - b)
  const fromAt = curveAt(from)
  const toAt = curveAt(to)
  return { xs: sorted, from: sorted.map((x) => fromAt(x)), to: sorted.map((x) => toAt(x)) }
}

/**
 * `count` evenly spaced round ticks covering [min, max], the step a 1, 2, 2.5 or 5 × 10ⁿ. When the data needs fewer
 * steps the range grows downward first (not below zero for data that isn't negative), then upward: data between
 * 12,185 and 23,319 gets 5K, 10K, 15K, 20K, 25K.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const ticks = Math.max(2, Math.round(count))
  if (!(max > min)) {
    const pad = Math.abs(min) * 0.1 || 1
    return niceTicks(min - pad, max + pad, ticks)
  }
  for (let power = Math.floor(Math.log10((max - min) / (ticks - 1))) - 1; ; power++) {
    for (const base of [1, 2, 2.5, 5]) {
      const step = base * 10 ** power
      let lo = Math.floor(min / step + 1e-9) * step
      let hi = Math.ceil(max / step - 1e-9) * step
      const steps = Math.round((hi - lo) / step)
      if (steps > ticks - 1) continue
      const missing = ticks - 1 - steps
      const down = min >= 0 ? Math.min(missing, Math.round(lo / step)) : missing
      lo -= down * step
      hi += (missing - down) * step
      const digits = Math.max(0, -power + 1)
      return Array.from({ length: ticks }, (_, i) => Number((lo + i * step).toFixed(digits)))
    }
  }
}

/**
 * Figma fits the dashes of an open line to whole periods, with half a dash at each end: the stroke-dasharray and
 * stroke-dashoffset that draw `dash` / `gap` that way along a line of `length` px.
 */
export function fittedDash(length: number, dash = 4, gap = 4) {
  const periods = Math.max(1, Math.round(length / (dash + gap)))
  const scale = length / (periods * (dash + gap))
  return { strokeDasharray: `${round(dash * scale)} ${round(gap * scale)}`, strokeDashoffset: round((dash * scale) / 2) }
}

const round = (n: number) => Math.round(n * 1000) / 1000
