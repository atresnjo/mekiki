"use client"

import { animate } from "animejs"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import * as React from "react"

import { CheckIcon } from "@/components/ui/chart-icons"
import { releaseStyles, useReducedMotion } from "@/hooks/use-chart-motion"
import { cn } from "@/lib/utils"

/**
 * A small menu for the chart cards' period buttons ("Monthly ▾"), built on Radix DropdownMenu. Keitoto doesn't draw
 * the open menu: it uses the white surface, soft ring and soft shadow of the Segment Control, Label/02 text and a
 * check on the selected item, and opens with an anime.js scale-in.
 */
function ChartMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="chart-menu" {...props} />
}

function ChartMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="chart-menu-trigger" {...props} />
}

function ChartMenuContent({
  className,
  sideOffset = 8,
  align = "end",
  container,
  ref,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & { container?: HTMLElement | null }) {
  const reduced = useReducedMotion()
  // Radix mounts the content when the menu opens: animate it in from the trigger side.
  const enter = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (typeof ref === "function") ref(node)
      else if (ref) ref.current = node
      if (!node || reduced) return
      animate(node, {
        opacity: [0, 1],
        scale: [0.96, 1],
        translateY: [-4, 0],
        duration: 220,
        ease: "outQuad",
        onComplete: releaseStyles("opacity", "transform"),
      })
    },
    [ref, reduced],
  )
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        ref={enter}
        data-slot="chart-menu-content"
        data-charts=""
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-[140px] origin-(--radix-dropdown-menu-content-transform-origin) rounded-xl bg-surface-white p-1 font-rounded text-fg-loud outline-none",
          "shadow-[0_12px_32px_rgb(23_23_23/0.12),0_1px_2px_rgb(40_40_40/0.08),0_0_0_1px_var(--chart-ring)]",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function ChartMenuRadioGroup(props: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="chart-menu-radio-group" {...props} />
}

function ChartMenuRadioItem({ className, children, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="chart-menu-radio-item"
      className={cn(
        "flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 typo-label-02-medium whitespace-nowrap text-fg-normal outline-none select-none",
        "data-highlighted:bg-surface-disable data-[state=checked]:text-fg-loud data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator>
        <CheckIcon className="size-4 text-fg-loud" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  )
}

export { ChartMenu, ChartMenuContent, ChartMenuRadioGroup, ChartMenuRadioItem, ChartMenuTrigger }
