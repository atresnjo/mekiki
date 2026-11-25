import * as React from "react"

import { cn } from "@/lib/utils"

// The 44px tile: its fill and the colours of its 1px inside stroke (top to bottom)
const TONES = {
  orange: { fill: "bg-primary-orange-500", stroke: "from-primary-orange-500 to-primary-orange-700" },
  blue: { fill: "bg-primary-blue-500", stroke: "from-primary-blue-400 to-primary-blue-600" },
}

// The 30px tile: its fill and its shadows, the 1px ring in the fill's colour among them
const SMALL_TONES = {
  orange:
    "bg-primary-orange-500 shadow-[inset_0_-2px_3px_rgb(0_0_0/0.08),0_0_0_1px_var(--primary-orange-500),0_4px_4px_-3px_rgb(0_0_0/0.16),0_2px_4px_rgb(1_1_1/0.08)]",
  green:
    "bg-primary-green-500 shadow-[inset_0_-2px_3px_rgb(0_0_0/0.08),0_0_0_1px_var(--primary-green-500),0_4px_4px_-3px_rgb(0_0_0/0.16),0_2px_4px_rgb(1_1_1/0.08)]",
}

type ChartIconTileProps = React.ComponentProps<"span"> &
  (
    | {
        /** 44 (the default): a white sheen from the top, an inner shadow along the bottom and an inside stroke in the hue. */
        size?: 44
        /** The hue: the fill and its inside stroke (orange-500 to orange-700, or blue-400 to blue-600 on blue-500). */
        tone?: "orange" | "blue"
      }
    | {
        /** 30: the hue with a ring of itself, a white inside stroke and an inner shadow along the bottom. */
        size: 30
        /** The hue: the fill and its ring. */
        tone?: "orange" | "green"
      }
  )

/**
 * Figma "Icon Container", the tile next to a card's title, with the icon drawn white. 44px (13.2px corners, a 24px
 * icon): a white sheen from the top, an inner shadow along the bottom and a 1px inside stroke in the hue, over two
 * drop shadows. 30px (10px corners, a 16px icon): a ring in the hue, an inner shadow along the bottom, two drop
 * shadows and a 1px white inside stroke fading from 28% to 13%. `tone` picks the hue.
 */
function ChartIconTile({ size = 44, tone = "orange", className, children, ...props }: ChartIconTileProps) {
  if (size === 30) {
    return (
      <span
        data-slot="chart-icon-tile"
        className={cn(
          "relative flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] text-fg-white [&_svg]:size-4",
          SMALL_TONES[tone as keyof typeof SMALL_TONES],
          className,
        )}
        {...props}
      >
        {children}
        {/* Figma's 1px inside stroke: white at 28% fading to 13% toward the bottom */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [background:linear-gradient(rgb(255_255_255/0.28),rgb(255_255_255/0.1344))_border-box] [mask:linear-gradient(#000_0_0)_padding-box_exclude,linear-gradient(#000_0_0)]"
        />
      </span>
    )
  }
  const { fill, stroke } = TONES[tone as keyof typeof TONES]
  return (
    <span
      data-slot="chart-icon-tile"
      className={cn(
        "relative flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-[13.2px]",
        fill,
        "text-fg-white [&_svg]:size-6",
        // Figma paints later effects on top; CSS paints the first shadow on top
        "shadow-[0_8.8px_7.92px_-6.6px_rgb(0_0_0/0.16),0_4.4px_7.92px_rgb(1_1_1/0.08)]",
        className,
      )}
      {...props}
    >
      <span aria-hidden className="absolute inset-x-0 -top-[19.8px] h-[37.4px] bg-linear-to-b/srgb from-white/60 to-white/0" />
      <span className="relative flex">{children}</span>
      {/* Figma draws the frame's inner shadow and its stroke over the content */}
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-[inherit] shadow-[inset_0_-4.4px_5.94px_rgb(0_0_0/0.08)]" />
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent bg-linear-to-b/srgb",
          stroke,
          "bg-origin-border [mask:linear-gradient(#000_0_0)_padding-box_exclude,linear-gradient(#000_0_0)]",
        )}
      />
    </span>
  )
}

export { ChartIconTile, type ChartIconTileProps }
