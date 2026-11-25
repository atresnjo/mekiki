"use client"

import { animate, utils } from "animejs"
import { Tabs as TabsPrimitive } from "radix-ui"
import * as React from "react"

import { releaseStyles, useIsomorphicLayoutEffect, useReducedMotion } from "@/hooks/use-chart-motion"
import { useControllableState } from "@/hooks/use-controllable-state"
import { cn } from "@/lib/utils"

/**
 * Underlined tabs from the Keitoto chart cards (Pocket / Categories): equal-width triggers over a 1px Border/Soft
 * line, the active one orange with a gradient underline that slides to it with anime.js.
 */
function ChartTabs({
  value: valueProp,
  defaultValue,
  onValueChange,
  className,
  ...props
}: Omit<React.ComponentProps<typeof TabsPrimitive.Root>, "defaultValue"> & { defaultValue?: string }) {
  const [value, setValue] = useControllableState({ value: valueProp, defaultValue: defaultValue ?? "", onChange: onValueChange })
  const root = React.useRef<HTMLDivElement>(null)
  const last = React.useRef(value)
  const reduced = useReducedMotion()

  // Each trigger draws its own underline (visible when active), so the server render is already right; a change
  // slides the new underline over from where the previous one was.
  useIsomorphicLayoutEffect(() => {
    const previous = last.current
    last.current = value
    const el = root.current
    if (!el || reduced || previous === value) return
    const indicator = (tab: string) =>
      Array.from(el.querySelectorAll<HTMLElement>('[data-slot="chart-tabs-indicator"]')).find((node) => node.dataset.value === tab)
    const from = indicator(previous)
    const to = indicator(value)
    if (!from || !to) return
    // the boxes are on screen, translateX is in the tabs' own pixels: they differ under CSS zoom or a scale
    const box = el.getBoundingClientRect()
    const zoom = box.width / (el.offsetWidth || box.width || 1) || 1
    const offset = (from.getBoundingClientRect().left - to.getBoundingClientRect().left) / zoom
    utils.set(from, { translateX: 0 })
    from.style.removeProperty("transform")
    animate(to, { translateX: [offset, 0], duration: 600, ease: "outExpo", onComplete: releaseStyles("transform") })
  }, [value, reduced])

  return (
    <TabsPrimitive.Root ref={root} data-slot="chart-tabs" value={value} onValueChange={setValue} className={cn("flex flex-col gap-3", className)} {...props} />
  )
}

function ChartTabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List data-slot="chart-tabs-list" className={cn("flex items-center p-px shadow-[inset_0_-1px_0_var(--border-soft)]", className)} {...props} />
  )
}

function ChartTabsTrigger({ className, children, value, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  // useId() may contain characters that don't belong in a url(#…) reference
  const gradient = `chart-tabs-underline-${React.useId().replace(/[^\w-]/g, "")}`
  return (
    <TabsPrimitive.Trigger
      data-slot="chart-tabs-trigger"
      value={value}
      className={cn(
        "group/tab relative flex min-w-0 flex-1 items-center justify-center rounded-xl p-2.5 whitespace-nowrap outline-none transition-colors duration-200",
        "typo-label-03-medium text-fg-soft data-[state=active]:text-primary-orange-500 data-[state=inactive]:hover:text-fg-normal",
        "focus-visible:ring-2 focus-visible:ring-primary-orange-500/40 disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      {/* Figma: a 1.5px round-capped line centred on the trigger's bottom edge, 1px in from its left. An SVG stroke so
          the half pixel is anti-aliased like Figma's (a 1.5px box would snap to 2 full pixels). */}
      <svg
        aria-hidden
        data-slot="chart-tabs-indicator"
        data-value={value}
        className="pointer-events-none absolute -bottom-px left-px h-0.5 w-full overflow-visible opacity-0 group-data-[state=active]/tab:opacity-100"
      >
        <defs>
          <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" x2="100%" y1="0" y2="0">
            <stop offset="0" style={{ stopColor: "rgb(252 159 99)", stopOpacity: 0 }} />
            <stop offset="0.2981" style={{ stopColor: "var(--primary-orange-300)" }} />
            <stop offset="0.6971" style={{ stopColor: "var(--primary-orange-500)" }} />
            <stop offset="1" style={{ stopColor: "rgb(250 118 29)", stopOpacity: 0 }} />
          </linearGradient>
        </defs>
        <line x1="0" x2="100%" y1="1" y2="1" stroke={`url(#${gradient})`} strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    </TabsPrimitive.Trigger>
  )
}

function ChartTabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="chart-tabs-content" className={cn("outline-none", className)} {...props} />
}

export { ChartTabs, ChartTabsContent, ChartTabsList, ChartTabsTrigger }
