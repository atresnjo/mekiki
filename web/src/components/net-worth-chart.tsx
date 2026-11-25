"use client"

// mebius charts kit: charts-net-worth (https://www.mebius.design/freebies/charts/net-worth). changed here: `format` and
// `formatTick` replace the currency formatting (the overview counts reviews), and the info button only shows with a
// handler

import { animate, stagger, utils, type JSAnimation } from "animejs"
import * as React from "react"

import { ChartButton } from "@/components/ui/chart-button"
import { ChartCard } from "@/components/ui/chart-card"
import { ChartIconTile } from "@/components/ui/chart-icon-tile"
import { ArrowUpRightIcon, ChartBreakoutCircleIcon, InfoCircleLineIcon } from "@/components/ui/chart-icons"
import { ChartTooltipLines } from "@/components/ui/chart-tooltip-lines"
import { releaseStyles, useChartEntrance, useCountUp, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useChartSize } from "@/hooks/use-chart-size"
import { useControllableState } from "@/hooks/use-controllable-state"
import { formatCompactCurrency, formatCurrency, formatDay } from "@/lib/chart-format"
import { fittedDash, niceTicks } from "@/lib/chart-series"
import { cn } from "@/lib/utils"

type NetWorthPoint = {
  /** The day, as an ISO date ("2026-05-07"), or any text `formatDate` reads. */
  date: string
  value: number
}

type NetWorthChartProps = Omit<React.ComponentProps<"div">, "children"> & {
  title?: string
  /** The glyph in the green tile (16px, white). */
  icon?: React.ReactNode
  /** The big number under the title. */
  total?: number
  /** The label under the total, next to the info button. */
  totalLabel?: string
  /** One bar per day, oldest first; values below zero hang down from the zero line. */
  data?: NetWorthPoint[]
  /** The y-axis values, lowest first. Four round values from zero by default. */
  ticks?: number[]
  /** The selected day (an index into `data`). */
  index?: number
  defaultIndex?: number
  onIndexChange?: (index: number, point: NetWorthPoint) => void
  /** Text for a day on the x axis ("May 7") and in the tooltip ("Thu, May 7"). */
  formatDate?: (date: string, context: "axis" | "tooltip") => string
  /** The total and the tooltip's amount; currency in `locale` and `currency` by default. */
  format?: (value: number) => string
  /** The y axis' values; compact currency by default. */
  formatTick?: (value: number) => string
  /** The header button's text. */
  viewDataLabel?: string
  /** Called by the "View data" button. */
  onViewDataClick?: () => void
  /** Called by the info button after the total's label (no button without it). */
  onInfoClick?: () => void
  locale?: string
  currency?: string
}

type Bar = { x: number; center: number; top: number; bottom: number; negative: boolean }

// Figma geometry ("Net Worth Chart" 1473:77748)
const PLOT_WIDTH = 754
const PLOT_HEIGHT = 140 // Figma's 200, smaller to fit the dashboard
const GRID_TOP = 16 // Figma's 1px grid lines cover [y - 1, y]: the top one ends at 16…
const GRID_BOTTOM = PLOT_HEIGHT - 4 // …the axis 4px above the bottom
const BASE = GRID_BOTTOM - 1 // the lowest tick's value sits on the axis' top edge (the bars stand on it)…
const SPAN = GRID_BOTTOM - GRID_TOP // …and the highest one 180px above it, on the top line's top edge
const TICK_COUNT = 4
const BAR_WIDTH = 32
const BAR_RATIO = 32 / 60 // a bar takes 32 of every 60px, and narrows when the days come closer together
const BAR_RADIUS = 6
const BARS_END = 2 // the bars stop 2px short of the plot's right edge (752 of 754)
const COLUMN_PAD = 6 // the highlight column reaches 6px past its bar on each side, between the outer grid lines
const TIP_BOTTOM = 22 // the tooltip ends 22px above the axis
const TIP_PADDING_X = 24 // its 8px left and 16px right padding
const TIP_PADDING_Y = 16 // and 8px top and bottom
const LABEL_GAP = 8 // the least space between two x-axis labels
const LABEL_CHAR = 7.5 // about how wide a character of Label/02 is
const BARS_AT = 250
const BAR_STAGGER = 45
const GROW = 900
const MORPH = 700
const FLOW = 700
const DAY = 86_400_000
// Figma "Stripe Pattern": 4px white bands at 15%, 6px apart, turned 63.95° in a frame centred on each bar. The frame
// sits 405.999px left of the bar's centre and 99.0099px under its middle row (half the height, rounded up).
const STRIPE_ALONG = { x: 0.43911033868789673, y: -0.8984330296516418 }
const STRIPE_ACROSS = { x: 0.8984330296516418, y: 0.43911033868789673 }
const STRIPE_X = -405.9990234375
const STRIPE_Y = 99.0098876953125
const STRIPE_WIDTH = 4
const STRIPE_PERIOD = 6
// The Figma tile is a raw #11bb51 (not Primary/Green/green-500) with a ring in the same colour.
const TILE = "bg-[#11bb51] shadow-[inset_0_-2px_3px_rgb(0_0_0/0.08),0_0_0_1px_#11bb51,0_4px_4px_-3px_rgb(0_0_0/0.16),0_2px_4px_rgb(1_1_1/0.08)]"
const RING = "focus-visible:ring-primary-green-500/40" // the card's focus rings are green

/** One point per value on consecutive days from `start` (an ISO date). */
function daily(start: string, values: number[]): NetWorthPoint[] {
  const from = Date.parse(`${start}T00:00:00Z`)
  return values.map((value, i) => ({ date: new Date(from + i * DAY).toISOString().slice(0, 10), value }))
}

// The Figma card: 1 to 13 May 2026 with Thursday 7 May selected. The values stand the bars as tall as Figma draws them
// on the $0–$30K axis they produce (6px per $1K).
const sampleNetWorthData = daily(
  "2026-05-01",
  [2666.67, 3666.67, 8500, 13500, 19333.33, 16500, 25833.33, 23333.33, 17166.67, 2666.67, 3333.33, 4666.67, 11666.67],
)
const SAMPLE_SELECTED = 6

const round = (n: number) => Math.round(n * 1000) / 1000

/**
 * Where everything sits at a plot width. The y scale runs from the lowest tick on the axis (195) to the highest on
 * the top line (15); the bars stand on zero (or the axis end nearest to it) and are spread from the plot's left edge
 * to 2px short of its right one, 32px wide while there is room.
 */
function layoutChart(data: NetWorthPoint[], ticksProp: number[] | undefined, width: number) {
  const values = data.map((point) => point.value)
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  const ticks = ticksProp?.length ? [...ticksProp].sort((a, b) => a - b) : niceTicks(min, max > min ? max : min + 1, TICK_COUNT)
  const lo = ticks[0]!
  const hi = ticks[ticks.length - 1]!
  const y = (value: number) => (hi > lo ? BASE - ((value - lo) / (hi - lo)) * SPAN : BASE)
  const base = Math.min(Math.max(0, lo), hi)
  const zero = y(base)
  const n = data.length
  const room = Math.max(0, width - BARS_END)
  const barWidth = round(n > 1 ? Math.min(BAR_WIDTH, (BAR_RATIO * room) / (n - 1 + BAR_RATIO)) : Math.min(BAR_WIDTH, room))
  const pitch = n > 1 ? (room - barWidth) / (n - 1) : room
  const bars: Bar[] = data.map((point, i) => {
    const x = round(n > 1 ? i * pitch : (room - barWidth) / 2)
    const end = y(Math.min(Math.max(point.value, lo), hi))
    return { x, center: x + barWidth / 2, top: Math.min(zero, end), bottom: Math.max(zero, end), negative: point.value < 0 }
  })
  // a 1px line over [y, y + 1] under each tick's value: dashed, the zero line solid
  const grid = ticks.map((tick) => ({ tick, y: y(tick) + 0.5, solid: tick === base }))
  return { ticks, zero, barWidth, pitch, bars, grid }
}

/** A bar from `top` to `bottom` with its far end round (the top for values above zero, the bottom below). */
function barShape(x: number, width: number, top: number, bottom: number, negative: boolean) {
  const h = bottom - top
  if (h <= 0.01) return `M ${round(x)} ${round(top)} Z`
  const r = round(Math.min(BAR_RADIUS, h, width / 2))
  const [l, rt, t, b] = [x, x + width, top, bottom].map(round) as [number, number, number, number]
  return negative
    ? `M ${l} ${t} V ${round(b - r)} A ${r} ${r} 0 0 0 ${round(l + r)} ${b} H ${round(rt - r)} A ${r} ${r} 0 0 0 ${rt} ${round(b - r)} V ${t} Z`
    : `M ${l} ${b} V ${round(t + r)} A ${r} ${r} 0 0 1 ${round(l + r)} ${t} H ${round(rt - r)} A ${r} ${r} 0 0 1 ${rt} ${round(t + r)} V ${b} Z`
}

/**
 * The bar's stripes as parallelograms over its whole column (and a period more all round, so they can slide by one),
 * placed like Figma's pattern frame. The bar's shape clips them.
 */
function stripesPath(bar: Bar, barWidth: number) {
  const ox = bar.center + STRIPE_X
  const oy = bar.top + Math.ceil((bar.bottom - bar.top) / 2) + STRIPE_Y
  const box = [
    [bar.x - STRIPE_PERIOD, -STRIPE_PERIOD],
    [bar.x + barWidth + STRIPE_PERIOD, -STRIPE_PERIOD],
    [bar.x - STRIPE_PERIOD, PLOT_HEIGHT + STRIPE_PERIOD],
    [bar.x + barWidth + STRIPE_PERIOD, PLOT_HEIGHT + STRIPE_PERIOD],
  ] as const
  const along = box.map(([x, y]) => (x - ox) * STRIPE_ALONG.x + (y - oy) * STRIPE_ALONG.y)
  const across = box.map(([x, y]) => (x - ox) * STRIPE_ACROSS.x + (y - oy) * STRIPE_ACROSS.y)
  const [u0, u1] = [Math.min(...along), Math.max(...along)]
  const point = (u: number, v: number) => `${round(ox + u * STRIPE_ALONG.x + v * STRIPE_ACROSS.x)} ${round(oy + u * STRIPE_ALONG.y + v * STRIPE_ACROSS.y)}`
  let d = ""
  for (let k = Math.floor(Math.min(...across) / STRIPE_PERIOD); k * STRIPE_PERIOD <= Math.max(...across); k++) {
    const v0 = k * STRIPE_PERIOD
    const v1 = v0 + STRIPE_WIDTH
    d += `M ${point(u0, v0)} L ${point(u1, v0)} L ${point(u1, v1)} L ${point(u0, v1)} Z `
  }
  return d.trim()
}

/**
 * "Net Worth Chart" from the Keitoto library: the total under a green-tiled title with a "View data" button, and
 * hatched grey bars, one per day, on a dashed grid. The selected day turns green inside a pale green column, with its
 * date and amount in a dark tooltip over it. Hover previews a day, click or the arrow keys select one. Animated with
 * anime.js: the tile pops, the total counts up, the grid draws across, the bars grow from the axis one after another,
 * then the column rises behind the selected bar and the tooltip pops in; a new day slides the column and the tooltip
 * over while the amount counts and the bar's stripes flow, and new data morphs the bars.
 */
function NetWorthChart({
  title = "Net worth",
  icon = <ChartBreakoutCircleIcon />,
  total = 18645.16,
  totalLabel = "Total net worth",
  data: dataProp,
  ticks: ticksProp,
  index: indexProp,
  defaultIndex,
  onIndexChange,
  formatDate,
  format,
  formatTick,
  viewDataLabel = "View data",
  onViewDataClick,
  onInfoClick,
  locale = "en-US",
  currency = "USD",
  className,
  ...props
}: NetWorthChartProps) {
  const data = dataProp ?? sampleNetWorthData
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
  const [plotRef, plot] = useChartSize<HTMLDivElement>({ width: PLOT_WIDTH, height: PLOT_HEIGHT })
  const width = plot.width || PLOT_WIDTH
  const { ticks, zero, barWidth, pitch, bars, grid } = React.useMemo(() => layoutChart(data, ticksProp, width), [data, ticksProp, width])
  // Content keys: parents may pass new arrays on every render, so changes are detected by value.
  const shapeKey = `${barWidth}|${bars.map((bar) => `${bar.x},${bar.top},${bar.bottom},${+bar.negative}`).join(";")}`
  const ticksKey = ticks.join(";")

  const [hovered, setHovered] = React.useState<number | null>(null)
  const selected = n ? Math.min(Math.max(Math.round(indexValue), 0), n - 1) : -1
  const active = hovered !== null && hovered < n ? hovered : selected
  const point = data[active]
  const activeBar = bars[active]

  const money = React.useCallback((value: number) => (format ? format(value) : formatCurrency(value, { locale, currency })), [format, locale, currency])
  const tickText = (value: number) => (formatTick ? formatTick(value) : formatCompactCurrency(value, { locale, currency }))
  const dateText = (date: string, context: "axis" | "tooltip") =>
    formatDate
      ? formatDate(date, context)
      : formatDay(date, context === "axis" ? { month: "short", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" }, locale)
  const tooltip = point ? { date: dateText(point.date, "tooltip"), value: money(point.value) } : undefined

  // The tooltip is centred over the active bar (kept inside the plot) and ends 22px above the axis. Its size is
  // measured on an invisible copy that holds the final text.
  const [sizerRef, sizer] = useChartSize<HTMLSpanElement>({ width: 83, height: 38 })
  const tipWidth = sizer.width + TIP_PADDING_X
  const tipHeight = sizer.height + TIP_PADDING_Y
  const tipLeft = activeBar ? Math.min(Math.max(Math.floor(activeBar.center - tipWidth / 2), 0), Math.max(0, Math.floor(width - tipWidth))) : 0
  const tipTop = Math.max(0, BASE - TIP_BOTTOM - tipHeight)
  const columnX = activeBar ? activeBar.x - COLUMN_PAD : 0

  // The x axis names every day, or every second (third…) one when the days come too close for their labels.
  const labels = data.map((day) => dateText(day.date, "axis"))
  const longest = Math.max(0, ...labels.map((label) => label.length))
  const every = n > 1 && pitch > 0 ? Math.max(1, Math.ceil((longest * LABEL_CHAR + LABEL_GAP) / pitch)) : 1

  const reduced = useReducedMotion()
  const root = React.useRef<HTMLDivElement>(null)
  const totalRef = React.useRef<HTMLParagraphElement>(null)
  const columnRef = React.useRef<SVGRectElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const tipValueRef = React.useRef<HTMLSpanElement>(null)
  const ids = React.useId().replace(/[^\w-]/g, "")
  const totalText = money(total)
  const tipValue = point?.value ?? 0
  // what the entrance's callbacks need at play time (the card may be resized before it scrolls into view, or another
  // day hovered before its count-up is done)
  const latest = React.useRef({ bars, barWidth, zero, total, totalText, tipValue })
  useIsomorphicLayoutEffect(() => {
    latest.current = { bars, barWidth, zero, total, totalText, tipValue }
  })
  const all = (selector: string) => Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])
  const shapes = () => Array.from(root.current?.querySelectorAll<SVGPathElement>('[data-slot="net-worth-chart-bar-shape"]') ?? [])
  // How far the entrance has grown each bar (null without one), so a redraw before it is done (the card resized as its
  // font loads, new data) keeps the bars where the entrance has them.
  const growing = React.useRef<{ t: number }[] | null>(null)
  /** Draws bar i of the latest layout grown `t` of the way from zero. */
  const growBar = (path: SVGPathElement | undefined, i: number, t: number) => {
    const { bars, barWidth, zero } = latest.current
    const bar = bars[i]
    if (!bar || !path) return
    const end = zero + ((bar.negative ? bar.bottom : bar.top) - zero) * t
    path.setAttribute("d", barShape(bar.x, barWidth, Math.min(zero, end), Math.max(zero, end), bar.negative))
  }

  // New values count from the previous ones.
  useCountUp(totalRef, total, money, { duration: 900 })
  useCountUp(tipValueRef, tipValue, money, { duration: 550 })

  // Entrance, once the card is in view: the tile pops, the total counts up, the grid lines draw across and the axis
  // labels come in, the bars grow from the axis left to right, then the column rises behind the selected bar while its
  // stripes flow, and the tooltip pops in with its amount counting up.
  useChartEntrance(root, (timeline) => {
    const totalEl = totalRef.current
    const tipEl = tipValueRef.current
    const paths = shapes()
    const growth = paths.map(() => ({ t: 0 }))
    growing.current = growth
    const grow = (i: number) => growBar(paths[i], i, growth[i]?.t ?? 1)
    paths.forEach((_, i) => grow(i))
    // the total, and later the tooltip's amount, count up from zero
    const counter = { total: 0, tip: 0 }
    const count = () => {
      if (totalEl) totalEl.textContent = money(latest.current.total * counter.total)
      if (tipEl) tipEl.textContent = money(latest.current.tipValue * counter.tip)
    }
    count()
    const shownAt = BARS_AT + Math.max(0, active) * BAR_STAGGER + GROW * 0.45
    timeline
      .add(all('[data-slot="chart-icon-tile"]'), { scale: { from: 0.6 }, opacity: { from: 0 }, duration: 700, ease: "outBack(1.8)" }, 0)
      .add(counter, { total: [0, 1], duration: 1400, ease: "outExpo", onUpdate: count }, 0)
      .add(all('[data-slot="net-worth-chart-grid-line"]'), { x2: { from: 0 }, duration: 900, ease: "outQuad", delay: stagger(60) }, 100)
      .add(
        all('[data-slot="net-worth-chart-tick"]'),
        { opacity: { from: 0 }, translateX: { from: -4 }, duration: 600, ease: "outQuad", delay: stagger(45) },
        200,
      )
      .add(
        all('[data-slot="net-worth-chart-axis-label"] > span'),
        { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad", delay: stagger(35) },
        300,
      )
    growth.forEach((state, i) => timeline.add(state, { t: [0, 1], duration: GROW, ease: "outExpo", onUpdate: () => grow(i) }, BARS_AT + i * BAR_STAGGER))
    if (columnRef.current) timeline.add(columnRef.current, { scaleY: { from: 0 }, duration: 800, ease: "outExpo" }, shownAt)
    // the selected bar's stripes flow one period as its column rises (a period further they look the same)
    const stripes = all('[data-slot="net-worth-chart-stripes"]')[active]
    if (stripes)
      timeline.add(
        stripes,
        { translateX: { from: STRIPE_PERIOD * STRIPE_ACROSS.x }, translateY: { from: STRIPE_PERIOD * STRIPE_ACROSS.y }, duration: FLOW * 1.4, ease: "outExpo" },
        shownAt,
      )
    if (tipRef.current)
      timeline.add(tipRef.current, { opacity: { from: 0 }, translateY: { from: 6 }, scale: { from: 0.94 }, duration: 500, ease: "outBack(1.6)" }, shownAt + 250)
    if (tipEl) timeline.add(counter, { tip: [0, 1], duration: 900, ease: "outExpo", onUpdate: count }, shownAt + 250)
    return () => {
      if (growing.current === growth) growing.current = null
      growth.forEach((state, i) => {
        state.t = 1
        grow(i)
      })
      if (totalEl) totalEl.textContent = latest.current.totalText
      if (tipEl) tipEl.textContent = money(latest.current.tipValue)
    }
  })

  // New data (or a new axis) morphs every bar from the shape it has on screen. A resize redraws them at once, unless it
  // comes during a morph (new ticks can widen the axis labels): then the morph carries on to the new layout. While the
  // entrance runs, the bars are redrawn as far as it has grown them (it carries on with the new layout).
  const shown = React.useRef({ bars, barWidth })
  const lastShape = React.useRef({ key: shapeKey, width })
  const morph = React.useRef<JSAnimation | null>(null)
  useIsomorphicLayoutEffect(() => {
    const before = lastShape.current
    lastShape.current = { key: shapeKey, width }
    if (before.key === shapeKey) return
    const paths = shapes()
    const morphing = !!morph.current
    morph.current?.cancel()
    morph.current = null
    const target = { bars, barWidth }
    const entrance = growing.current
    if (entrance?.some((bar) => bar.t < 1)) {
      shown.current = target
      paths.forEach((path, i) => growBar(path, i, entrance[i]?.t ?? 1))
      return
    }
    const draw = (frame: typeof target) => {
      shown.current = frame
      frame.bars.forEach((bar, i) => paths[i]?.setAttribute("d", barShape(bar.x, frame.barWidth, bar.top, bar.bottom, bar.negative)))
    }
    if (reduced || (before.width !== width && !morphing)) {
      draw(target)
      return
    }
    const from = shown.current
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t
    const at = (t: number) => ({
      barWidth: lerp(from.barWidth, barWidth, t),
      bars: bars.map((bar, i) => {
        const start = from.bars[i] ?? { ...bar, top: zero, bottom: zero }
        return { ...bar, x: lerp(start.x, bar.x, t), top: lerp(start.top, bar.top, t), bottom: lerp(start.bottom, bar.bottom, t) }
      }),
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

  // A new day slides the column and the tooltip over (they fade in when the days were laid out again) and the newly
  // active bar's stripes flow up one period as it turns green.
  const lastSelection = React.useRef({ active, n, width, columnX, tipLeft, tipTop })
  useIsomorphicLayoutEffect(() => {
    const before = lastSelection.current
    lastSelection.current = { active, n, width, columnX, tipLeft, tipTop }
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
      if (relaid) animate(tip, { opacity: [0, 1], scale: [0.94, 1], duration: 300, ease: "outQuad", onComplete: releaseStyles("opacity", "transform") })
      else
        animate(tip, {
          translateX: [before.tipLeft - tipLeft + (utils.get(tip, "translateX", false) as number), 0],
          translateY: [before.tipTop - tipTop + (utils.get(tip, "translateY", false) as number), 0],
          duration: 550,
          ease: "outExpo",
          onComplete: releaseStyles("transform"),
        })
    }
    const stripes = all('[data-slot="net-worth-chart-stripes"]')[active]
    if (stripes && before.active !== active && !relaid)
      animate(stripes, {
        translateX: [STRIPE_PERIOD * STRIPE_ACROSS.x, 0],
        translateY: [STRIPE_PERIOD * STRIPE_ACROSS.y, 0],
        duration: FLOW,
        ease: "outExpo",
        onComplete: releaseStyles("transform"),
      })
  }, [active, n, width, columnX, tipLeft, tipTop, reduced])

  // New ticks fade their labels in again.
  const lastTicks = React.useRef(ticksKey)
  useIsomorphicLayoutEffect(() => {
    const before = lastTicks.current
    lastTicks.current = ticksKey
    if (before === ticksKey || reduced) return
    animate(all('[data-slot="net-worth-chart-tick"]'), {
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
    root.current?.querySelectorAll<HTMLButtonElement>('[data-slot="net-worth-chart-day"]')[index]?.focus()
  }

  const gridDash = fittedDash(width, 5, 5)

  return (
    <ChartCard ref={root} role="group" aria-label={title} className={cn("w-full", className)} {...props}>
      <div className="flex items-center justify-between gap-20">
        <div className="flex min-w-0 items-center gap-2">
          <ChartIconTile size={30} className={TILE}>
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

      <div className="flex flex-col gap-3">
        <p ref={totalRef} className="hug-w typo-heading-02-semibold whitespace-nowrap text-fg-loud">
          {totalText}
        </p>
        <div className="flex items-center gap-1">
          <p className="hug-w typo-label-03-medium whitespace-nowrap text-fg-normal">{totalLabel}</p>
          {onInfoClick && (
            <button
              type="button"
              aria-label={`About ${totalLabel.toLowerCase()}`}
              onClick={onInfoClick}
              className="relative size-4 shrink-0 cursor-pointer rounded-full text-icon-soft transition-colors duration-200 outline-none before:absolute before:-inset-2 hover:text-icon-normal focus-visible:ring-2 focus-visible:ring-primary-green-500/40"
            >
              <InfoCircleLineIcon />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3">
        {/* Figma "Y Axis Labels": 34px wide (wider labels widen it), spread from 8px down to the bottom, left-aligned */}
        <div aria-hidden className="flex hug-w min-w-[34px] shrink-0 flex-col justify-between pt-2" style={{ height: PLOT_HEIGHT }}>
          {[...ticks].reverse().map((tick) => (
            <span key={tick} data-slot="net-worth-chart-tick" className="typo-label-02-regular whitespace-nowrap text-fg-soft">
              {tickText(tick)}
            </span>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <div ref={plotRef} data-slot="net-worth-chart-plot" className="relative" style={{ height: PLOT_HEIGHT }} onPointerLeave={() => setHovered(null)}>
            <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
              <defs>
                {bars.map((bar, i) => (
                  <clipPath key={i} id={`${ids}-bar-${i}`}>
                    <path data-slot="net-worth-chart-bar-shape" d={barShape(bar.x, barWidth, bar.top, bar.bottom, bar.negative)} />
                  </clipPath>
                ))}
              </defs>
              {/* Figma "Grid Line": 1px Background/Soft over [y, y + 1] under each tick, dashed 5/5, the axis solid */}
              {grid.map((line) => (
                <line
                  key={line.tick}
                  data-slot="net-worth-chart-grid-line"
                  x1={0}
                  x2={width}
                  y1={line.y}
                  y2={line.y}
                  className="stroke-surface-soft"
                  {...(line.solid ? {} : gridDash)}
                />
              ))}
              {activeBar && (
                // the selected day's column: Primary/Green/green-500 at 12% between the outer grid lines
                <rect
                  ref={columnRef}
                  data-slot="net-worth-chart-column"
                  x={columnX}
                  y={GRID_TOP}
                  width={barWidth + 2 * COLUMN_PAD}
                  height={BASE - GRID_TOP}
                  className={cn(
                    "origin-bottom transition-[fill] duration-300 [transform-box:fill-box]",
                    activeBar.negative ? "fill-error-500/12" : "fill-primary-green-500/12",
                  )}
                />
              )}
              {bars.map((bar, i) => (
                <g key={i} data-slot="net-worth-chart-bar" clipPath={`url(#${ids}-bar-${i})`}>
                  {/* Background/Subdued, the active day green-500 (error-500 below zero), hatched with white stripes at 15% */}
                  <rect
                    x={bar.x}
                    y={0}
                    width={barWidth}
                    height={PLOT_HEIGHT}
                    className={cn(
                      "transition-[fill] duration-300",
                      i !== active ? "fill-surface-subdued" : bar.negative ? "fill-error-500" : "fill-primary-green-500",
                    )}
                  />
                  <path data-slot="net-worth-chart-stripes" d={stripesPath(bar, barWidth)} fill="#fff" fillOpacity={0.15} />
                </g>
              ))}
            </svg>

            <div role="group" aria-label={`${title} by day`}>
              {data.map((day, i) => {
                const bar = bars[i]!
                const left = n > 1 ? Math.max(0, bar.center - pitch / 2) : 0
                const right = n > 1 ? Math.min(width, bar.center + pitch / 2) : width
                return (
                  <button
                    key={i}
                    type="button"
                    data-slot="net-worth-chart-day"
                    aria-label={`${dateText(day.date, "tooltip")}: ${money(day.value)}`}
                    aria-pressed={i === selected}
                    tabIndex={i === selected ? 0 : -1}
                    onPointerEnter={() => setHovered(i)}
                    onClick={() => select(i)}
                    onKeyDown={onDayKeyDown}
                    className="absolute inset-y-0 cursor-pointer rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-green-500/40"
                    style={{ left, width: right - left }}
                  />
                )
              })}
            </div>

            {tooltip && (
              <div
                ref={tipRef}
                aria-hidden
                data-slot="net-worth-chart-tooltip"
                className={cn(
                  "pointer-events-none absolute flex flex-col items-start gap-2 overflow-hidden rounded-[10px] bg-surface-loud py-2 pr-4 pl-2 whitespace-nowrap",
                  // Figma paints later effects on top; CSS paints the first shadow on top
                  "shadow-[inset_0_2px_8px_rgb(255_255_255/0.24),0_0_0_1px_var(--surface-muted),0_2px_4px_rgb(0_0_0/0.06),0_4px_16px_rgb(0_0_0/0.08)]",
                )}
                style={{ left: tipLeft, top: tipTop }}
              >
                <ChartTooltipLines label={tooltip.date} value={tooltip.value} valueRef={tipValueRef} />
              </div>
            )}
            {/* the same lines with their final text, measured to place the tooltip (the visible ones change width while they count) */}
            {tooltip && (
              <span
                ref={sizerRef}
                aria-hidden
                className="pointer-events-none invisible absolute top-0 left-0 flex flex-col items-start gap-2 whitespace-nowrap"
              >
                <ChartTooltipLines label={tooltip.date} value={tooltip.value} />
              </span>
            )}
          </div>

          {/* each day's label centred under its bar */}
          <div aria-hidden className="relative h-3.5">
            {data.map((day, i) =>
              i % every === 0 ? (
                <span key={`${i}-${day.date}`} data-slot="net-worth-chart-axis-label" className="absolute top-0" style={{ left: bars[i]!.center }}>
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

export { NetWorthChart, sampleNetWorthData, type NetWorthChartProps, type NetWorthPoint }
