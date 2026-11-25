"use client"

// mebius charts kit: charts-financial-breakdown (https://www.mebius.design/freebies/charts/financial-breakdown).
// changed here: `format` and `formatTick` replace the currency formatting (the overview counts reviews), and a series
// can be red (failures)

import { animate, stagger, utils, type JSAnimation } from "animejs"
import * as React from "react"

import { ChartButton } from "@/components/ui/chart-button"
import { ChartCard } from "@/components/ui/chart-card"
import { ChartIconTile } from "@/components/ui/chart-icon-tile"
import { ArrowUpRightIcon, PieChartSegmentsIcon } from "@/components/ui/chart-icons"
import { ChartSwatch } from "@/components/ui/chart-swatch"
import { releaseStyles, useChartEntrance, useCountUp, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useChartSize } from "@/hooks/use-chart-size"
import { useControllableState } from "@/hooks/use-controllable-state"
import { formatCompactCurrency, formatCurrency, formatDay } from "@/lib/chart-format"
import { fittedDash, niceTicks } from "@/lib/chart-series"
import { cn } from "@/lib/utils"

type FinancialBreakdownColor = "green" | "orange" | "blue" | "purple" | "yellow" | "red"

/** One stacked series: its stat at the top of the card, its segment in every bar and its row in the tooltip. */
type FinancialBreakdownSeries = {
  /** The key of the series' amount in each point's `values`. */
  key: string
  label: string
  color?: FinancialBreakdownColor
  /** The amount under the label at the top of the card; the sum of the series' values by default. */
  total?: number
}

type FinancialBreakdownPoint = {
  /** The day, as an ISO date ("2026-05-06"), or any text `formatDate` reads. */
  date: string
  /** The day's amount per series key (a missing key counts as 0). */
  values: Record<string, number>
}

type FinancialBreakdownChartProps = Omit<React.ComponentProps<"div">, "children"> & {
  title?: string
  /** The glyph in the purple tile (16px, white). */
  icon?: React.ReactNode
  /** The series, stacked bottom to top (and listed left to right at the top of the card). */
  series?: FinancialBreakdownSeries[]
  /** One stacked bar per day, oldest first. */
  data?: FinancialBreakdownPoint[]
  /** Keys of the series taken off the chart; each stat at the top toggles its own. */
  hiddenSeries?: string[]
  defaultHiddenSeries?: string[]
  onHiddenSeriesChange?: (hidden: string[]) => void
  /** The y-axis values, lowest first. Four round values from zero by default, fitted to the shown series. */
  ticks?: number[]
  /** The selected day (an index into `data`). */
  index?: number
  defaultIndex?: number
  onIndexChange?: (index: number, point: FinancialBreakdownPoint) => void
  /** Text for a day on the x axis ("May 6") and in the tooltip ("Wed, May 6"). */
  formatDate?: (date: string, context: "axis" | "tooltip") => string
  /** The totals and the tooltip's amounts; currency in `locale` and `currency` by default. */
  format?: (value: number) => string
  /** The y axis' values; compact currency by default. */
  formatTick?: (value: number) => string
  /** The header button's text. */
  viewDataLabel?: string
  /** Called by the "View data" button. */
  onViewDataClick?: () => void
  locale?: string
  currency?: string
}

type Segment = { top: number; bottom: number }
/**
 * A day's stack: its segments (one per series, zero high when hidden or empty), its whole extent and the amounts it
 * was stacked from (0 for a hidden series).
 */
type Stack = { x: number; center: number; top: number; bottom: number; segments: Segment[]; values: number[] }

// Figma geometry ("Financial Breakdown Chart" 1473:82870)
const PLOT_WIDTH = 753
const PLOT_HEIGHT = 160 // Figma's 240, smaller to fit the dashboard
const GRID_TOP = 16 // Figma's 1px grid lines cover [y - 1, y]: the top one ends at 16…
const GRID_BOTTOM = PLOT_HEIGHT - 4 // …the axis 4px above the bottom
const BASE = GRID_BOTTOM - 1 // the lowest tick's value sits on the axis' top edge (the bars stand on it)…
const SPAN = GRID_BOTTOM - GRID_TOP // …and the highest one 220px above it, on the top line's top edge
const TICK_COUNT = 4
const BAR_WIDTH = 32
const BAR_RATIO = 32 / 60 // a bar takes 32 of every 60px, and narrows when the days come closer together
const BAR_RADIUS = 4
const BARS_END = 1 // the bars stop 1px short of the plot's right edge (752 of 753)
const SEGMENT_GAP = 1 // a segment leaves 1px free under it when another one sits below
const COLUMN_PAD = 8 // the highlight column reaches 8px past its bar on each side, over the outer grid lines
const TIP_GAP = 10 // the tooltip sits 10px right of the column (left of it near the edge) and 10px under its top
const TIP_PADDING_X = 24 // its 8px left and 16px right padding
const TIP_PADDING_Y = 16 // and 8px top and bottom
const LABEL_GAP = 8 // the least space between two x-axis labels
const LABEL_CHAR = 7.5 // about how wide a character of Label/02 is
const BARS_AT = 250
const BAR_STAGGER = 45
const STACK = 1100 // a bar's segments stack up one after another within this time
const STACK_DELAY = 0.18 // each segment starts this share of the time after the one under it
const MORPH = 750
const DAY = 86_400_000
const RING = "focus-visible:ring-primary-purple-500/40" // the card's focus rings are purple

const colors: Record<FinancialBreakdownColor, { fill: string; swatch: string }> = {
  green: { fill: "fill-primary-green-500", swatch: "bg-primary-green-500" },
  orange: { fill: "fill-primary-orange-500", swatch: "bg-primary-orange-500" },
  blue: { fill: "fill-primary-blue-500", swatch: "bg-primary-blue-500" },
  purple: { fill: "fill-primary-purple-500", swatch: "bg-primary-purple-500" },
  yellow: { fill: "fill-primary-yellow-500", swatch: "bg-primary-yellow-500" },
  red: { fill: "fill-error-500", swatch: "bg-error-500" },
}

const sampleFinancialBreakdownSeries: FinancialBreakdownSeries[] = [
  { key: "assets", label: "Assets", color: "green", total: 643867.09 },
  { key: "debt", label: "Debt", color: "orange", total: 138645.16 },
  { key: "investments", label: "Investments", color: "blue", total: 264864.86 },
  { key: "cash", label: "Cash", color: "purple", total: 79742.92 },
]

/** One point per row of [assets, debt, investments, cash] on consecutive days from `start` (an ISO date). */
function daily(start: string, rows: (number | undefined)[][]): FinancialBreakdownPoint[] {
  const from = Date.parse(`${start}T00:00:00Z`)
  const keys = sampleFinancialBreakdownSeries.map((series) => series.key)
  return rows.map((row, i) => ({
    date: new Date(from + i * DAY).toISOString().slice(0, 10),
    values: Object.fromEntries(row.flatMap((value, k) => (value === undefined ? [] : [[keys[k], value]]))),
  }))
}

// The Figma card: 1 to 13 May 2026 with 6 May selected. The values stack the segments as tall as Figma draws them on
// its $0–$60K axis (11px per $3K), each segment above another one keeping its 1px gap.
const sampleFinancialBreakdownData = daily("2026-05-01", [
  [9272.73, 1636.36, 4636.36, 5727.27],
  [7363.64, 2727.27, 7090.91, 2454.55],
  [4090.91, undefined, 4636.36, 8727.27],
  [9000, undefined, undefined, 8727.27],
  [undefined, 5454.55, 7090.91, 18000],
  [4363.64, 5181.82, 3000, 22909.09],
  [17454.55, 4363.64, 11454.55, 17454.55],
  [13909.09, 9272.73, 13363.64, 8727.27],
  [9545.45, 6272.73, 16363.64, 15545.45],
  [4363.64, 4909.09, undefined, 3272.73],
  [1636.36, 2454.55, 1636.36, 3000],
  [12272.73, 4909.09, 4909.09, 8727.27],
  [1636.36, 2181.82, undefined, undefined],
])
const SAMPLE_SELECTED = 5

const round = (n: number) => Math.round(n * 1000) / 1000
const outCubic = (t: number) => 1 - (1 - t) ** 3

/**
 * A day's stack from its signed amounts (bottom series first) on a y scale: amounts above zero stack up from `zero`,
 * amounts below it down; a segment with another one between it and zero leaves a 1px gap there. An empty segment
 * sits where it would start, so it can grow out of the stack.
 */
function stackSegments(values: number[], y: (value: number) => number, zero: number) {
  let up = 0
  let down = 0
  const segments = values.map((value): Segment => {
    if (value > 0) {
      const from = up
      up += value
      const top = y(up)
      return { top, bottom: Math.max(top, y(from) - (from > 0 ? SEGMENT_GAP : 0)) }
    }
    if (value < 0) {
      const from = down
      down += value
      const bottom = y(down)
      return { top: Math.min(bottom, y(from) + (from < 0 ? SEGMENT_GAP : 0)), bottom }
    }
    const at = y(up)
    return { top: at, bottom: at }
  })
  return { top: Math.min(zero, y(up)), bottom: Math.max(zero, y(down)), segments }
}

/**
 * Where everything sits at a plot width. The y scale runs from the lowest tick on the axis (235) to the highest on the
 * top line (15), fitted to the shown series (all of them when none is shown); the bars stand on zero and are spread
 * from the plot's left edge to 1px short of its right one, 32px wide while there is room.
 */
function layoutChart(data: FinancialBreakdownPoint[], series: FinancialBreakdownSeries[], hidden: string[], ticksProp: number[] | undefined, width: number) {
  const amounts = (point: FinancialBreakdownPoint, all = false) => series.map((s) => (all || !hidden.includes(s.key) ? (point.values[s.key] ?? 0) : 0))
  const extent = (all: boolean) => {
    const sums = data.map((point) => amounts(point, all))
    return [
      Math.min(0, ...sums.map((v) => v.reduce((sum, a) => sum + Math.min(0, a), 0))),
      Math.max(0, ...sums.map((v) => v.reduce((sum, a) => sum + Math.max(0, a), 0))),
    ] as const
  }
  let [min, max] = extent(false)
  if (!(max > min)) [min, max] = extent(true)
  const ticks = ticksProp?.length ? [...ticksProp].sort((a, b) => a - b) : niceTicks(min, max > min ? max : min + 1, TICK_COUNT)
  const lo = ticks[0]!
  const hi = ticks[ticks.length - 1]!
  const y = (value: number) => (hi > lo ? BASE - ((Math.min(Math.max(value, lo), hi) - lo) / (hi - lo)) * SPAN : BASE)
  const base = Math.min(Math.max(0, lo), hi)
  const zero = y(base)
  const n = data.length
  const room = Math.max(0, width - BARS_END)
  const barWidth = round(n > 1 ? Math.min(BAR_WIDTH, (BAR_RATIO * room) / (n - 1 + BAR_RATIO)) : Math.min(BAR_WIDTH, room))
  const pitch = n > 1 ? (room - barWidth) / (n - 1) : room
  const stacks: Stack[] = data.map((point, i) => {
    const x = round(n > 1 ? i * pitch : (room - barWidth) / 2)
    const values = amounts(point)
    return { x, center: x + barWidth / 2, values, ...stackSegments(values, y, zero) }
  })
  // a 1px line over [y, y + 1] under each tick's value: dashed, the zero line solid
  const grid = ticks.map((tick) => ({ tick, y: y(tick) + 0.5, solid: tick === base }))
  return { ticks, y, zero, barWidth, pitch, stacks, grid }
}

/** A stack's outline: its four outer corners round (a path with arcs, which Chrome anti-aliases like Figma). */
function stackShape(x: number, width: number, top: number, bottom: number) {
  const h = bottom - top
  if (h <= 0.01) return `M ${round(x)} ${round(top)} Z`
  const r = round(Math.min(BAR_RADIUS, h / 2, width / 2))
  const [l, rt, t, b] = [x, x + width, top, bottom].map(round) as [number, number, number, number]
  return `M ${l} ${round(t + r)} A ${r} ${r} 0 0 1 ${round(l + r)} ${t} H ${round(rt - r)} A ${r} ${r} 0 0 1 ${rt} ${round(t + r)} V ${round(b - r)} A ${r} ${r} 0 0 1 ${round(rt - r)} ${b} H ${round(l + r)} A ${r} ${r} 0 0 1 ${l} ${round(b - r)} Z`
}

/** Writes a stack's geometry to its clip (the rounded outline) and its segment rectangles. */
function drawStack(clip: SVGPathElement | undefined, rects: SVGRectElement[], stack: Stack, barWidth: number) {
  clip?.setAttribute("d", stackShape(stack.x, barWidth, stack.top, stack.bottom))
  stack.segments.forEach((segment, k) => {
    const rect = rects[k]
    if (!rect) return
    rect.setAttribute("x", String(round(stack.x)))
    rect.setAttribute("width", String(round(barWidth)))
    rect.setAttribute("y", String(round(segment.top)))
    rect.setAttribute("height", String(round(Math.max(0, segment.bottom - segment.top))))
  })
}

const lerpStack = (from: Stack, to: Stack, t: number): Stack => {
  const lerp = (a: number, b: number) => a + (b - a) * t
  return {
    ...to,
    x: lerp(from.x, to.x),
    center: lerp(from.center, to.center),
    top: lerp(from.top, to.top),
    bottom: lerp(from.bottom, to.bottom),
    segments: to.segments.map((segment, k) => ({
      top: lerp(from.segments[k]?.top ?? segment.top, segment.top),
      bottom: lerp(from.segments[k]?.bottom ?? segment.bottom, segment.bottom),
    })),
  }
}

type TooltipRowData = { key: string; label: string; color: FinancialBreakdownColor; value: number; hidden: boolean }

/** A tooltip row: swatch, label (88px, as in Figma) and amount, dimmed while its series is hidden. */
function TooltipRow({ row, money, counting }: { row: TooltipRowData; money: (value: number) => string; counting?: boolean }) {
  const valueRef = React.useRef<HTMLSpanElement>(null)
  useCountUp(valueRef, row.value, money, { enabled: !!counting, duration: 550 })
  return (
    <span
      data-slot="financial-breakdown-chart-tooltip-row"
      className={cn("flex items-center gap-1.5 py-0.5 transition-opacity duration-300", row.hidden && "opacity-40")}
    >
      <ChartSwatch className={colors[row.color].swatch} />
      <span className="-my-0.5 w-[88px] shrink-0 truncate py-0.5 typo-label-02-regular text-fg-soft">{row.label}</span>
      <span ref={valueRef} data-slot={counting ? "financial-breakdown-chart-tooltip-value" : undefined} className="hug-w typo-label-03-medium text-fg-white">
        {money(row.value)}
      </span>
    </span>
  )
}

/** The tooltip's date and rows. Rendered twice: visible (its amounts count) and as an invisible copy that is measured. */
function TooltipContent({ date, rows, money, counting }: { date: string; rows: TooltipRowData[]; money: (value: number) => string; counting?: boolean }) {
  return (
    <>
      <span className="hug-w typo-label-02-regular text-fg-disable">{date}</span>
      {rows.map((row) => (
        <TooltipRow key={row.key} row={row} money={money} counting={counting} />
      ))}
    </>
  )
}

/** A stat at the top of the card: the series' swatch, label and total; pressing it shows or hides the series. */
function Stat({
  series,
  total,
  hidden,
  onToggle,
  money,
}: {
  series: FinancialBreakdownSeries
  total: number
  hidden: boolean
  onToggle: () => void
  money: (value: number) => string
}) {
  const totalRef = React.useRef<HTMLSpanElement>(null)
  useCountUp(totalRef, total, money, { duration: 900 })
  return (
    <button
      type="button"
      aria-pressed={!hidden}
      data-slot="financial-breakdown-chart-stat"
      onClick={onToggle}
      className={cn(
        "group/stat flex min-w-0 cursor-pointer flex-col items-start gap-2 rounded-lg text-left outline-none transition-opacity duration-300 focus-visible:ring-2",
        RING,
        hidden && "opacity-40",
      )}
    >
      <span className="flex max-w-full items-center gap-2">
        <ChartSwatch data-slot="financial-breakdown-chart-stat-swatch" className={cn("origin-left", colors[series.color ?? "blue"].swatch)} />
        <span className="-my-0.5 min-w-0 truncate py-0.5 typo-label-03-medium text-fg-normal transition-colors duration-200 group-hover/stat:text-fg-loud">
          {series.label}
        </span>
      </span>
      <span ref={totalRef} data-slot="financial-breakdown-chart-stat-total" className="hug-w typo-label-04-semibold whitespace-nowrap text-fg-loud">
        {money(total)}
      </span>
    </button>
  )
}

/**
 * "Financial Breakdown Chart" from the Keitoto library: the totals of a few series under a purple-tiled title with a
 * "View data" button, and a stacked bar per day on a dashed grid. The selected day gets a lilac column and a dark
 * tooltip with its amounts. Hover previews a day, click or the arrow keys select one, and each total at the top shows
 * or hides its series. Animated with anime.js: the tile pops, the totals count up, the grid draws across, every bar
 * stacks up segment by segment, then the column rises and the tooltip pops in with its amounts counting; a new day
 * slides the column and the tooltip over while the amounts count, and hiding or showing a series morphs every stack
 * (and the axis when its range changes).
 */
function FinancialBreakdownChart({
  title = "Financial Breakdown",
  icon = <PieChartSegmentsIcon />,
  series = sampleFinancialBreakdownSeries,
  data: dataProp,
  hiddenSeries,
  defaultHiddenSeries,
  onHiddenSeriesChange,
  ticks: ticksProp,
  index: indexProp,
  defaultIndex,
  onIndexChange,
  formatDate,
  format,
  formatTick,
  viewDataLabel = "View data",
  onViewDataClick,
  locale = "en-US",
  currency = "USD",
  className,
  ...props
}: FinancialBreakdownChartProps) {
  const data = dataProp ?? sampleFinancialBreakdownData
  const n = data.length
  const [indexValue, setIndex] = useControllableState({
    value: indexProp,
    // the sample opens on Figma's day, your data on its latest
    defaultValue: defaultIndex ?? (dataProp ? n - 1 : SAMPLE_SELECTED),
    onChange: (next: number) => {
      const point = data[next]
      if (point) onIndexChange?.(next, point)
    },
  })
  const [hidden, setHidden] = useControllableState<string[]>({ value: hiddenSeries, defaultValue: defaultHiddenSeries ?? [], onChange: onHiddenSeriesChange })
  const [plotRef, plot] = useChartSize<HTMLDivElement>({ width: PLOT_WIDTH, height: PLOT_HEIGHT })
  const width = plot.width || PLOT_WIDTH
  const { ticks, y, zero, barWidth, pitch, stacks, grid } = React.useMemo(
    () => layoutChart(data, series, hidden, ticksProp, width),
    [data, series, hidden, ticksProp, width],
  )
  // Content keys: parents may pass new arrays on every render, so changes are detected by value.
  const shapeKey = `${barWidth}|${stacks.map((stack) => `${stack.x},${stack.top},${stack.bottom}:${stack.segments.map((s) => `${s.top},${s.bottom}`).join(",")}`).join(";")}`
  const ticksKey = ticks.join(";")

  const [hovered, setHovered] = React.useState<number | null>(null)
  const selected = n ? Math.min(Math.max(Math.round(indexValue), 0), n - 1) : -1
  const active = hovered !== null && hovered < n ? hovered : selected
  const point = data[active]
  const activeStack = stacks[active]

  const money = React.useCallback((value: number) => (format ? format(value) : formatCurrency(value, { locale, currency })), [format, locale, currency])
  const tickText = (value: number) => (formatTick ? formatTick(value) : formatCompactCurrency(value, { locale, currency }))
  const dateText = (date: string, context: "axis" | "tooltip") =>
    formatDate
      ? formatDate(date, context)
      : formatDay(date, context === "axis" ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" }, locale)
  const rows: TooltipRowData[] = point
    ? series.map((s) => ({ key: s.key, label: s.label, color: s.color ?? "blue", value: point.values[s.key] ?? 0, hidden: hidden.includes(s.key) }))
    : []
  const totals = series.map((s) => s.total ?? data.reduce((sum, day) => sum + (day.values[s.key] ?? 0), 0))

  // The tooltip sits 10px right of the column and 10px under its top, or left of the column when it would run past
  // the plot. Its size is measured on an invisible copy that holds the final text.
  const [sizerRef, sizer] = useChartSize<HTMLSpanElement>({ width: 193, height: 126 })
  const tipWidth = sizer.width + TIP_PADDING_X
  const tipHeight = sizer.height + TIP_PADDING_Y
  const columnX = activeStack ? activeStack.x - COLUMN_PAD : 0
  const columnWidth = barWidth + 2 * COLUMN_PAD
  const flipped = columnX + columnWidth + TIP_GAP + tipWidth > width
  const tipLeft = Math.round(flipped ? Math.max(0, columnX - TIP_GAP - tipWidth) : columnX + columnWidth + TIP_GAP)
  const tipTop = Math.max(0, Math.min(GRID_TOP - 1 + TIP_GAP, PLOT_HEIGHT - tipHeight))

  // The x axis names every day, or every second (third…) one when the days come too close for their labels.
  const labels = data.map((day) => dateText(day.date, "axis"))
  const longest = Math.max(0, ...labels.map((label) => label.length))
  const every = n > 1 && pitch > 0 ? Math.max(1, Math.ceil((longest * LABEL_CHAR + LABEL_GAP) / pitch)) : 1

  const reduced = useReducedMotion()
  const root = React.useRef<HTMLDivElement>(null)
  const columnRef = React.useRef<SVGRectElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const ids = React.useId().replace(/[^\w-]/g, "")
  // what the entrance's callbacks need at play time (the card may be resized before it scrolls into view)
  const latest = React.useRef({ stacks, y, zero, barWidth, totals, rows })
  useIsomorphicLayoutEffect(() => {
    latest.current = { stacks, y, zero, barWidth, totals, rows }
  })
  const all = (selector: string) => Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])
  const shapes = () => ({
    clips: Array.from(root.current?.querySelectorAll<SVGPathElement>('[data-slot="financial-breakdown-chart-bar-shape"]') ?? []),
    bars: Array.from(root.current?.querySelectorAll<SVGGElement>('[data-slot="financial-breakdown-chart-bar"]') ?? []).map((bar) =>
      Array.from(bar.querySelectorAll<SVGRectElement>('[data-slot="financial-breakdown-chart-segment"]')),
    ),
  })
  // How far the entrance has grown each stack (null without one), so a redraw before it is done (the card resized as
  // its font loads, new data) keeps the stacks where the entrance has them.
  const growing = React.useRef<{ t: number }[] | null>(null)
  /** Draws stack i of the latest layout `t` of the way through its entrance: each segment grows after the one under it. */
  const growStack = (clip: SVGPathElement | undefined, rects: SVGRectElement[], i: number, t: number) => {
    const { stacks, y, zero, barWidth } = latest.current
    const stack = stacks[i]
    if (!stack) return
    const window = 1 - STACK_DELAY * Math.max(0, stack.values.length - 1)
    const values = stack.values.map((value, k) => value * outCubic(Math.min(1, Math.max(0, (t - k * STACK_DELAY) / window))))
    drawStack(clip, rects, { ...stack, ...stackSegments(values, y, zero) }, barWidth)
  }

  // Entrance, once the card is in view: the tile pops, the totals count up as their swatches grow, the grid lines draw
  // across and the axis labels come in, every bar stacks up from the axis segment by segment (left to right), then the
  // column rises behind the selected day and the tooltip pops in with its amounts counting up.
  useChartEntrance(root, (timeline) => {
    const { clips, bars } = shapes()
    const statTotals = all('[data-slot="financial-breakdown-chart-stat-total"]')
    const tipValues = all('[data-slot="financial-breakdown-chart-tooltip-value"]')
    const growth = bars.map(() => ({ t: 0 }))
    growing.current = growth
    const grow = (i: number) => growStack(clips[i], bars[i] ?? [], i, growth[i]?.t ?? 1)
    bars.forEach((_, i) => grow(i))
    // the totals count up from zero together, and so do the tooltip's amounts later
    const counters = { totals: 0, tips: 0 }
    const count = () => {
      const { totals, rows } = latest.current
      statTotals.forEach((el, k) => (el.textContent = money((totals[k] ?? 0) * counters.totals)))
      tipValues.forEach((el, k) => (el.textContent = money((rows[k]?.value ?? 0) * counters.tips)))
    }
    count()
    const shownAt = BARS_AT + Math.max(0, active) * BAR_STAGGER + STACK * 0.55
    timeline
      .add(all('[data-slot="chart-icon-tile"]'), { scale: { from: 0.6 }, opacity: { from: 0 }, duration: 700, ease: "outBack(1.8)" }, 0)
      .add(all('[data-slot="financial-breakdown-chart-stat-swatch"]'), { scaleX: { from: 0 }, duration: 700, ease: "outExpo", delay: stagger(90) }, 100)
      .add(counters, { totals: [0, 1], duration: 1400, ease: "outExpo", onUpdate: count }, 0)
      .add(all('[data-slot="financial-breakdown-chart-grid-line"]'), { x2: { from: 0 }, duration: 900, ease: "outQuad", delay: stagger(60) }, 100)
      .add(
        all('[data-slot="financial-breakdown-chart-tick"]'),
        { opacity: { from: 0 }, translateX: { from: -4 }, duration: 600, ease: "outQuad", delay: stagger(45) },
        200,
      )
      .add(
        all('[data-slot="financial-breakdown-chart-axis-label"] > span'),
        { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad", delay: stagger(35) },
        300,
      )
    growth.forEach((state, i) => timeline.add(state, { t: [0, 1], duration: STACK, ease: "linear", onUpdate: () => grow(i) }, BARS_AT + i * BAR_STAGGER))
    if (columnRef.current) timeline.add(columnRef.current, { scaleY: { from: 0 }, duration: 800, ease: "outExpo" }, shownAt)
    if (tipRef.current)
      timeline.add(tipRef.current, { opacity: { from: 0 }, translateY: { from: 6 }, scale: { from: 0.94 }, duration: 500, ease: "outBack(1.6)" }, shownAt + 250)
    if (tipValues.length) timeline.add(counters, { tips: [0, 1], duration: 900, ease: "outExpo", onUpdate: count }, shownAt + 250)
    return () => {
      if (growing.current === growth) growing.current = null
      const { stacks, barWidth, totals, rows } = latest.current
      stacks.forEach((stack, i) => drawStack(clips[i], bars[i] ?? [], stack, barWidth))
      statTotals.forEach((el, k) => (el.textContent = money(totals[k] ?? 0)))
      tipValues.forEach((el, k) => (el.textContent = money(rows[k]?.value ?? 0)))
    }
  })

  // New data, a hidden or shown series or a new axis morphs every stack from the shape it has on screen (the segments
  // of a hidden series fold away, the others close up). A resize redraws them at once, unless it comes during a morph
  // (new ticks can widen the axis labels): then the morph carries on to the new layout. While the entrance runs, the
  // stacks are redrawn as far as it has grown them (it carries on with the new layout).
  const shown = React.useRef({ stacks, barWidth })
  const lastShape = React.useRef({ key: shapeKey, width })
  const morph = React.useRef<JSAnimation | null>(null)
  useIsomorphicLayoutEffect(() => {
    const before = lastShape.current
    lastShape.current = { key: shapeKey, width }
    if (before.key === shapeKey) return
    const { clips, bars } = shapes()
    const morphing = !!morph.current
    morph.current?.cancel()
    morph.current = null
    const target = { stacks, barWidth }
    const entrance = growing.current
    if (entrance?.some((stack) => stack.t < 1)) {
      shown.current = target
      bars.forEach((rects, i) => growStack(clips[i], rects, i, entrance[i]?.t ?? 1))
      return
    }
    const draw = (frame: typeof target) => {
      shown.current = frame
      frame.stacks.forEach((stack, i) => drawStack(clips[i], bars[i] ?? [], stack, frame.barWidth))
    }
    if (reduced || (before.width !== width && !morphing)) {
      draw(target)
      return
    }
    const from = shown.current
    const at = (t: number) => ({
      barWidth: from.barWidth + (barWidth - from.barWidth) * t,
      stacks: stacks.map((stack, i) =>
        lerpStack(from.stacks[i] ?? { ...stack, top: zero, bottom: zero, segments: stack.segments.map(() => ({ top: zero, bottom: zero })) }, stack, t),
      ),
    })
    const state = { t: 0 }
    draw(at(0))
    morph.current = animate(state, {
      t: 1,
      duration: MORPH,
      ease: "outExpo",
      onUpdate: () => draw(at(state.t)),
      onComplete: () => {
        morph.current = null
        draw(target)
      },
    })
  }, [shapeKey, reduced])
  React.useEffect(
    () => () => {
      morph.current?.cancel()
    },
    [],
  )

  // A new day slides the column and the tooltip over (they fade in when the days were laid out again); when the
  // tooltip changes sides it pops in again.
  const lastSelection = React.useRef({ active, n, width, columnX, tipLeft, tipTop, flipped })
  useIsomorphicLayoutEffect(() => {
    const before = lastSelection.current
    lastSelection.current = { active, n, width, columnX, tipLeft, tipTop, flipped }
    if (reduced || before.width !== width) return
    const column = columnRef.current
    const tip = tipRef.current
    const relaid = before.n !== n
    if (column && (relaid || before.columnX !== columnX)) {
      if (relaid) animate(column, { opacity: [0, 1], duration: 400, ease: "outQuad", onComplete: releaseStyles("opacity") })
      else
        animate(column, {
          translateX: [before.columnX - columnX + (utils.get(column, "translateX", false) as number), 0],
          duration: 550,
          ease: "outExpo",
          onComplete: releaseStyles("transform"),
        })
    }
    if (tip && (relaid || before.tipLeft !== tipLeft || before.tipTop !== tipTop)) {
      if (relaid || before.flipped !== flipped)
        animate(tip, { opacity: [0, 1], scale: [0.94, 1], duration: 300, ease: "outQuad", onComplete: releaseStyles("opacity", "transform") })
      else
        animate(tip, {
          translateX: [before.tipLeft - tipLeft + (utils.get(tip, "translateX", false) as number), 0],
          translateY: [before.tipTop - tipTop + (utils.get(tip, "translateY", false) as number), 0],
          duration: 550,
          ease: "outExpo",
          onComplete: releaseStyles("transform"),
        })
    }
  }, [active, n, width, columnX, tipLeft, tipTop, flipped, reduced])

  // New ticks fade their labels in again.
  const lastTicks = React.useRef(ticksKey)
  useIsomorphicLayoutEffect(() => {
    const before = lastTicks.current
    lastTicks.current = ticksKey
    if (before === ticksKey || reduced) return
    animate(all('[data-slot="financial-breakdown-chart-tick"]'), {
      opacity: [0, 1],
      translateX: [-4, 0],
      duration: 450,
      delay: stagger(35),
      ease: "outQuad",
      onComplete: releaseStyles("opacity", "transform"),
    })
  }, [ticksKey, reduced])

  const select = (next: number) => {
    if (!n) return
    setIndex(Math.min(Math.max(next, 0), n - 1))
  }
  const toggle = (key: string) => setHidden(hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key])
  const onDayKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: n - 1,
    }
    const next = keys[event.key]
    if (next === undefined || !n) return
    event.preventDefault()
    const index = Math.min(Math.max(next, 0), n - 1)
    setHovered(null)
    select(index)
    root.current?.querySelectorAll<HTMLButtonElement>('[data-slot="financial-breakdown-chart-day"]')[index]?.focus()
  }
  const dayLabel = (day: FinancialBreakdownPoint) =>
    `${dateText(day.date, "tooltip")}: ${series
      .filter((s) => !hidden.includes(s.key))
      .map((s) => `${s.label} ${money(day.values[s.key] ?? 0)}`)
      .join(", ")}`

  const gridDash = fittedDash(width, 5, 5)

  return (
    <ChartCard ref={root} role="group" aria-label={title} className={cn("w-full", className)} {...props}>
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-2">
          {/* Primary/Purple/purple-500 with a #ad45ff ring */}
          <ChartIconTile
            size={30}
            className="bg-primary-purple-500 shadow-[inset_0_-2px_3px_rgb(0_0_0/0.08),0_0_0_1px_#ad45ff,0_4px_4px_-3px_rgb(0_0_0/0.16),0_2px_4px_rgb(1_1_1/0.08)]"
          >
            {icon}
          </ChartIconTile>
          {/* the padding keeps the descenders out of truncate's clip (the text styles have a line height of 1) */}
          <p className="-my-0.5 min-w-0 truncate py-0.5 typo-label-04-semibold text-fg-loud">{title}</p>
        </div>
        <ChartButton corner="rounded" onClick={onViewDataClick} className={cn("text-fg-normal", RING)}>
          {viewDataLabel}
          <ArrowUpRightIcon />
        </ChartButton>
      </div>

      {/* Figma: four equal columns 24px apart; they wrap two by two when the card gets too narrow for the amounts */}
      <div role="group" aria-label="Series" className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] items-start gap-x-6 gap-y-4">
        {series.map((s, k) => (
          <Stat key={s.key} series={s} total={totals[k] ?? 0} hidden={hidden.includes(s.key)} onToggle={() => toggle(s.key)} money={money} />
        ))}
      </div>

      <div className="flex items-start gap-3">
        {/* Figma "Y Axis Labels": 35px wide (wider labels widen it), spread from 8px down to the bottom, left-aligned */}
        <div aria-hidden className="flex hug-w min-w-[35px] shrink-0 flex-col justify-between pt-2" style={{ height: PLOT_HEIGHT }}>
          {[...ticks].reverse().map((tick) => (
            <span key={tick} data-slot="financial-breakdown-chart-tick" className="typo-label-02-regular whitespace-nowrap text-fg-soft">
              {tickText(tick)}
            </span>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div
            ref={plotRef}
            data-slot="financial-breakdown-chart-plot"
            className="relative"
            style={{ height: PLOT_HEIGHT }}
            onPointerLeave={() => setHovered(null)}
          >
            <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
              <defs>
                {stacks.map((stack, i) => (
                  <clipPath key={i} id={`${ids}-bar-${i}`}>
                    <path data-slot="financial-breakdown-chart-bar-shape" d={stackShape(stack.x, barWidth, stack.top, stack.bottom)} />
                  </clipPath>
                ))}
              </defs>
              {activeStack && (
                // the selected day's column: #b85eff at 16%, over the outer grid lines and under the dashed ones
                <rect
                  ref={columnRef}
                  data-slot="financial-breakdown-chart-column"
                  x={columnX}
                  y={GRID_TOP - 1}
                  width={columnWidth}
                  height={GRID_BOTTOM - GRID_TOP + 1}
                  className="origin-bottom fill-[rgb(184_94_255/0.16)] [transform-box:fill-box]"
                />
              )}
              {/* Figma "Grid Line": 1px Border/Soft over [y, y + 1] under each tick, dashed 5/5, the axis solid */}
              {grid.map((line) => (
                <line
                  key={line.tick}
                  data-slot="financial-breakdown-chart-grid-line"
                  x1={0}
                  x2={width}
                  y1={line.y}
                  y2={line.y}
                  className="stroke-border-soft"
                  {...(line.solid ? {} : gridDash)}
                />
              ))}
              {stacks.map((stack, i) => (
                // the stack's outline rounds its outer corners; the segments are plain rectangles inside it
                <g key={i} data-slot="financial-breakdown-chart-bar" clipPath={`url(#${ids}-bar-${i})`}>
                  {stack.segments.map((segment, k) => (
                    <rect
                      key={series[k]?.key ?? k}
                      data-slot="financial-breakdown-chart-segment"
                      x={stack.x}
                      y={segment.top}
                      width={barWidth}
                      height={Math.max(0, segment.bottom - segment.top)}
                      className={colors[series[k]?.color ?? "blue"].fill}
                    />
                  ))}
                </g>
              ))}
            </svg>

            <div role="group" aria-label={`${title} by day`}>
              {data.map((day, i) => {
                const stack = stacks[i]!
                const left = n > 1 ? Math.max(0, stack.center - pitch / 2) : 0
                const right = n > 1 ? Math.min(width, stack.center + pitch / 2) : width
                return (
                  <button
                    key={i}
                    type="button"
                    data-slot="financial-breakdown-chart-day"
                    aria-label={dayLabel(day)}
                    aria-pressed={i === selected}
                    tabIndex={i === selected ? 0 : -1}
                    onPointerEnter={() => setHovered(i)}
                    onClick={() => select(i)}
                    onKeyDown={onDayKeyDown}
                    className="absolute inset-y-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-purple-500/40"
                    style={{ left, width: right - left }}
                  />
                )
              })}
            </div>

            {point && (
              <div
                ref={tipRef}
                aria-hidden
                data-slot="financial-breakdown-chart-tooltip"
                className={cn(
                  "pointer-events-none absolute flex flex-col items-start gap-2 overflow-hidden rounded-[10px] bg-surface-loud py-2 pr-4 pl-2 whitespace-nowrap",
                  // Figma paints later effects on top; CSS paints the first shadow on top
                  "shadow-[inset_0_2px_8px_rgb(255_255_255/0.24),0_0_0_1px_var(--surface-muted),0_2px_4px_rgb(0_0_0/0.06),0_4px_16px_rgb(0_0_0/0.08)]",
                )}
                style={{ left: tipLeft, top: tipTop }}
              >
                <TooltipContent date={dateText(point.date, "tooltip")} rows={rows} money={money} counting />
              </div>
            )}
            {/* the same content with its final text, measured to place the tooltip (the visible amounts change width while they count) */}
            {point && (
              <span
                ref={sizerRef}
                aria-hidden
                className="pointer-events-none invisible absolute top-0 left-0 flex flex-col items-start gap-2 whitespace-nowrap"
              >
                <TooltipContent date={dateText(point.date, "tooltip")} rows={rows} money={money} />
              </span>
            )}
          </div>

          {/* each day's label centred under its bar */}
          <div aria-hidden className="relative h-3.5">
            {data.map((day, i) =>
              i % every === 0 ? (
                <span key={`${i}-${day.date}`} data-slot="financial-breakdown-chart-axis-label" className="absolute top-0" style={{ left: stacks[i]!.center }}>
                  <span className="block -translate-x-1/2 typo-label-02-regular whitespace-nowrap text-fg-soft">{labels[i]}</span>
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </ChartCard>
  )
}

export {
  FinancialBreakdownChart,
  sampleFinancialBreakdownData,
  sampleFinancialBreakdownSeries,
  type FinancialBreakdownChartProps,
  type FinancialBreakdownColor,
  type FinancialBreakdownPoint,
  type FinancialBreakdownSeries,
}
