"use client"

import * as React from "react"

import { TrendDownIcon, TrendUpIcon } from "@/components/ui/chart-icons"
import { useCountUp } from "@/hooks/use-chart-motion"
import { formatPercent } from "@/lib/chart-format"
import { cn } from "@/lib/utils"

type ChartTrendProps = Omit<React.ComponentProps<"span">, "children"> & {
  /** Change in percent. Positive (or zero) goes up, negative down; the number is shown without a sign. */
  value: number
  /** Soft text after the percentage ("Today", "this month"). */
  label?: React.ReactNode
  /** Fixed fraction digits: 2 shows "2.40%". Up to two, without trailing zeros, when omitted ("13.7%"). */
  fractionDigits?: number
  /**
   * Which way is good news, in green: "up" (the default) or "down" (failures, waiting times); the other way is red.
   * "none": neither, in the soft text colour.
   */
  good?: "up" | "down" | "none"
  locale?: string
}

/**
 * The trend line of the Keitoto chart cards: a trend-up / trend-down arrow, the percentage in green or red
 * (Label/02 Medium) and a soft label (Label/02 Regular), 4px apart. A new value counts from the previous one.
 */
function ChartTrend({ value, label, fractionDigits, good = "up", locale = "en-US", className, ...props }: ChartTrendProps) {
  const percentRef = React.useRef<HTMLSpanElement>(null)
  const format = React.useCallback(
    (n: number) =>
      formatPercent(Math.abs(n), {
        locale,
        ...(fractionDigits !== undefined ? { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits } : {}),
      }),
    [locale, fractionDigits],
  )
  useCountUp(percentRef, value, format)
  const down = value < 0
  const tone = value === 0 || good === "none" ? "text-fg-soft" : down === (good === "down") ? "text-primary-green-500" : "text-error-500"
  const Icon = down ? TrendDownIcon : TrendUpIcon

  return (
    <span data-slot="chart-trend" data-trend={down ? "down" : "up"} className={cn("inline-flex items-center gap-1 whitespace-nowrap", className)} {...props}>
      <Icon className={cn("shrink-0", tone)} />
      <span ref={percentRef} data-slot="chart-trend-value" className={cn("typo-label-02-medium hug-w", tone)}>
        {format(value)}
      </span>
      {label != null && <span className="hug-w typo-label-02-regular text-fg-soft">{label}</span>}
    </span>
  )
}

export { ChartTrend, type ChartTrendProps }
