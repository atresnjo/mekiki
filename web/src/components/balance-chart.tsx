"use client"

// mebius charts kit: charts-balance (https://www.mebius.design/freebies/charts/balance). changed here: `format`
// replaces the currency formatting, `good` says which way a change is good news (a shorter review time is), the eye
// toggle (masking amounts) is gone and the ⋯ button only shows with a handler

import { animate, stagger, svg, utils, type JSAnimation } from "animejs"
import * as React from "react"

import { ChartButton } from "@/components/ui/chart-button"
import { ChartCard } from "@/components/ui/chart-card"
import { BarLineChartIcon, ChevronDownIcon, DotsHorizontalIcon } from "@/components/ui/chart-icons"
import { ChartMenu, ChartMenuContent, ChartMenuRadioGroup, ChartMenuRadioItem, ChartMenuTrigger } from "@/components/ui/chart-menu"
import { ChartSwatch } from "@/components/ui/chart-swatch"
import { releaseStyles, useChartEntrance, useCountUp, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useChartSize } from "@/hooks/use-chart-size"
import { useControllableState } from "@/hooks/use-controllable-state"
import { formatCurrency, formatPercent } from "@/lib/chart-format"
import { alignPolylines, fittedDash, linePath, valueAt } from "@/lib/chart-series"
import { cn } from "@/lib/utils"

type BalanceMonth = {
  /** Axis label ("Jan"). */
  label: string
  value: number
}

/** One option of the year menu and everything the card shows for it. */
type BalanceYear = {
  value: string
  label: string
  /** The big number under the total's label. */
  total: number
  /** Change of the total against the period before, as an amount; none without a comparison. */
  change?: number
  /** Text after the change ("vs Last year"). */
  changeLabel?: string
  months: BalanceMonth[]
  /**
   * The month before the first one (last December). The line comes in from the left edge at this value and the first
   * month's change is measured against it; without it the line starts at the first month.
   */
  previous?: number
  /** The month selected when the card shows this year (index into `months`); the last month by default. */
  defaultMonth?: number
}

type BalanceChartProps = Omit<React.ComponentProps<"div">, "children"> & {
  title?: string
  /** The glyph in the purple tile (20px). */
  icon?: React.ReactNode
  /** The label over the total. */
  totalLabel?: string
  /** What the line measures, after the month's amount in the tooltip ("Income"). */
  valueLabel?: string
  /** Text after the month's change in the tooltip ("Last month"). */
  monthChangeLabel?: string
  years?: BalanceYear[]
  year?: string
  defaultYear?: string
  onYearChange?: (year: string) => void
  /** Called when a month is selected (click, or arrow keys on the chart), with its index in the year's months. */
  onMonthSelect?: (index: number, month: BalanceMonth) => void
  /** What the plot shows when the year has no months. */
  emptyText?: string
  /** Which way a change is good news, in green: "up" (the default) or "down". */
  good?: "up" | "down"
  /** Called by the ⋯ button (no button without it). */
  onMoreClick?: () => void
  /** Every amount on the card; currency in `locale` and `currency` by default. */
  format?: (value: number) => string
  locale?: string
  currency?: string
}

type Point = { x: number; y: number }

// Figma geometry ("Balance Chart" 1473:76186)
const PLOT_WIDTH = 480
const PLOT_HEIGHT = 180 // Figma's 260, smaller to fit the dashboard
const GRID_INSET = 24 // the first and last grid lines sit 24px in from the sides of the plot
const LINE_TOP = 40 // the highest point sits 40px under the top of the plot…
const LINE_BOTTOM = 105 // …and the lowest 105px under it, leaving room for the tooltip under the line
const COLUMN_WIDTH = 56 // the highlight column (narrower when the months are closer together)
const SPLIT_EDGE = 0.64 // the line turns light in a 0.64px gradient at the column's right edge
const TIP_GAP = 6 // between the column and the tooltip
const TIP_TOP = 12
const TIP_PADDING_X = 24 // the tooltip's 12px side padding, twice
const TIP_PADDING_Y = 16 // and its 8px top and bottom padding
const DRAW_AT = 350
const DRAW_DURATION = 1400
const GRID_DASH = fittedDash(PLOT_HEIGHT) // 4/4 fitted to the 260px line: 33 periods, half a dash at each end

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const monthly = (values: number[]) => values.map((value, i) => ({ label: MONTHS[i % 12]!, value }))

// 2025 is the Figma card: January to August with April selected. Its values put the line where Figma draws it.
const sampleBalanceYears: BalanceYear[] = [
  {
    value: "2025",
    label: "2025",
    total: 320418.16,
    change: -120.62,
    changeLabel: "vs Last year",
    months: monthly([92406.62, 100413.02, 92406.62, 98744.91, 93574.22, 103081.83, 114591.24, 121096.24]),
    previous: 87069.02,
    defaultMonth: 3,
  },
]

/** "+3.2s", "-1,204": an amount with its sign */
const signed = (format: (value: number) => string, value: number) => (value > 0 ? `+${format(value)}` : value < 0 ? `-${format(-value)}` : format(0))

/** green when the change goes the good way, red when not */
const toneOf = (value: number, good: "up" | "down") =>
  value === 0 ? "text-fg-soft" : value > 0 === (good === "up") ? "text-primary-green-500" : "text-error-500"

/**
 * Where everything sits for a year at a plot width. Each month has a grid line at x (the first and last 24px in);
 * Figma strokes those 1px lines over [x, x + 1], so a month's point sits on the line's centre, half a pixel right of
 * x. Values are scaled between LINE_TOP (highest) and LINE_BOTTOM (lowest), and the line comes in from the left edge
 * at the `previous` value when there is one.
 */
function layoutYear(year: BalanceYear | undefined, width: number) {
  const months = year?.months ?? []
  const n = months.length
  if (!n) return { n, step: width, xs: [] as number[], markers: [] as Point[], line: [] as Point[], columnWidth: COLUMN_WIDTH }
  const step = n > 1 ? (width - 2 * GRID_INSET) / (n - 1) : width
  const xs = months.map((_, i) => (n > 1 ? GRID_INSET + i * step : width / 2))
  const values = months.map((month) => month.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const y = (value: number) => (max > min ? LINE_BOTTOM - ((value - min) / (max - min)) * (LINE_BOTTOM - LINE_TOP) : (LINE_TOP + LINE_BOTTOM) / 2)
  const markers = months.map((month, i) => ({ x: xs[i]! + 0.5, y: y(month.value) }))
  const line = year?.previous !== undefined ? [{ x: 0, y: Math.min(Math.max(y(year.previous), 0), PLOT_HEIGHT) }, ...markers] : markers
  const columnWidth = n > 1 ? Math.max(8, Math.min(COLUMN_WIDTH, Math.round(step - 5))) : COLUMN_WIDTH
  return { n, step, xs, markers, line, columnWidth }
}

/**
 * The tooltip's top for a box over [left, right]: its Figma spot (12px down) when the line and its points stay under
 * the box there, else just under the line; back at 12px if neither fits.
 */
function tooltipTop(line: Point[], left: number, right: number, height: number) {
  if (!line.length) return TIP_TOP
  // the line is 2px wide and the points are 4px in radius
  const ends = [valueAt(line, left), valueAt(line, right)]
  const inside = line.filter((p) => p.x > left && p.x < right).map((p) => p.y)
  const highest = Math.min(...ends.map((y) => y - 1), ...inside.map((y) => y - 4))
  const lowest = Math.max(...ends.map((y) => y + 1), ...inside.map((y) => y + 4))
  if (highest >= TIP_TOP + height) return TIP_TOP
  const under = Math.round(lowest + 2 * TIP_GAP)
  return under + height <= PLOT_HEIGHT ? under : TIP_TOP
}

/** For each of `count` vertices from `offset` on, how far into an inOutSine draw of `line` (0–1) the stroke reaches it. */
function reachTimes(line: Point[], offset: number, count: number) {
  const lengths = [0]
  for (let i = 1; i < line.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y))
  const total = lengths[lengths.length - 1] || 1
  return Array.from({ length: count }, (_, i) => Math.acos(1 - 2 * Math.min(1, (lengths[i + offset] ?? total) / total)) / Math.PI)
}

/** The tooltip's two rows. Rendered twice: visible (its numbers count) and as an invisible copy that is measured. */
function TooltipRows({
  amount,
  valueLabel,
  change,
  tone,
  changeLabel,
  amountRef,
  changeRef,
}: {
  amount: string
  valueLabel?: string
  change?: string
  tone?: string
  changeLabel?: string
  amountRef?: React.Ref<HTMLSpanElement>
  changeRef?: React.Ref<HTMLSpanElement>
}) {
  return (
    <>
      <span className="flex items-center gap-1">
        <span ref={amountRef} data-slot={amountRef ? "balance-chart-amount" : undefined} className="hug-w typo-label-03-medium text-fg-loud">
          {amount}
        </span>
        {valueLabel && <span className="hug-w typo-label-02-regular text-fg-soft">{valueLabel}</span>}
      </span>
      {change !== undefined && (
        <span className="flex items-center gap-1">
          <span ref={changeRef} className={cn("typo-label-02-medium hug-w", tone)}>
            {change}
          </span>
          {changeLabel && <span className="hug-w typo-label-02-regular text-fg-soft">{changeLabel}</span>}
        </span>
      )}
    </>
  )
}

/**
 * "Balance Chart" from the Keitoto library: the period's total with its change against the one before, and a line
 * chart on a dashed grid. The selected point gets a purple column, its amount and change in a tooltip, and the line is
 * solid up to it and light after it. Hover scrubs through the points, click or the arrow keys select one; the menu
 * switches periods. Animated with anime.js: the grid draws down, the line draws itself with its points popping in as
 * it reaches them, then the column rises and the tooltip pops; a new point slides the column, the tooltip and the
 * solid part of the line over, and a new period morphs the line while every number counts to its new value.
 */
function BalanceChart({
  title = "Balance",
  icon = <BarLineChartIcon />,
  totalLabel = "Total Balance",
  valueLabel = "Income",
  monthChangeLabel = "Last month",
  years = sampleBalanceYears,
  year: yearProp,
  defaultYear,
  onYearChange,
  onMonthSelect,
  emptyText = "No data",
  good = "up",
  onMoreClick,
  format,
  locale = "en-US",
  currency = "USD",
  className,
  ...props
}: BalanceChartProps) {
  const [yearValue, setYear] = useControllableState({ value: yearProp, defaultValue: defaultYear ?? years[0]?.value ?? "", onChange: onYearChange })
  const year = years.find((y) => y.value === yearValue) ?? years[0]
  const months = React.useMemo(() => year?.months ?? [], [year])
  const [plotRef, plot] = useChartSize<HTMLDivElement>({ width: PLOT_WIDTH, height: PLOT_HEIGHT })
  const width = plot.width || PLOT_WIDTH
  const { n, step, xs, markers, line, columnWidth } = React.useMemo(() => layoutYear(year, width), [year, width])
  // Content keys: parents may pass a new `years` array on every render, so changes are detected by value.
  const dataKey = `${year?.value}:${year?.previous ?? ""}:${months.map((m) => `${m.label}=${m.value}`).join(";")}`
  const labelsKey = months.map((m) => m.label).join(";")

  const [picked, setPicked] = React.useState<Record<string, number>>({})
  const [hovered, setHovered] = React.useState<number | null>(null)
  const last = n - 1
  const selected = n ? Math.min(Math.max(picked[year?.value ?? ""] ?? year?.defaultMonth ?? last, 0), last) : -1
  const active = hovered !== null && hovered < n ? hovered : selected
  const activeMonth = months[active]
  const before = active > 0 ? months[active - 1]?.value : year?.previous
  const activeChange = activeMonth && before ? ((activeMonth.value - before) / Math.abs(before)) * 100 : undefined

  const money = React.useCallback((n: number) => (format ? format(n) : formatCurrency(n, { locale, currency })), [format, locale, currency])
  const signedMoney = React.useCallback((n: number) => signed(money, n), [money])
  const percent = React.useCallback((n: number) => formatPercent(n, { locale, signDisplay: "exceptZero", maximumFractionDigits: 1 }), [locale])

  // The tooltip sits right of the column, or left of it when it would run past the plot, and drops under the line
  // when the line runs where it would sit. Its size is measured on an invisible copy that holds the final text.
  const [sizerRef, sizer] = useChartSize<HTMLSpanElement>({ width: 131, height: 36 })
  const tipWidth = sizer.width + TIP_PADDING_X
  const tipHeight = sizer.height + TIP_PADDING_Y
  const colLeft = active >= 0 ? Math.round((xs[active] ?? 0) - columnWidth / 2) : 0
  const colRight = colLeft + columnWidth
  const split = active >= 0 ? colRight : 0
  const flipped = colRight + TIP_GAP + tipWidth > width
  const tipAnchor = flipped ? colLeft - TIP_GAP : colRight + TIP_GAP
  const tipLeft = flipped ? tipAnchor - tipWidth : tipAnchor
  const tipTop = tooltipTop(line, tipLeft, tipLeft + tipWidth, tipHeight)

  const reduced = useReducedMotion()
  const root = React.useRef<HTMLDivElement>(null)
  const totalRef = React.useRef<HTMLParagraphElement>(null)
  const changeRef = React.useRef<HTMLSpanElement>(null)
  const lineRef = React.useRef<SVGPathElement>(null)
  const stopsRef = React.useRef<SVGLinearGradientElement>(null)
  const columnRef = React.useRef<HTMLDivElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const tipAmountRef = React.useRef<HTMLSpanElement>(null)
  const tipChangeRef = React.useRef<HTMLSpanElement>(null)
  const ids = React.useId().replace(/[^\w-]/g, "")
  const totalText = money(year?.total ?? 0)
  const totalTextRef = React.useRef(totalText)
  useIsomorphicLayoutEffect(() => {
    totalTextRef.current = totalText
  })
  const all = (selector: string) => Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])

  // A new year or month counts the numbers from their previous values.
  useCountUp(totalRef, year?.total ?? 0, money, { duration: 900 })
  useCountUp(changeRef, year?.change ?? 0, signedMoney, { duration: 900 })
  useCountUp(tipAmountRef, activeMonth?.value ?? 0, money, { duration: 550 })
  useCountUp(tipChangeRef, activeChange ?? 0, percent, { duration: 550 })

  // Entrance, once the card is in view: the total counts up, the accent bar and the grid lines grow, the line draws
  // itself left to right and each point pops in as the stroke reaches it; then the column rises behind the selected
  // month and the tooltip pops in.
  useChartEntrance(root, (timeline) => {
    const total = totalRef.current
    const path = lineRef.current
    const counter = { n: 0 }
    const reach = reachTimes(line, line.length - markers.length, markers.length)
    const selectedAt = DRAW_AT + (reach[active] ?? 1) * DRAW_DURATION
    if (total) total.textContent = money(0)
    timeline
      .add(
        counter,
        {
          n: [0, year?.total ?? 0],
          duration: 1400,
          ease: "outExpo",
          onUpdate: () => {
            if (total) total.textContent = money(counter.n)
          },
        },
        0,
      )
      .add(all("[data-accent]"), { scaleY: { from: 0 }, duration: 900, ease: "outExpo" }, 0)
      .add(all('[data-slot="balance-chart-change"]'), { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad" }, 250)
      .add(all('[data-slot="balance-chart-grid-line"]'), { y2: { from: 0 }, duration: 800, ease: "outQuad", delay: stagger(45) }, 100)
      .add(
        all('[data-slot="balance-chart-axis-label"]'),
        { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad", delay: stagger(45) },
        250,
      )
    if (path) timeline.add(svg.createDrawable(path), { draw: ["0 0", "0 1"], duration: DRAW_DURATION, ease: "inOutSine" }, DRAW_AT)
    all('[data-slot="balance-chart-marker"]').forEach((marker, i) => {
      timeline.add(marker, { scale: { from: 0 }, duration: 500, ease: "outBack(2.2)" }, Math.max(0, DRAW_AT + (reach[i] ?? 1) * DRAW_DURATION - 100))
    })
    if (columnRef.current)
      timeline.add(
        columnRef.current,
        { clipPath: ["inset(100% 0% 0% 0%)", "inset(0% 0% 0% 0%)"], duration: 900, ease: "outExpo", onComplete: releaseStyles("clip-path") },
        selectedAt - 250,
      )
    if (tipRef.current)
      timeline.add(tipRef.current, { opacity: { from: 0 }, translateY: { from: 6 }, scale: { from: 0.94 }, duration: 500, ease: "outBack(1.6)" }, selectedAt)
    return () => {
      // createDrawable leaves its dash attributes (revert sets them to "hidden"): give the plain line back
      for (const attribute of ["pathLength", "stroke-dasharray", "stroke-dashoffset"]) path?.removeAttribute(attribute)
      if (total) total.textContent = totalTextRef.current
    }
  })

  // A new year morphs the line (both polylines resampled on the same x positions) and the points ride along it.
  const lastData = React.useRef({ key: dataKey, line, markers })
  const morph = React.useRef<JSAnimation | null>(null)
  useIsomorphicLayoutEffect(() => {
    const previous = lastData.current
    lastData.current = { key: dataKey, line, markers }
    const path = lineRef.current
    if (previous.key === dataKey || reduced || !path || !previous.line.length || !line.length) return
    const circles = all('[data-slot="balance-chart-marker"]')
    const { xs: at, from, to } = alignPolylines(previous.line, line)
    const start = markers.map((marker) => valueAt(previous.line, marker.x))
    const draw = (t: number) => {
      path.setAttribute("d", linePath(at.map((x, i) => ({ x, y: from[i]! + (to[i]! - from[i]!) * t }))))
      circles.forEach((circle, i) => {
        const marker = markers[i]
        if (marker) circle.setAttribute("cy", String(start[i]! + (marker.y - start[i]!) * t))
      })
    }
    morph.current?.cancel()
    const state = { t: 0 }
    draw(0)
    morph.current = animate(state, {
      t: 1,
      duration: 900,
      ease: "outExpo",
      onUpdate: () => draw(state.t),
      onComplete: () => {
        path.setAttribute("d", linePath(line))
        circles.forEach((circle, i) => {
          const marker = markers[i]
          if (marker) circle.setAttribute("cy", String(marker.y))
        })
      },
    })
  }, [dataKey, width, reduced])

  // A new month slides the column and the tooltip over (they fade in when the months were laid out again), and the
  // solid part of the line follows the column, turning the points it passes solid or light.
  const drawnSplit = React.useRef(split)
  const splitTween = React.useRef<JSAnimation | null>(null)
  const lastSelection = React.useRef({ active, n, width, colLeft, tipAnchor, tipTop, flipped })
  useIsomorphicLayoutEffect(() => {
    const previous = lastSelection.current
    lastSelection.current = { active, n, width, colLeft, tipAnchor, tipTop, flipped }
    const column = columnRef.current
    const tip = tipRef.current
    const gradient = stopsRef.current
    if (reduced || previous.width !== width || !gradient) {
      splitTween.current?.cancel()
      drawnSplit.current = split
      return
    }
    const same = previous.active === active && previous.n === n && previous.colLeft === colLeft && previous.flipped === flipped
    if (same && previous.tipAnchor === tipAnchor && previous.tipTop === tipTop) return
    const relaid = previous.n !== n
    if (column) {
      if (relaid) animate(column, { opacity: [0, 1], duration: 400, ease: "outQuad", onComplete: releaseStyles("opacity") })
      else
        animate(column, {
          translateX: [previous.colLeft - colLeft + (utils.get(column, "translateX", false) as number), 0],
          duration: 550,
          ease: "outExpo",
          onComplete: releaseStyles("transform"),
        })
    }
    if (tip) {
      if (relaid || previous.flipped !== flipped)
        animate(tip, { opacity: [0, 1], scale: [0.94, 1], duration: 300, ease: "outQuad", onComplete: releaseStyles("opacity", "transform") })
      else
        animate(tip, {
          translateX: [previous.tipAnchor - tipAnchor + (utils.get(tip, "translateX", false) as number), 0],
          translateY: [previous.tipTop - tipTop + (utils.get(tip, "translateY", false) as number), 0],
          duration: 550,
          ease: "outExpo",
          onComplete: releaseStyles("transform"),
        })
    }
    const [solid, light] = Array.from(gradient.querySelectorAll("stop"))
    const circles = all('[data-slot="balance-chart-marker"]')
    const state = { v: drawnSplit.current }
    const paint = () => {
      drawnSplit.current = state.v
      solid?.setAttribute("offset", String((state.v - SPLIT_EDGE) / width))
      light?.setAttribute("offset", String(state.v / width))
      circles.forEach((circle, i) => {
        const marker = markers[i]
        if (marker) circle.style.fill = marker.x <= state.v ? "var(--primary-purple-500)" : "var(--primary-purple-100)"
      })
    }
    splitTween.current?.cancel()
    paint()
    splitTween.current = animate(state, {
      v: split,
      duration: 550,
      ease: "outExpo",
      onUpdate: paint,
      onComplete: () => {
        for (const circle of circles) circle.style.removeProperty("fill")
      },
    })
  }, [active, n, width, colLeft, tipAnchor, tipTop, flipped, reduced])
  React.useEffect(
    () => () => {
      morph.current?.cancel()
      splitTween.current?.cancel()
    },
    [],
  )

  // New months (another year with other labels) fade the grid and the labels in again.
  const lastLabels = React.useRef(labelsKey)
  useIsomorphicLayoutEffect(() => {
    const previous = lastLabels.current
    lastLabels.current = labelsKey
    if (previous === labelsKey || reduced) return
    animate(all('[data-slot="balance-chart-axis-label"]'), {
      opacity: [0, 1],
      translateY: [4, 0],
      duration: 500,
      delay: stagger(35),
      ease: "outQuad",
      onComplete: releaseStyles("opacity", "transform"),
    })
    animate(all('[data-slot="balance-chart-grid-line"]'), {
      opacity: [0, 1],
      duration: 500,
      delay: stagger(35),
      ease: "outQuad",
      onComplete: releaseStyles("opacity"),
    })
  }, [labelsKey, reduced])

  const select = (index: number) => {
    const month = months[index]
    if (!year || !month) return
    setPicked((p) => ({ ...p, [year.value]: index }))
    onMonthSelect?.(index, month)
  }
  const onColumnKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: selected + 1,
      ArrowDown: selected + 1,
      ArrowLeft: selected - 1,
      ArrowUp: selected - 1,
      Home: 0,
      End: last,
    }
    const next = keys[event.key]
    if (next === undefined) return
    event.preventDefault()
    const index = Math.max(0, Math.min(last, next))
    select(index)
    root.current?.querySelectorAll<HTMLButtonElement>('[data-slot="balance-chart-column"]')[index]?.focus()
  }

  const change = year?.change
  const tooltip = activeMonth
    ? {
        amount: money(activeMonth.value),
        valueLabel,
        change: activeChange !== undefined ? percent(activeChange) : undefined,
        tone: activeChange !== undefined ? toneOf(activeChange, good) : undefined,
        changeLabel: monthChangeLabel,
      }
    : undefined

  return (
    <ChartCard ref={root} role="group" aria-label={title} className={cn("w-full", className)} {...props}>
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-primary-purple-50 text-primary-purple-500 shadow-[0_0_0_1px_var(--primary-purple-100)] [&_svg]:size-5">
            {icon}
          </span>
          <p className="truncate typo-body-04-semibold text-fg-loud">{title}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {years.length > 1 && (
            <ChartMenu>
              <ChartMenuTrigger asChild>
                <ChartButton aria-label={`Period: ${year?.label ?? ""}`} className="group/trigger text-fg-normal">
                  {year?.label ?? ""}
                  <ChevronDownIcon className="transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
                </ChartButton>
              </ChartMenuTrigger>
              <ChartMenuContent>
                <ChartMenuRadioGroup
                  value={year?.value}
                  onValueChange={(next) => {
                    setHovered(null)
                    setYear(next)
                  }}
                >
                  {years.map((y) => (
                    <ChartMenuRadioItem key={y.value} value={y.value}>
                      {y.label}
                    </ChartMenuRadioItem>
                  ))}
                </ChartMenuRadioGroup>
              </ChartMenuContent>
            </ChartMenu>
          )}
          {onMoreClick && (
            <ChartButton size="icon" aria-label="More options" onClick={onMoreClick}>
              <DotsHorizontalIcon />
            </ChartButton>
          )}
        </div>
      </div>

      <div className="flex items-start gap-3">
        <ChartSwatch data-accent="" className="h-12 w-1.5 origin-bottom bg-primary-purple-500" />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="hug-w typo-label-02-medium text-fg-soft">{totalLabel}</p>
          <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
            <p ref={totalRef} data-slot="balance-chart-amount" className="hug-w typo-heading-02-semibold whitespace-nowrap text-fg-loud">
              {totalText}
            </p>
            {change !== undefined && (
              <p data-slot="balance-chart-change" className="flex shrink-0 items-center gap-1 whitespace-nowrap">
                <span ref={changeRef} data-slot="balance-chart-amount" className={cn("typo-label-02-medium hug-w", toneOf(change, good))}>
                  {signedMoney(change)}
                </span>
                {year?.changeLabel && <span className="hug-w typo-label-02-regular text-fg-soft">{year.changeLabel}</span>}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div
          ref={plotRef}
          data-slot="balance-chart-plot"
          className="group/plot relative"
          style={{ height: PLOT_HEIGHT }}
          onPointerLeave={() => setHovered(null)}
        >
          {n === 0 && <p className="absolute inset-0 flex items-center justify-center typo-label-02-medium text-fg-soft">{emptyText}</p>}
          {/* Figma "Grid Line": 1px Border/Soft over [x, x + 1], dashed 4/4 */}
          <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
            {xs.map((x, i) => (
              <line
                key={i}
                data-slot="balance-chart-grid-line"
                x1={x + 0.5}
                x2={x + 0.5}
                y1={0}
                y2={PLOT_HEIGHT}
                className="stroke-border-soft"
                {...GRID_DASH}
              />
            ))}
          </svg>

          {active >= 0 && (
            // keyboard focus on the months rings the column (arrow keys select, so the focused month is the selected one)
            <div
              ref={columnRef}
              aria-hidden
              data-slot="balance-chart-highlight"
              className="pointer-events-none absolute inset-y-0 rounded-t-[6px] group-has-[[data-slot=balance-chart-column]:focus-visible]/plot:ring-2 group-has-[[data-slot=balance-chart-column]:focus-visible]/plot:ring-primary-purple-500/40"
              style={{ left: colLeft, width: columnWidth }}
            >
              {/* the selected month's grid line, drawn in #ad45ff under the column's fill */}
              <svg className="absolute inset-0 size-full overflow-visible">
                <line x1={(xs[active] ?? 0) + 0.5 - colLeft} x2={(xs[active] ?? 0) + 0.5 - colLeft} y1={0} y2={PLOT_HEIGHT} stroke="#ad45ff" {...GRID_DASH} />
              </svg>
              {/* Primary/Purple/purple-500 at 32% fading out toward the bottom, and a 1px inside stroke (top and sides) fading from 40% */}
              <div className="absolute inset-0 rounded-t-[6px] bg-linear-to-t/srgb from-primary-purple-500/0 to-primary-purple-500/32" />
              <div className="absolute inset-0 rounded-t-[6px] border border-b-0 border-transparent bg-linear-to-b/srgb from-primary-purple-500/40 to-primary-purple-500/0 bg-origin-border [mask:linear-gradient(#000_0_0)_padding-box_exclude,linear-gradient(#000_0_0)]" />
            </div>
          )}

          <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
            <defs>
              {/* solid up to the column's right edge, light after it */}
              <linearGradient ref={stopsRef} id={`${ids}-line`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={width} y2="0">
                <stop offset={(split - SPLIT_EDGE) / width} style={{ stopColor: "var(--primary-purple-500)" }} />
                <stop offset={split / width} style={{ stopColor: "var(--primary-purple-100)" }} />
              </linearGradient>
            </defs>
            <path ref={lineRef} data-slot="balance-chart-line" d={linePath(line)} fill="none" stroke={`url(#${ids}-line)`} strokeWidth={2} />
            {markers.map((marker, i) => (
              <circle
                key={i}
                data-slot="balance-chart-marker"
                cx={marker.x}
                cy={marker.y}
                r={3.5}
                strokeWidth={1}
                className={cn(
                  "origin-center stroke-surface-white [transform-box:fill-box]",
                  i <= active ? "fill-primary-purple-500" : "fill-primary-purple-100",
                )}
              />
            ))}
          </svg>

          <div role="group" aria-label={`${title} by ${year?.label ?? "period"}`}>
            {months.map((month, i) => (
              <button
                key={i}
                type="button"
                data-slot="balance-chart-column"
                aria-label={`${month.label}: ${money(month.value)}`}
                aria-pressed={i === selected}
                tabIndex={i === selected ? 0 : -1}
                onPointerEnter={() => setHovered(i)}
                onClick={() => select(i)}
                onKeyDown={onColumnKeyDown}
                className="absolute inset-y-0 cursor-pointer outline-none"
                style={n > 1 ? { left: (xs[i] ?? 0) - step / 2, width: step } : { left: 0, width }}
              />
            ))}
          </div>

          {tooltip && (
            <div
              ref={tipRef}
              aria-hidden
              data-slot="balance-chart-tooltip"
              className={cn(
                "pointer-events-none absolute flex flex-col gap-1.5 overflow-hidden rounded-xl bg-surface-white px-3 py-2 whitespace-nowrap",
                // Figma paints later effects on top; CSS paints the first shadow on top
                "shadow-[0_0_0_1px_var(--chart-ring),0_2px_4px_rgb(0_0_0/0.06),0_4px_16px_rgb(0_0_0/0.08)]",
                flipped && "-translate-x-full",
              )}
              style={{ top: tipTop, left: tipAnchor }}
            >
              <TooltipRows {...tooltip} amountRef={tipAmountRef} changeRef={tipChangeRef} />
            </div>
          )}
          {/* the same rows with their final text, measured to place the tooltip (the visible ones change width while they count) */}
          {tooltip && (
            <span ref={sizerRef} aria-hidden className="pointer-events-none invisible absolute top-0 left-0 flex flex-col gap-1.5 whitespace-nowrap">
              <TooltipRows {...tooltip} />
            </span>
          )}
        </div>

        <div aria-hidden className="relative h-3.5">
          {months.map((month, i) => (
            <span
              key={`${i}-${month.label}`}
              data-slot="balance-chart-axis-label"
              className={cn(
                "absolute top-0 -translate-x-1/2 whitespace-nowrap transition-colors duration-300",
                i === active ? "typo-label-02-medium text-primary-purple-500" : "typo-label-02-regular text-fg-soft",
              )}
              style={{ left: xs[i] }}
            >
              {month.label}
            </span>
          ))}
        </div>
      </div>
    </ChartCard>
  )
}

export { BalanceChart, sampleBalanceYears, type BalanceChartProps, type BalanceMonth, type BalanceYear }
