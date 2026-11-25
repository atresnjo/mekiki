"use client"

// mebius charts kit: charts-total-value (https://www.mebius.design/freebies/charts/total-value). changed here: `format`
// replaces the currency formatting, `good` says which way a change is good news (fewer failures are), the change and
// the rows' changes are optional, the eye toggle (masking amounts) is gone, the ⋯ button only shows with a handler,
// and a card without lists has no tabs

import { animate, stagger, utils } from "animejs"
import * as React from "react"

import { ChartCard } from "@/components/ui/chart-card"
import {
  CarIcon,
  CoinsStackedIcon,
  CreditCardIcon,
  DotsHorizontalIcon,
  HomeIcon,
  PiggyBankIcon,
  ShoppingBagIcon,
  WalletSolidIcon,
} from "@/components/ui/chart-icons"
import { ChartSegmentedControl } from "@/components/ui/chart-segmented-control"
import { ChartTabs, ChartTabsContent, ChartTabsList, ChartTabsTrigger } from "@/components/ui/chart-tabs"
import { releaseStyles, useChartEntrance, useCountUp, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useControllableState } from "@/hooks/use-controllable-state"
import { formatCurrency, formatPercent } from "@/lib/chart-format"
import { cn } from "@/lib/utils"

type TotalValueBar = { label: string; value: number }

/** One segment of the Week / Month / Year control and the bars it shows. */
type TotalValueRange = { value: string; label: string; bars: TotalValueBar[] }

type TotalValueTone = "blue" | "indigo" | "green" | "orange" | "purple" | "red"

type TotalValueListItem = {
  id: string
  name: string
  /** Second line under the name ("Today"). */
  caption: string
  amount: number
  /** Change in percent ("+12%"), green when it goes the good way and red when not; none without a comparison. */
  change?: number
  /** Text after the change ("this month"). */
  changeLabel?: string
  icon: React.ReactNode
  tone?: TotalValueTone
}

/** One tab under the chart (Pocket / Categories) and its rows. */
type TotalValueList = { value: string; label: string; items: TotalValueListItem[] }

type TotalValueChartProps = Omit<React.ComponentProps<"div">, "children"> & {
  title?: string
  value?: number
  /** The change under the total: amount, percent (none without a comparison) and the period it covers ("Today"). */
  change?: { amount: number; percent?: number; label?: string }
  ranges?: TotalValueRange[]
  range?: string
  defaultRange?: string
  onRangeChange?: (range: string) => void
  lists?: TotalValueList[]
  defaultList?: string
  /** What a list shows when it has no rows. */
  emptyText?: string
  /** Which way a change is good news, in green: "up" (the default) or "down"; "none" leaves changes uncoloured. */
  good?: "up" | "down" | "none"
  /** Called by the ⋯ button (no button without it). */
  onMoreClick?: () => void
  /** The ⋯ button's accessible name and tooltip. */
  moreLabel?: string
  /** Every amount on the card; currency in `locale` and `currency` by default. */
  format?: (value: number) => string
  locale?: string
  currency?: string
}

// Figma geometry ("Total Value Chart" 1473:74745)
const PLOT_HEIGHT = 130 // the Bars frame: as tall as the tallest bar (Figma's 220, smaller to fit the dashboard)
const MARKER_OFFSET = 18 // the dashed marker sits 18px under the selected bar's top
const TOOLTIP_HEIGHT = 22
const MIN_BAR_HEIGHT = 12 // keeps a small non-zero bar visible with its 12px corners

const tones: Record<TotalValueTone, string> = {
  // blue and indigo are the Figma icon tiles (raw colours there), the others use the palette's 100/200/500 steps
  blue: "bg-[#c8e2fd] text-primary-blue-500 shadow-[0_0_0_1px_#b5d8fc]",
  indigo: "bg-[#c8cdfd] text-[#0921f6] shadow-[0_0_0_1px_#b5bcfc]",
  green: "bg-primary-green-100 text-primary-green-600 shadow-[0_0_0_1px_var(--primary-green-200)]",
  orange: "bg-primary-orange-100 text-primary-orange-500 shadow-[0_0_0_1px_var(--primary-orange-200)]",
  purple: "bg-primary-purple-100 text-primary-purple-500 shadow-[0_0_0_1px_var(--primary-purple-200)]",
  red: "bg-error-100 text-error-500 shadow-[0_0_0_1px_var(--error-200)]",
}

const sampleTotalValueRanges: TotalValueRange[] = [
  {
    value: "week",
    label: "Week",
    bars: [
      { label: "Sun", value: 2291.41 },
      { label: "Mon", value: 2940.64 },
      { label: "Tue", value: 1699.46 },
      { label: "Wed", value: 4200.91 },
      { label: "Thu", value: 2287.36 },
      { label: "Fri", value: 2944.12 },
      { label: "Sat", value: 1413.03 },
    ],
  },
  {
    value: "month",
    label: "Month",
    bars: [
      { label: "Week 1", value: 16240.5 },
      { label: "Week 2", value: 21480.2 },
      { label: "Week 3", value: 18950.75 },
      { label: "Week 4", value: 24310.4 },
    ],
  },
]

const sampleTotalValueLists: TotalValueList[] = [
  {
    value: "pocket",
    label: "Pocket",
    items: [
      { id: "main", name: "Main Pocket", caption: "Today", amount: 4250, change: 12, changeLabel: "this month", icon: <WalletSolidIcon />, tone: "blue" },
      {
        id: "investment",
        name: "Investment",
        caption: "Today",
        amount: 2184,
        change: 12,
        changeLabel: "this month",
        icon: <CoinsStackedIcon />,
        tone: "indigo",
      },
      { id: "savings", name: "Savings", caption: "Yesterday", amount: 12480.5, change: 4.2, changeLabel: "this month", icon: <PiggyBankIcon />, tone: "green" },
      {
        id: "card",
        name: "Credit Card",
        caption: "2 days ago",
        amount: 860.25,
        change: -3.4,
        changeLabel: "this month",
        icon: <CreditCardIcon />,
        tone: "orange",
      },
    ],
  },
  {
    value: "categories",
    label: "Categories",
    items: [
      {
        id: "shopping",
        name: "Shopping",
        caption: "18 transactions",
        amount: 1342.8,
        change: 8.5,
        changeLabel: "vs last month",
        icon: <ShoppingBagIcon />,
        tone: "orange",
      },
      {
        id: "transport",
        name: "Transport",
        caption: "9 transactions",
        amount: 420.15,
        change: -5.1,
        changeLabel: "vs last month",
        icon: <CarIcon />,
        tone: "blue",
      },
      { id: "housing", name: "Housing", caption: "2 transactions", amount: 1850, change: 0, changeLabel: "vs last month", icon: <HomeIcon />, tone: "purple" },
    ],
  },
]

const sampleTotalValueChange = { amount: -120.62, percent: -1.16, label: "Today" }

/** Bar heights in px: the tallest bar fills the plot, every non-zero bar stays at least MIN_BAR_HEIGHT tall. */
function barHeights(bars: TotalValueBar[]) {
  const max = Math.max(0, ...bars.map((bar) => bar.value))
  return bars.map((bar) => (max > 0 && bar.value > 0 ? Math.max(Math.round((bar.value / max) * PLOT_HEIGHT), MIN_BAR_HEIGHT) : 0))
}

function maxIndex(bars: TotalValueBar[]) {
  return bars.reduce((best, bar, i) => (bar.value > (bars[best]?.value ?? -Infinity) ? i : best), 0)
}

/** "+3", "-1,204", "0": an amount with its sign */
const signed = (format: (value: number) => string, value: number) => (value > 0 ? `+${format(value)}` : value < 0 ? `-${format(-value)}` : format(0))

/** green when the change goes the good way, red when not, soft when there's none */
const toneOf = (value: number, good: "up" | "down" | "none") =>
  value === 0 || good === "none" ? "text-fg-soft" : value > 0 === (good === "up") ? "text-primary-green-500" : "text-error-500"

/**
 * "Total Value Chart" from the Keitoto library: the total with its change, a Week / Month / Year switch, a bar chart
 * whose selected bar (the highest by default) turns orange with a dashed marker and a value pill, and tabs listing what
 * the total is made of. Hover a bar to preview it, click or use the arrow keys to select it. Animated with anime.js:
 * the bars grow in when the card scrolls into view, the total counts up, and every change (range, selection, tab)
 * moves instead of jumping.
 */
function TotalValueChart({
  title = "Total value",
  value = 320418.16,
  change = sampleTotalValueChange,
  ranges = sampleTotalValueRanges,
  range: rangeProp,
  defaultRange,
  onRangeChange,
  lists = sampleTotalValueLists,
  defaultList,
  emptyText = "Nothing here yet",
  good = "up",
  onMoreClick,
  moreLabel = "More options",
  format,
  locale = "en-US",
  currency = "USD",
  className,
  ...props
}: TotalValueChartProps) {
  const [range, setRange] = useControllableState({ value: rangeProp, defaultValue: defaultRange ?? ranges[0]?.value ?? "", onChange: onRangeChange })
  const [list, setList] = React.useState(defaultList ?? lists[0]?.value ?? "")
  const current = ranges.find((r) => r.value === range) ?? ranges[0]
  const bars = React.useMemo(() => current?.bars ?? [], [current])
  const heights = React.useMemo(() => barHeights(bars), [bars])
  // Content key: parents may pass a new `ranges` array on every render, so changes are detected by value.
  const dataKey = `${current?.value}:${heights.join(",")}`

  const [picked, setPicked] = React.useState<Record<string, number>>({})
  const [hovered, setHovered] = React.useState<number | null>(null)
  const selected = Math.min(picked[current?.value ?? ""] ?? maxIndex(bars), bars.length - 1)
  const active = hovered !== null && hovered < bars.length ? hovered : selected
  const activeBar = bars[active]
  const lineY = activeBar ? Math.min(PLOT_HEIGHT - (heights[active] ?? 0) + MARKER_OFFSET, PLOT_HEIGHT - TOOLTIP_HEIGHT / 2) : MARKER_OFFSET

  const money = React.useCallback((n: number) => (format ? format(n) : formatCurrency(n, { locale, currency })), [format, locale, currency])

  const root = React.useRef<HTMLDivElement>(null)
  const totalRef = React.useRef<HTMLParagraphElement>(null)
  const plotRef = React.useRef<HTMLDivElement>(null)
  const tooltipRef = React.useRef<HTMLDivElement>(null)
  const tipValueRef = React.useRef<HTMLSpanElement>(null)
  const totalText = money(value)
  const totalTextRef = React.useRef(totalText)
  const reduced = useReducedMotion()
  useIsomorphicLayoutEffect(() => {
    totalTextRef.current = totalText
  })

  const all = (selector: string) => Array.from(root.current?.querySelectorAll<HTMLElement>(selector) ?? [])

  // Entrance, once the card is in view: the total counts up, the bars grow from the baseline one after another,
  // then the marker draws across and the value pill pops in; the list rows rise in last.
  useChartEntrance(root, (timeline) => {
    const counter = { n: 0 }
    const total = totalRef.current
    if (total) total.textContent = money(0)
    timeline
      .add(counter, {
        n: [0, value],
        duration: 1400,
        ease: "outExpo",
        onUpdate: () => {
          if (total) total.textContent = money(counter.n)
        },
      })
      .add(
        all('[data-slot="total-value-chart-change"]'),
        { opacity: { from: 0 }, translateY: { from: 4 }, duration: 600, ease: "outQuad", delay: stagger(80) },
        200,
      )
      .add(all('[data-slot="total-value-chart-bar"]'), { height: { from: 0 }, duration: 1100, ease: "outExpo", delay: stagger(70) }, 150)
      .add(
        all('[data-slot="total-value-chart-label"]'),
        { opacity: { from: 0 }, translateY: { from: 6 }, duration: 600, ease: "outQuad", delay: stagger(70) },
        250,
      )
      .add(all('[data-slot="total-value-chart-marker"]'), { clipPath: ["inset(0% 100% 0% 0%)", "inset(0% 0% 0% 0%)"], duration: 700, ease: "inOutQuart" }, 700)
      .add(
        all('[data-slot="total-value-chart-pill"]'),
        { opacity: { from: 0 }, scale: { from: 0.85 }, translateX: { from: -6 }, duration: 600, ease: "outBack(1.6)" },
        1100,
      )
      .add(all('[data-slot="chart-tabs-indicator"]'), { scaleX: { from: 0 }, duration: 900, ease: "outExpo" }, 500)
      .add(
        all('[data-slot="total-value-chart-row"]'),
        { opacity: { from: 0 }, translateY: { from: 10 }, duration: 800, ease: "outExpo", delay: stagger(90) },
        450,
      )
    // a reverted entrance (unmount, reduced motion switched on) leaves the counter's text behind: put React's back
    return () => {
      if (total) total.textContent = totalTextRef.current
    }
  })

  // Range switch: every bar grows or shrinks from its previous height (new bars from the baseline), labels fade in.
  const lastData = React.useRef({ key: dataKey, heights })
  useIsomorphicLayoutEffect(() => {
    const previous = lastData.current
    lastData.current = { key: dataKey, heights }
    if (previous.key === dataKey || reduced) return
    all('[data-slot="total-value-chart-bar"]').forEach((el, i) => {
      animate(el, { height: [previous.heights[i] ?? 0, heights[i] ?? 0], duration: 800, delay: i * 35, ease: "outExpo" })
    })
    animate(all('[data-slot="total-value-chart-label"]'), {
      opacity: [0, 1],
      translateY: [6, 0],
      duration: 500,
      delay: stagger(35),
      ease: "outQuad",
      onComplete: releaseStyles("opacity", "transform"),
    })
  }, [dataKey, reduced])

  // Selection: the orange fill cross-fades between bars and the marker + pill glide to the new bar's level.
  const lastActive = React.useRef(active)
  useIsomorphicLayoutEffect(() => {
    const previous = lastActive.current
    lastActive.current = active
    if (reduced || previous === active) return
    const highlights = all('[data-slot="total-value-chart-bar-highlight"]')
    // React already applied the new classes: start from the inline opacity of a fade still running (a quick hover back
    // and forth reverses instead of jumping), otherwise from the other end
    for (const [el, to] of [
      [highlights[active], 1],
      [highlights[previous], 0],
    ] as const) {
      if (!el) continue
      const from = el.style.opacity === "" ? 1 - to : Number(el.style.opacity)
      animate(el, { opacity: [from, to], duration: 280, ease: "outQuad", onComplete: releaseStyles("opacity") })
    }
  }, [active, reduced])

  const lastLine = React.useRef(lineY)
  useIsomorphicLayoutEffect(() => {
    const from = lastLine.current
    lastLine.current = lineY
    const el = tooltipRef.current
    if (!el || reduced || from === lineY) return
    animate(el, {
      translateY: [from - lineY + (utils.get(el, "translateY", false) as number), 0],
      duration: 550,
      ease: "outExpo",
      onComplete: releaseStyles("transform"),
    })
  }, [lineY, reduced])

  // A new total (live data) and the pill's amount count from their previous value to the new one.
  const activeValue = activeBar?.value ?? 0
  useCountUp(totalRef, value, money, { duration: 900 })
  useCountUp(tipValueRef, activeValue, money, { duration: 550 })

  // A new tab's rows rise in one after another.
  const lastList = React.useRef(list)
  useIsomorphicLayoutEffect(() => {
    const previous = lastList.current
    lastList.current = list
    if (reduced || previous === list) return
    animate(all('[data-slot="total-value-chart-row"]'), {
      opacity: [0, 1],
      translateY: [10, 0],
      duration: 600,
      delay: stagger(60),
      ease: "outExpo",
      onComplete: releaseStyles("opacity", "transform"),
    })
  }, [list, reduced])

  const pick = (index: number) => {
    if (!current) return
    setPicked((p) => ({ ...p, [current.value]: index }))
  }
  const onBarKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const last = bars.length - 1
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
    pick(index)
    plotRef.current?.querySelectorAll<HTMLButtonElement>('[data-slot="total-value-chart-bar"]')[index]?.focus()
  }

  return (
    <ChartCard ref={root} role="group" aria-label={title} className={cn("h-[440px] w-full pb-0", className)} {...props}>
      <div className="flex items-start gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <p className="hug-w typo-label-02-medium text-fg-soft">{title}</p>
          <div className="flex items-end gap-5">
            <p ref={totalRef} data-slot="total-value-chart-amount" className="hug-w typo-heading-02-semibold whitespace-nowrap text-fg-loud">
              {totalText}
            </p>
            <div className="flex flex-col justify-center gap-1">
              <p data-slot="total-value-chart-change" className={cn("typo-label-01-medium whitespace-nowrap", toneOf(change.amount, good))}>
                {signed(money, change.amount)}
                {change.percent !== undefined && ` (${formatPercent(change.percent, { locale, signDisplay: "exceptZero", maximumFractionDigits: 1 })})`}
              </p>
              {change.label && (
                <p data-slot="total-value-chart-change" className="typo-label-01-medium whitespace-nowrap text-fg-soft">
                  {change.label}
                </p>
              )}
            </div>
          </div>
        </div>
        {onMoreClick && (
          <button
            type="button"
            aria-label={moreLabel}
            title={moreLabel}
            onClick={onMoreClick}
            className="size-6 shrink-0 cursor-pointer rounded-md text-fg-soft transition-colors duration-200 outline-none hover:text-fg-normal focus-visible:ring-2 focus-visible:ring-primary-orange-500/40"
          >
            <DotsHorizontalIcon />
          </button>
        )}
      </div>

      {ranges.length > 1 && (
        <ChartSegmentedControl
          aria-label="Range"
          items={ranges.map((r) => ({ value: r.value, label: r.label }))}
          value={current?.value}
          onValueChange={(next) => {
            setHovered(null)
            setRange(next)
          }}
        />
      )}

      <div className="flex flex-col gap-2">
        <div ref={plotRef} className="relative" style={{ height: PLOT_HEIGHT }} onPointerLeave={() => setHovered(null)}>
          <div role="group" aria-label={`${title} by ${current?.label.toLowerCase() ?? "period"}`} className="flex h-full items-end gap-[15px]">
            {bars.map((bar, i) => (
              <button
                key={i}
                type="button"
                data-slot="total-value-chart-bar"
                data-active={i === active || undefined}
                aria-label={`${bar.label}: ${money(bar.value)}`}
                aria-pressed={i === selected}
                tabIndex={i === selected ? 0 : -1}
                onPointerEnter={() => setHovered(i)}
                onClick={() => pick(i)}
                onKeyDown={onBarKeyDown}
                className="group/bar relative min-w-0 flex-1 cursor-pointer rounded-t-xl bg-linear-to-b/srgb from-surface-disable via-surface-base via-[56.46%] to-surface-soft shadow-[0_0_0_1px_var(--surface-soft)] outline-none focus-visible:ring-2 focus-visible:ring-primary-orange-500/40"
                style={{ height: heights[i] }}
              >
                <span
                  aria-hidden
                  data-slot="total-value-chart-bar-highlight"
                  className="pointer-events-none absolute inset-0 rounded-[inherit] bg-linear-to-b/srgb from-primary-orange-300 via-primary-orange-500 via-[47.99%] to-primary-orange-600 opacity-0 shadow-[0_4px_4px_rgb(220_91_4/0.07),0_1px_2px_rgb(220_91_4/0.08),0_0_0_1px_var(--primary-orange-500),inset_0_2px_1px_rgb(255_255_255/0.24),inset_0_1px_1px_rgb(255_255_255/0.24)] group-data-active/bar:opacity-100"
                />
                {/* Figma's 1px inside stroke: white at 24% fading to nothing toward the baseline */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [background:linear-gradient(rgb(255_255_255/0.24),rgb(255_255_255/0))_border-box] [mask:linear-gradient(#000_0_0)_padding-box_exclude,linear-gradient(#000_0_0)]"
                />
              </button>
            ))}
          </div>
          {activeBar && (
            <div
              ref={tooltipRef}
              aria-hidden
              data-slot="total-value-chart-tooltip"
              className="pointer-events-none absolute inset-x-0 flex items-center"
              style={{ top: lineY - TOOLTIP_HEIGHT / 2, height: TOOLTIP_HEIGHT }}
            >
              {/* dashed marker: 2px, dashes and gaps of 4, starting 1px left of the plot like the Figma line */}
              <svg data-slot="total-value-chart-marker" className="-mr-[30px] h-0.5 min-w-0 flex-1 overflow-visible text-primary-orange-500">
                <line x1="-1" x2="100%" y1="1" y2="1" stroke="currentColor" strokeWidth={2} strokeDasharray="4 4" strokeDashoffset={1} />
              </svg>
              <div data-slot="total-value-chart-pill" className="relative flex origin-left gap-px typo-label-02-medium whitespace-nowrap text-fg-white">
                <span className="hug-w rounded-l-xl bg-primary-orange-500 px-1.5 py-1">{activeBar.label}</span>
                <span ref={tipValueRef} data-slot="total-value-chart-amount" className="hug-w rounded-r-xl bg-primary-orange-500 px-1.5 py-1">
                  {money(activeBar.value)}
                </span>
              </div>
            </div>
          )}
        </div>
        <div aria-hidden className="flex gap-[15px]">
          {bars.map((bar, i) => (
            <span
              key={i}
              data-slot="total-value-chart-label"
              className={cn(
                "min-w-0 flex-1 text-center whitespace-nowrap transition-colors duration-200",
                i === active ? "typo-label-02-semibold text-primary-orange-500" : "typo-label-02-regular text-fg-soft",
              )}
            >
              {bar.label}
            </span>
          ))}
        </div>
      </div>

      {lists.length > 0 && (
        <ChartTabs value={list} onValueChange={setList} className="min-h-0 flex-1">
          <ChartTabsList>
            {lists.map((l) => (
              <ChartTabsTrigger key={l.value} value={l.value}>
                {l.label}
              </ChartTabsTrigger>
            ))}
          </ChartTabsList>
          {lists.map((l) => (
            <ChartTabsContent
              key={l.value}
              value={l.value}
              className="-mx-px flex min-h-0 flex-1 [scrollbar-width:none] flex-col gap-1.5 overflow-y-auto px-px pb-16 [&::-webkit-scrollbar]:hidden"
            >
              {l.items.length === 0 && <p className="py-4 text-center typo-label-02-medium text-fg-soft">{emptyText}</p>}
              {l.items.map((item) => (
                <div key={item.id} data-slot="total-value-chart-row" className="flex items-center gap-3 py-2">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <span
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] [&_svg]:size-5",
                        tones[item.tone ?? "blue"],
                      )}
                    >
                      {item.icon}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <p className="-my-0.5 truncate py-0.5 typo-label-02-semibold text-fg-loud">{item.name}</p>
                      <p className="-my-0.5 truncate py-0.5 typo-label-02-medium text-fg-soft">{item.caption}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <p data-slot="total-value-chart-amount" className="hug-w typo-label-02-semibold whitespace-nowrap text-fg-loud">
                      {money(item.amount)}
                    </p>
                    <p className="hug-w typo-label-02-medium whitespace-nowrap text-fg-soft">
                      {item.change !== undefined && (
                        <span className={toneOf(item.change, good)}>
                          {formatPercent(item.change, { locale, signDisplay: "exceptZero", maximumFractionDigits: 0 })}
                        </span>
                      )}
                      {item.changeLabel && ` ${item.changeLabel}`}
                    </p>
                  </div>
                </div>
              ))}
            </ChartTabsContent>
          ))}
        </ChartTabs>
      )}

      {/* Figma "Gradient Overlay": fades the list out at the bottom edge (starts 1px in from the left like the frame) */}
      <div aria-hidden className="pointer-events-none absolute right-0 bottom-0 left-px h-16 bg-linear-to-b/srgb from-surface-white/0 to-surface-white" />
    </ChartCard>
  )
}

export {
  TotalValueChart,
  sampleTotalValueChange,
  sampleTotalValueLists,
  sampleTotalValueRanges,
  type TotalValueBar,
  type TotalValueChartProps,
  type TotalValueList,
  type TotalValueListItem,
  type TotalValueRange,
  type TotalValueTone,
}
