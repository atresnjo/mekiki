"use client"

import { animate, utils } from "animejs"
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui"
import * as React from "react"

import { releaseStyles, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useControllableState } from "@/hooks/use-controllable-state"
import { cn } from "@/lib/utils"

type ChartSegmentedControlItem = {
  value: string
  label: React.ReactNode
  /** Required when `label` is an icon. */
  "aria-label"?: string
  disabled?: boolean
}

type ChartSegmentedControlProps = Omit<React.ComponentProps<"div">, "defaultValue" | "dir" | "onChange"> & {
  items: ChartSegmentedControlItem[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** Figma Type: "default" (14px corners, soft grey labels) or "rounded" (pill, darker labels). */
  variant?: "default" | "rounded"
  /**
   * Figma State: "text" segments share the width; "icon" segments are 56px wide and the control hugs them; "fit"
   * segments hug their labels (16px padding) and the control hugs them.
   */
  size?: "text" | "icon" | "fit"
}

/**
 * The Keitoto "Segment Control" (Week / Month / Year). One segment is always selected; the white thumb slides to it
 * with anime.js. Arrow keys move between segments (Radix ToggleGroup).
 */
function ChartSegmentedControl({
  items,
  value: valueProp,
  defaultValue,
  onValueChange,
  variant = "default",
  size = "text",
  className,
  ...props
}: ChartSegmentedControlProps) {
  const [value, setValue] = useControllableState({ value: valueProp, defaultValue: defaultValue ?? items[0]?.value ?? "", onChange: onValueChange })
  const index = items.findIndex((item) => item.value === value)
  const count = Math.max(items.length, 1)
  const fit = size === "fit"
  const root = React.useRef<HTMLDivElement>(null)
  const thumb = React.useRef<HTMLSpanElement>(null)
  const lastIndex = React.useRef(index)
  const reduced = useReducedMotion()

  // The thumb is positioned by CSS (so the server render is already right); a change slides it from where it was.
  // Segments of different widths ("fit") each hold their own thumb: the new one slides and stretches over from the
  // old segment.
  useIsomorphicLayoutEffect(() => {
    const from = lastIndex.current
    lastIndex.current = index
    if (reduced || from === index || from < 0 || index < 0) return
    if (fit) {
      const segments = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-slot="chart-segmented-control-item"]') ?? [])
      const before = segments[from]
      const after = segments[index]
      const next = after?.querySelector<HTMLElement>('[data-slot="chart-segmented-control-thumb"]')
      if (!before || !after || !next) return
      animate(next, {
        translateX: [before.offsetLeft - after.offsetLeft, 0],
        width: [before.offsetWidth, after.offsetWidth],
        duration: 550,
        ease: "outExpo",
        onComplete: releaseStyles("transform", "width"),
      })
      return
    }
    const el = thumb.current
    if (!el) return
    const inFlight = utils.get(el, "translateX", false) as number
    animate(el, {
      translateX: [(from - index) * el.offsetWidth + inFlight, 0],
      duration: 550,
      ease: "outExpo",
      onComplete: releaseStyles("transform"),
    })
  }, [index, reduced, fit])

  const rounded = variant === "rounded"
  return (
    <ToggleGroupPrimitive.Root
      ref={root}
      type="single"
      value={value}
      onValueChange={(next) => next && setValue(next)}
      data-slot="chart-segmented-control"
      data-variant={variant}
      className={cn(
        "relative flex items-center p-px",
        rounded ? "rounded-full bg-surface-base" : "rounded-[14px] bg-surface-disable",
        (size === "icon" || fit) && "w-fit",
        className,
      )}
      {...props}
    >
      {!fit && index >= 0 && (
        <span
          ref={thumb}
          aria-hidden
          data-slot="chart-segmented-control-thumb"
          className={cn(
            "pointer-events-none absolute inset-y-px bg-surface-white shadow-[0_1px_2px_rgb(40_40_40/0.08),0_0_0_1px_var(--chart-ring)]",
            rounded ? "rounded-full" : "rounded-xl",
          )}
          style={{ left: `calc(1px + ${index} * (100% - 2px) / ${count})`, width: `calc((100% - 2px) / ${count})` }}
        />
      )}
      {items.map((item) => (
        <ToggleGroupPrimitive.Item
          key={item.value}
          value={item.value}
          aria-label={item["aria-label"]}
          disabled={item.disabled}
          data-slot="chart-segmented-control-item"
          className={cn(
            "group/segment relative flex items-center justify-center rounded-xl py-[9px] whitespace-nowrap outline-none transition-colors duration-200",
            "typo-label-03-medium data-[state=on]:typo-label-03-semibold data-[state=on]:text-fg-loud",
            "focus-visible:ring-2 focus-visible:ring-primary-orange-500/40 disabled:pointer-events-none disabled:opacity-50",
            rounded ? "text-fg-normal data-[state=off]:hover:text-fg-loud" : "text-fg-soft data-[state=off]:hover:text-fg-normal",
            size === "icon" ? "w-14 px-5" : fit ? "shrink-0 px-4" : "min-w-0 flex-1 px-4",
            fit && (rounded ? "rounded-full" : "rounded-xl"),
          )}
        >
          {fit ? (
            <>
              <span
                aria-hidden
                data-slot="chart-segmented-control-thumb"
                className={cn(
                  "pointer-events-none absolute inset-y-0 left-0 w-full bg-surface-white opacity-0 shadow-[0_1px_2px_rgb(40_40_40/0.08),0_0_0_1px_var(--chart-ring)] group-data-[state=on]/segment:opacity-100",
                  rounded ? "rounded-full" : "rounded-xl",
                )}
              />
              {/* hug-w: whole-pixel widths, like Figma's text boxes */}
              <span className="relative flex hug-w items-center">{item.label}</span>
            </>
          ) : (
            item.label
          )}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  )
}

export { ChartSegmentedControl, type ChartSegmentedControlItem, type ChartSegmentedControlProps }
