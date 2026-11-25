import * as React from "react"

import { cn } from "@/lib/utils"

type ChartButtonProps = React.ComponentProps<"button"> & {
  /**
   * Keitoto Type: "secondary" (white, the default) or "primary": filled with the --chart-button-accent CSS variable
   * (blue-500 unless set, e.g. `[--chart-button-accent:var(--primary-orange-500)]`), white text.
   */
  variant?: "secondary" | "primary"
  /** "default": 12px corners (Keitoto Corner=Default); "rounded": a pill (Corner=Rounded). */
  corner?: "default" | "rounded"
  /** "icon": the 36 × 36 square of Type=Icon Secondary, around one 16px icon. */
  size?: "default" | "icon"
}

/**
 * Keitoto "Button". Type=Secondary and Icon Secondary: white with a soft ring and a soft drop shadow, 10px padding,
 * Label/03 Medium text that keeps 2px of extra padding on each side, and 16px soft icons 4px from it; State=Hover lays
 * 12% black over the white. Type=Primary: the accent colour with a ring of itself, a white inner glow, a white inside
 * stroke fading from 16% to 8% and a drop shadow, 10 × 12px padding, white text and icons; State=Hover darkens it 8%.
 * State=Disable is 50% opacity. Text children are wrapped in the label span for you, so
 * `<ChartButton>2025<ChevronDownIcon /></ChartButton>` is the Figma button.
 */
function ChartButton({ variant = "secondary", corner = "default", size = "default", type = "button", className, children, ...props }: ChartButtonProps) {
  const primary = variant === "primary"
  return (
    <button
      type={type}
      data-slot="chart-button"
      data-variant={variant}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 typo-label-03-medium whitespace-nowrap outline-none select-none",
        "transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-primary-blue-500/40 disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        primary
          ? [
              "bg-(--chart-button-accent) px-3 py-2.5 text-fg-white [--chart-button-accent:var(--primary-blue-500)] [&_svg]:text-fg-white",
              // Figma paints later effects on top; CSS paints the first shadow on top
              "shadow-[0_3px_6px_rgb(0_0_0/0.2),0_0_0_1px_var(--chart-button-accent),inset_0_0_6px_2px_rgb(255_255_255/0.32)]",
              "hover:bg-[color-mix(in_srgb,var(--chart-button-accent),#171717_8%)] data-[state=open]:bg-[color-mix(in_srgb,var(--chart-button-accent),#171717_8%)]",
            ]
          : [
              "bg-surface-white p-2.5 text-fg-loud [&_svg]:text-icon-soft",
              // Figma paints later effects on top; CSS paints the first shadow on top
              "shadow-[0_1px_2px_rgb(40_40_40/0.08),0_0_0_1px_var(--chart-ring)]",
              "hover:bg-[color-mix(in_srgb,var(--surface-white),var(--fg-loud)_12%)] data-[state=open]:bg-[color-mix(in_srgb,var(--surface-white),var(--fg-loud)_12%)]",
            ],
        corner === "rounded" ? "rounded-full" : "rounded-xl",
        size === "icon" && "size-9 p-0",
        className,
      )}
      {...props}
    >
      {primary && (
        // the inside stroke: white at 16% fading to 8%
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[inherit] border border-transparent [background:linear-gradient(rgb(255_255_255/0.16),rgb(255_255_255/0.08))_border-box] [mask:linear-gradient(#000_0_0)_padding-box_exclude,linear-gradient(#000_0_0)]"
        />
      )}
      {React.Children.map(children, (child) =>
        typeof child === "string" || typeof child === "number" ? (
          <span data-slot="chart-button-label" className="hug-w px-0.5">
            {child}
          </span>
        ) : (
          child
        ),
      )}
    </button>
  )
}

export { ChartButton, type ChartButtonProps }
