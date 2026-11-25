import * as React from "react"

import { cn } from "@/lib/utils"

type ChartTooltipTextProps = React.ComponentProps<"span"> & {
  /** The tooltip the text sits in: "dark" (Background/Loud, the default) or "light" (Background/White). */
  variant?: "dark" | "light"
}

/** A tooltip's label (a date, a name) in Label/02 Regular: Text/Disable on the dark tooltip, Text/Soft on the light one. */
function ChartTooltipLabel({ variant = "dark", className, ...props }: ChartTooltipTextProps) {
  return (
    <span
      data-slot="chart-tooltip-label"
      className={cn("typo-label-02-regular hug-w", variant === "light" ? "text-fg-soft" : "text-fg-disable", className)}
      {...props}
    />
  )
}

/** A tooltip's value in Label/03 Medium: white on the dark tooltip, Text/Loud on the light one. Give it a ref to count it. */
function ChartTooltipValue({ variant = "dark", className, ...props }: ChartTooltipTextProps) {
  return (
    <span
      data-slot="chart-tooltip-value"
      className={cn("typo-label-03-medium hug-w", variant === "light" ? "text-fg-loud" : "text-fg-white", className)}
      {...props}
    />
  )
}

type ChartTooltipLinesProps = {
  /** The first line: what the tooltip reads (a date, a name). */
  label: React.ReactNode
  /** The second line: the value. */
  value: React.ReactNode
  /** The value's span, to count it with useCountUp in the visible tooltip. */
  valueRef?: React.Ref<HTMLSpanElement>
}

/**
 * The two lines of the Keitoto dark tooltip: the label (ChartTooltipLabel) over the value (ChartTooltipValue). They are
 * the lines only, with no box: put them in the tooltip's column (`flex flex-col items-start gap-2` on Background/Loud).
 * A tooltip whose value counts renders them twice: with `valueRef` in the tooltip, and with the final text in an
 * invisible copy that is measured to place it (the counting value changes width).
 */
function ChartTooltipLines({ label, value, valueRef }: ChartTooltipLinesProps) {
  return (
    <>
      <ChartTooltipLabel>{label}</ChartTooltipLabel>
      <ChartTooltipValue ref={valueRef}>{value}</ChartTooltipValue>
    </>
  )
}

export { ChartTooltipLabel, ChartTooltipLines, ChartTooltipValue, type ChartTooltipLinesProps, type ChartTooltipTextProps }
