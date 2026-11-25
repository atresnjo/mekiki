import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The 16 × 6 colour swatch of the Keitoto chart legends: 2px corners, two soft drop shadows, a white inner glow and a
 * 0.5px white stroke that fades from 26% at the top. Set the colour with a background class (`bg-primary-orange-500`).
 */
function ChartSwatch({ className, ...props }: React.ComponentProps<"span">) {
  const gradient = `chart-swatch-stroke-${React.useId().replace(/[^\w-]/g, "")}`
  return (
    <span
      aria-hidden
      data-slot="chart-swatch"
      className={cn(
        "relative inline-block h-1.5 w-4 shrink-0 rounded-[2px] bg-primary-blue-500",
        // Figma paints later effects on top; CSS paints the first shadow on top
        "shadow-[0_2px_4px_rgb(9_9_11/0.16),0_1px_2px_rgb(9_9_11/0.08),inset_0_1px_20px_rgb(255_255_255/0.16)]",
        className,
      )}
      {...props}
    >
      {/* an SVG stroke, so the half pixel is anti-aliased like Figma's (a 0.5px border draws a full pixel at 1x) */}
      <svg className="pointer-events-none absolute inset-0 size-full overflow-visible">
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fff" stopOpacity={0.26} />
            <stop offset="0.4" stopColor="#fff" stopOpacity={0.0624} />
          </linearGradient>
        </defs>
        <rect
          x="0.25"
          y="0.25"
          rx="1.75"
          fill="none"
          stroke={`url(#${gradient})`}
          strokeWidth={0.5}
          style={{ width: "calc(100% - 0.5px)", height: "calc(100% - 0.5px)" }}
        />
      </svg>
    </span>
  )
}

export { ChartSwatch }
