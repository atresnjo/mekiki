import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The white card every chart sits in (Figma: Background/White, 24 radius, 20 padding, 24 gap, clips its content).
 * It carries data-charts, which scopes the chart tokens to the card so your app's theme can't change them.
 */
function ChartCard({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="chart-card"
      data-charts=""
      className={cn("relative flex flex-col gap-4 overflow-hidden rounded-2xl bg-surface-white p-4 font-rounded text-fg-loud antialiased", className)}
      {...props}
    />
  )
}

export { ChartCard }
