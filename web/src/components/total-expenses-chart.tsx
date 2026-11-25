"use client"

// mebius charts kit: charts-total-expenses (https://www.mebius.design/freebies/charts/total-expenses). changed here:
// `format` and `formatParts` replace the currency formatting (the overview shows a rate), `max` pins the top of the
// line's scale, changes are optional and say which way is good news, and the ⋯ button only shows with a handler

import { animate, stagger, svg, type JSAnimation } from "animejs"
import * as React from "react"

import { ChartCard } from "@/components/ui/chart-card"
import { ChevronDownIcon, CreditCardUpIcon, DotsHorizontalIcon } from "@/components/ui/chart-icons"
import { ChartMenu, ChartMenuContent, ChartMenuRadioGroup, ChartMenuRadioItem, ChartMenuTrigger } from "@/components/ui/chart-menu"
import { ChartSwatch } from "@/components/ui/chart-swatch"
import { ChartTrend } from "@/components/ui/chart-trend"
import { useChartEntrance, useCountUp, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useChartSize } from "@/hooks/use-chart-size"
import { useControllableState } from "@/hooks/use-controllable-state"
import { formatCurrency, formatCurrencyParts } from "@/lib/chart-format"
import { alignPolylines, areaPath, linePath, seriesToPixels } from "@/lib/chart-series"
import { cn } from "@/lib/utils"

type TotalExpensesColor = "blue" | "orange" | "purple" | "green" | "yellow" | "red"

type TotalExpensesCategory = {
  id: string
  label: string
  amount: number
  /** Change in percent ("4.82" → ↗ 4.82%); none without a comparison. */
  change?: number
  /** Text after the change ("this month"). */
  changeLabel?: string
  /** Which way the change is good news, in green (up by default). */
  good?: "up" | "down" | "none"
  color?: TotalExpensesColor
}

type TotalExpensesPoint = {
  /** Position along the period, 0 (start) to 1 (end). */
  x: number
  value: number
  /** Shown in the hover pill; defaults to the axis label under the point. */
  label?: string
}

/** One option of the period menu and everything the card shows for it. */
type TotalExpensesPeriod = {
  value: string
  label: string
  total: number
  /** Change of the total in percent, with its label ("Today"); none without a comparison. */
  change?: number
  changeLabel?: string
  categories: TotalExpensesCategory[]
  points: TotalExpensesPoint[]
  /** Labels spread evenly under the chart ("SUN" … "SAT"). */
  axis: string[]
}

/** The total drawn as a number with a smaller symbol before or after it ("$" + "320,418.16", "87.5" + "%"). */
type TotalParts = { symbol: string; number: string; symbolFirst: boolean }

type TotalExpensesChartProps = Omit<React.ComponentProps<"div">, "children"> & {
  title?: string
  /** The small line above the title. */
  eyebrow?: string
  /** The glyph in the blue tile (20px, white). */
  icon?: React.ReactNode
  periods?: TotalExpensesPeriod[]
  period?: string
  defaultPeriod?: string
  onPeriodChange?: (period: string) => void
  /** Which way the total's change is good news, in green (up by default). */
  good?: "up" | "down"
  /** The value at the top of the plot; the highest point by default. */
  max?: number
  /** Called by the ⋯ button (no button without it). */
  onMoreClick?: () => void
  /** The categories' amounts and the hover pill's value; currency in `locale` and `currency` by default. */
  format?: (value: number) => string
  /** The line's values, in the hover pill; `format` by default. */
  formatPoint?: (value: number) => string
  /** The total, split into its number and symbol; currency in `locale` and `currency` by default. */
  formatParts?: (value: number) => TotalParts
  locale?: string
  currency?: string
}

// Figma geometry ("Total Expenses Chart" 1473:84261)
const PLOT_WIDTH = 480
const PLOT_HEIGHT = 110 // Figma's 163, smaller to fit the dashboard
const AREA_OFFSET = 1.5 // the area fill starts 1.5px under the line

const swatches: Record<TotalExpensesColor, string> = {
  blue: "bg-primary-blue-500",
  orange: "bg-primary-orange-500",
  purple: "bg-primary-purple-500",
  green: "bg-primary-green-500",
  yellow: "bg-primary-yellow-500",
  red: "bg-error-500",
}

// The Monthly sample is the Figma line: x positions as drawn (on a 437 grid scaled to 480), values on a 0–1,630 scale.
const sampleTotalExpensesPeriods: TotalExpensesPeriod[] = [
  {
    value: "monthly",
    label: "Monthly",
    total: 320418.16,
    change: 1.16,
    changeLabel: "Today",
    categories: [
      { id: "shopping", label: "Shopping", amount: 4250, change: 4.82, changeLabel: "this month", color: "blue" },
      { id: "subscriptions", label: "Subscriptions", amount: 846.85, change: 2.64, changeLabel: "this month", color: "orange" },
      { id: "investment", label: "Investment", amount: 2753.04, change: -1.64, changeLabel: "this month", color: "purple" },
    ],
    points: (
      [
        [0, 925],
        [45.5, 1140],
        [84, 1025],
        [123.5, 1065],
        [187, 965],
        [226, 1065],
        [257, 1235],
        [309, 1160],
        [356, 1290],
        [402, 1455],
        [437, 1630],
      ] as const
    ).map(([x, value]) => ({ x: x / 437, value })),
    axis: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
  },
]

/** The hover pill's label: the point's own, else the axis label of the column it falls in. */
function pointLabel(period: TotalExpensesPeriod, index: number) {
  const point = period.points[index]
  if (point?.label) return point.label
  const n = period.axis.length
  return n ? (period.axis[Math.min(n - 1, Math.floor((point?.x ?? 0) * n))] ?? "") : ""
}

function CategoryRow({ category, money, locale }: { category: TotalExpensesCategory; money: (n: number) => string; locale: string }) {
  const amountRef = React.useRef<HTMLParagraphElement>(null)
  useCountUp(amountRef, category.amount, money)
  return (
    <div data-slot="total-expenses-chart-category" className="flex items-center gap-6">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ChartSwatch className={swatches[category.color ?? "blue"]} />
        <p className="-my-0.5 truncate py-0.5 typo-label-03-medium text-fg-normal">{category.label}</p>
      </div>
      <div className="flex items-center justify-end gap-6">
        <p ref={amountRef} className="min-w-12 text-right typo-label-03-semibold whitespace-nowrap text-fg-loud">
          {money(category.amount)}
        </p>
        <span className="flex w-[124px] justify-start">
          {category.change !== undefined ? (
            <ChartTrend value={category.change} label={category.changeLabel} good={category.good} fractionDigits={0} locale={locale} />
          ) : (
            <span className="typo-label-02-regular text-fg-soft">{category.changeLabel}</span>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * "Total Expenses Chart" from the Keitoto library: a glowing card with the period's total and its change, a legend of
 * categories with their amounts and trends, and a line chart with a soft area under it. The period menu swaps the
 * data; hover or arrow keys show a point's value. Animated with anime.js: the glow fades in, the total counts up and
 * the line draws itself when the card scrolls into view; a new period morphs the line and counts every number to its
 * new value.
 */
function TotalExpensesChart({
  title = "Total Expenses",
  eyebrow = "Spending",
  icon = <CreditCardUpIcon />,
  periods = sampleTotalExpensesPeriods,
  period: periodProp,
  defaultPeriod,
  onPeriodChange,
  good = "up",
  max,
  onMoreClick,
  format,
  formatPoint,
  formatParts,
  locale = "en-US",
  currency = "USD",
  className,
  ...props
}: TotalExpensesChartProps) {
  const [periodValue, setPeriod] = useControllableState({
    value: periodProp,
    defaultValue: defaultPeriod ?? periods.find((p) => p.value === "monthly")?.value ?? periods[0]?.value ?? "",
    onChange: onPeriodChange,
  })
  const period = periods.find((p) => p.value === periodValue) ?? periods[0]
  const [plotRef, plot] = useChartSize<HTMLDivElement>({ width: PLOT_WIDTH, height: PLOT_HEIGHT })
  const width = plot.width || PLOT_WIDTH
  const points = React.useMemo(() => seriesToPixels(period?.points ?? [], width, PLOT_HEIGHT, max), [period, width, max])
  const line = linePath(points)
  const area = areaPath(points, PLOT_HEIGHT, AREA_OFFSET)
  const dataKey = `${period?.value}:${(period?.points ?? []).map((p) => `${p.x},${p.value}`).join(";")}`

  const money = React.useCallback((n: number) => (format ? format(n) : formatCurrency(n, { locale, currency })), [format, locale, currency])
  const pointText = formatPoint ?? money
  const partsOf = React.useCallback(
    (n: number) => (formatParts ? formatParts(n) : formatCurrencyParts(n, { locale, currency })),
    [formatParts, locale, currency],
  )
  const totalNumber = React.useCallback((n: number) => partsOf(n).number, [partsOf])
  const parts = partsOf(period?.total ?? 0)

  const [active, setActive] = React.useState<number | null>(null)
  const activePoint = active !== null ? points[active] : undefined
  const reduced = useReducedMotion()

  const root = React.useRef<HTMLDivElement>(null)
  const totalRef = React.useRef<HTMLParagraphElement>(null)
  const lineRef = React.useRef<SVGPathElement>(null)
  const areaRef = React.useRef<SVGPathElement>(null)
  const markerRef = React.useRef<HTMLDivElement>(null)
  const guideRef = React.useRef<HTMLDivElement>(null)
  const tipRef = React.useRef<HTMLDivElement>(null)
  const totalTextRef = React.useRef(parts.number)
  const ids = React.useId().replace(/[^\w-]/g, "")
  useIsomorphicLayoutEffect(() => {
    totalTextRef.current = parts.number
  })
  const all = (selector: string) => Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])

  useCountUp(totalRef, period?.total ?? 0, totalNumber, { duration: 900 })

  // Entrance, once the card is in view: the glow fades in, the total counts up, the categories rise in, the divider
  // opens from the middle and the line draws itself left to right with its area wiping in under it.
  useChartEntrance(root, (timeline) => {
    const total = totalRef.current
    const path = lineRef.current
    const counter = { n: 0 }
    if (total) total.textContent = totalNumber(0)
    timeline
      .add(all('[data-slot="total-expenses-chart-glow"] > *'), { opacity: { from: 0 }, duration: 1400, ease: "outQuad" }, 0)
      .add(
        counter,
        {
          n: [0, period?.total ?? 0],
          duration: 1400,
          ease: "outExpo",
          onUpdate: () => {
            if (total) total.textContent = totalNumber(counter.n)
          },
        },
        0,
      )
      .add(all("[data-total-change]"), { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad" }, 200)
      .add(
        all('[data-slot="total-expenses-chart-category"]'),
        { opacity: { from: 0 }, translateY: { from: 8 }, duration: 700, ease: "outExpo", delay: stagger(90) },
        200,
      )
      .add(all('[data-slot="total-expenses-chart-divider"]'), { scaleX: { from: 0 }, duration: 900, ease: "outExpo" }, 350)
      .add(
        all('[data-slot="total-expenses-chart-axis-label"]'),
        { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad", delay: stagger(50) },
        500,
      )
    if (path && points.length) timeline.add(svg.createDrawable(path), { draw: ["0 0", "0 1"], duration: 1300, ease: "inOutCubic" }, 450)
    if (areaRef.current) timeline.add(areaRef.current, { clipPath: ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"], duration: 1300, ease: "inOutCubic" }, 450)
    return () => {
      // createDrawable leaves its dash attributes (revert sets them to "hidden"): give the plain line back
      for (const attribute of ["pathLength", "stroke-dasharray", "stroke-dashoffset"]) path?.removeAttribute(attribute)
      if (total) total.textContent = totalTextRef.current
    }
  })

  // A new period morphs the line and area: both polylines are resampled on the same x positions and y is tweened.
  const lastData = React.useRef({ key: dataKey, points })
  const morph = React.useRef<JSAnimation | null>(null)
  useIsomorphicLayoutEffect(() => {
    const previous = lastData.current
    lastData.current = { key: dataKey, points }
    const lineEl = lineRef.current
    const areaEl = areaRef.current
    if (previous.key === dataKey || reduced || !lineEl || !areaEl || !previous.points.length || !points.length) return
    const { xs, from, to } = alignPolylines(previous.points, points)
    const draw = (t: number) => {
      const frame = xs.map((x, i) => ({ x, y: from[i]! + (to[i]! - from[i]!) * t }))
      lineEl.setAttribute("d", linePath(frame))
      areaEl.setAttribute("d", areaPath(frame, PLOT_HEIGHT, AREA_OFFSET))
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
        lineEl.setAttribute("d", linePath(points))
        areaEl.setAttribute("d", areaPath(points, PLOT_HEIGHT, AREA_OFFSET))
      },
    })
  }, [dataKey, width, reduced])
  React.useEffect(
    () => () => {
      morph.current?.cancel()
    },
    [],
  )

  // Hover marker: the crosshair, the dot and the pill glide to the active point; they fade in and out.
  const shown = React.useRef(false)
  useIsomorphicLayoutEffect(() => {
    const marker = markerRef.current
    const guide = guideRef.current
    const tip = tipRef.current
    if (!marker || !guide || !tip) return
    const visible = [marker, guide, tip]
    if (!activePoint) {
      if (shown.current) animate(visible, { opacity: 0, duration: reduced ? 0 : 200, ease: "outQuad" })
      shown.current = false
      return
    }
    // keep the pill inside the plot (the card clips anything past its padding)
    const half = tip.offsetWidth / 2
    const tipX = Math.min(Math.max(activePoint.x, half - 8), width - half + 8)
    const tipY = activePoint.y - 14
    const duration = reduced || !shown.current ? 0 : 350
    animate(marker, { x: activePoint.x, y: activePoint.y, duration, ease: "outExpo" })
    animate(guide, { x: activePoint.x, duration, ease: "outExpo" })
    animate(tip, { x: tipX, y: tipY, duration, ease: "outExpo" })
    if (!shown.current) animate(visible, { opacity: [0, 1], duration: reduced ? 0 : 200, ease: "outQuad" })
    shown.current = true
  }, [activePoint?.x, activePoint?.y, active, width, reduced])

  // Pointer positions in the plot's own pixels (the live demo may scale the card with CSS zoom): the nearest point.
  const pickAt = (event: React.PointerEvent<HTMLElement>) => {
    if (!points.length) return
    const target = event.currentTarget
    const box = target.getBoundingClientRect()
    const zoom = box.width / (target.offsetWidth || box.width || 1) || 1
    const x = (event.clientX - box.left) / zoom
    let best = 0
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.x - x) < Math.abs(points[best]!.x - x)) best = i
    setActive(best)
  }
  const onPlotKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const last = points.length - 1
    const current = active ?? last
    const keys: Record<string, number> = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: last }
    const next = keys[event.key]
    if (event.key === "Escape") setActive(null)
    if (next === undefined || last < 0) return
    event.preventDefault()
    setActive(Math.max(0, Math.min(last, next)))
  }

  const activeValue = active !== null ? period?.points[active]?.value : undefined
  const announce = active !== null && period && activeValue !== undefined ? `${pointLabel(period, active)}: ${pointText(activeValue)}` : ""

  return (
    <ChartCard ref={root} role="group" aria-label={title} className={cn("w-full", className)} {...props}>
      {/* Figma: two ellipses with "layer blur 200", which Chrome matches with blur(90px) (fitted against the Figma render) */}
      <div aria-hidden data-slot="total-expenses-chart-glow" className="pointer-events-none absolute inset-0">
        <div className="absolute top-[-130px] left-1/2 h-[154px] w-[836px] -translate-x-1/2 rounded-[50%] bg-[#4a6af6]/60 blur-[90px]" />
        <div className="absolute top-[-75px] left-[calc(50%+9.5px)] h-20 w-[589px] -translate-x-1/2 rounded-[50%] bg-primary-blue-500 mix-blend-darken blur-[90px]" />
      </div>

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {/* Figma: Primary/Blue/blue-500 at 32% with the Glass effect; its rim is a 30% white inner line */}
          <span className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary-blue-500/32 text-fg-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.3)] [&_svg]:size-5">
            {icon}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <p className="typo-label-02-regular whitespace-nowrap text-fg-normal">{eyebrow}</p>
            <p className="typo-label-04-semibold whitespace-nowrap text-fg-loud">{title}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {periods.length > 1 && (
            <ChartMenu>
              <ChartMenuTrigger className="group/trigger flex cursor-pointer items-center gap-1.5 rounded-xl bg-surface-white/24 p-2.5 typo-label-03-medium whitespace-nowrap text-fg-normal shadow-[inset_0_0_0_1px_rgb(255_255_255/0.7)] transition-colors duration-200 outline-none hover:bg-surface-white/40 focus-visible:ring-2 focus-visible:ring-primary-blue-500/40 data-[state=open]:bg-surface-white/40">
                <span className="hug-w">{period?.label}</span>
                <ChevronDownIcon className="size-4 text-fg-soft transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
              </ChartMenuTrigger>
              <ChartMenuContent>
                <ChartMenuRadioGroup
                  value={period?.value}
                  onValueChange={(next) => {
                    setActive(null)
                    setPeriod(next)
                  }}
                >
                  {periods.map((p) => (
                    <ChartMenuRadioItem key={p.value} value={p.value}>
                      {p.label}
                    </ChartMenuRadioItem>
                  ))}
                </ChartMenuRadioGroup>
              </ChartMenuContent>
            </ChartMenu>
          )}
          {onMoreClick && (
            <button
              type="button"
              aria-label="More options"
              onClick={onMoreClick}
              className="flex size-9 cursor-pointer items-center justify-center rounded-xl bg-surface-white/24 text-fg-soft shadow-[inset_0_0_0_1px_rgb(255_255_255/0.7)] transition-colors duration-200 outline-none hover:bg-surface-white/40 focus-visible:ring-2 focus-visible:ring-primary-blue-500/40"
            >
              <DotsHorizontalIcon className="size-4" />
            </button>
          )}
        </div>
      </div>

      <div className="relative flex flex-wrap items-end gap-4">
        <div className={cn("flex min-w-0 flex-1 items-start gap-0.5", !parts.symbolFirst && "flex-row-reverse justify-end")}>
          {/* the symbol's text box is 22px tall, which sits the smaller glyph level with the number's cap height */}
          <p className="hug-w typo-label-04-semibold leading-[22px] whitespace-nowrap text-fg-soft">{parts.symbol}</p>
          <p ref={totalRef} className="hug-w typo-heading-03-semibold whitespace-nowrap text-fg-loud">
            {parts.number}
          </p>
        </div>
        {period?.change !== undefined && <ChartTrend data-total-change="" value={period.change} label={period.changeLabel} good={good} locale={locale} />}
      </div>

      <div className="relative flex flex-col gap-3">
        {period?.categories.map((category) => (
          <CategoryRow key={category.id} category={category} money={money} locale={locale} />
        ))}
      </div>

      {/* Figma "Divider": a 1px line dashed 4/4, the ring colour fading out at both ends */}
      <div aria-hidden className="relative h-0">
        <svg data-slot="total-expenses-chart-divider" className="absolute inset-x-0 -top-px h-px w-full overflow-visible">
          <defs>
            <linearGradient id={`${ids}-divider`} gradientUnits="userSpaceOnUse" x1="0" x2="100%" y1="0" y2="0">
              <stop offset="0" style={{ stopColor: "var(--chart-ring)", stopOpacity: 0 }} />
              <stop offset="0.2548" style={{ stopColor: "var(--chart-ring)" }} />
              <stop offset="0.7692" style={{ stopColor: "var(--chart-ring)" }} />
              <stop offset="1" style={{ stopColor: "var(--chart-ring)", stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <line x1="0" x2="100%" y1="0.5" y2="0.5" stroke={`url(#${ids}-divider)`} strokeDasharray="4 4" strokeDashoffset={2} />
        </svg>
      </div>

      <div className="relative flex flex-col gap-2">
        <div className="pt-2 pb-0.5">
          <div
            ref={plotRef}
            data-slot="total-expenses-chart-plot"
            role="group"
            tabIndex={0}
            aria-label={`${title}, ${period?.label ?? ""}: use the arrow keys to read the values`}
            onPointerMove={pickAt}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onPlotKeyDown}
            onBlur={() => setActive(null)}
            className="relative rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary-blue-500/40"
            style={{ height: PLOT_HEIGHT }}
          >
            <svg aria-hidden className="absolute inset-0 size-full overflow-visible">
              <defs>
                <linearGradient id={`${ids}-area`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" style={{ stopColor: "var(--primary-blue-500)", stopOpacity: 0.18 }} />
                  <stop offset="1" style={{ stopColor: "var(--primary-blue-500)", stopOpacity: 0 }} />
                </linearGradient>
              </defs>
              <path ref={areaRef} data-slot="total-expenses-chart-area" d={area} fill={`url(#${ids}-area)`} />
              <path ref={lineRef} data-slot="total-expenses-chart-line" d={line} fill="none" className="stroke-primary-blue-500" strokeWidth={2} />
              {/* a single point has no line to draw: a dot shows it */}
              {points.length === 1 && <circle cx={points[0]!.x} cy={points[0]!.y} r={3.5} className="fill-primary-blue-500" />}
            </svg>
            {/* hover crosshair, dot and value pill (not drawn in Figma; Keitoto's dashed line and pill in the series blue) */}
            <div
              ref={guideRef}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 h-full w-px -translate-x-1/2 bg-[repeating-linear-gradient(to_bottom,var(--primary-blue-500)_0_4px,transparent_4px_8px)] opacity-0"
            />
            <div
              ref={markerRef}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 -mt-1.5 -ml-1.5 size-3 rounded-full border-2 border-primary-blue-500 bg-surface-white opacity-0 shadow-[0_2px_6px_rgb(9_125_246/0.35)]"
            />
            <div
              ref={tipRef}
              aria-hidden
              className="pointer-events-none absolute top-0 left-0 flex -translate-x-1/2 -translate-y-full gap-px typo-label-02-medium whitespace-nowrap text-fg-white opacity-0"
            >
              <span className="hug-w rounded-l-xl bg-primary-blue-500 px-1.5 py-1">{active !== null && period ? pointLabel(period, active) : ""}</span>
              <span className="hug-w rounded-r-xl bg-primary-blue-500 px-1.5 py-1">{activeValue !== undefined ? pointText(activeValue) : ""}</span>
            </div>
          </div>
        </div>
        <div aria-hidden className="flex gap-[15px]">
          {period?.axis.map((label, i) => (
            <span
              key={`${period.value}-${i}`}
              data-slot="total-expenses-chart-axis-label"
              className="min-w-0 flex-1 text-center typo-label-02-regular whitespace-nowrap text-fg-soft"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
      <p aria-live="polite" className="sr-only">
        {announce}
      </p>
    </ChartCard>
  )
}

export {
  TotalExpensesChart,
  sampleTotalExpensesPeriods,
  type TotalExpensesCategory,
  type TotalExpensesChartProps,
  type TotalExpensesColor,
  type TotalExpensesPeriod,
  type TotalExpensesPoint,
  type TotalParts,
}
