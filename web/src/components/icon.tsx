// every icon in the dashboard is a hugeicon, drawn the same way: one size and stroke unless asked
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import type { ComponentProps } from "react"
import type { DropdownMenu } from "@cloudflare/kumo/components/dropdown"

export type Glyph = IconSvgElement

export const Icon = ({ icon, size = 16, strokeWidth = 1.6, className }: { icon: Glyph; size?: number; strokeWidth?: number; className?: string }) => (
  <HugeiconsIcon icon={icon} size={size} strokeWidth={strokeWidth} className={className} aria-hidden />
)

/** what kumo's menus take: a component they size and space themselves (an element gets no gap from them) */
export const menuIcon = (icon: Glyph) =>
  (({ className }: { className?: string }) => <Icon icon={icon} className={className} />) as unknown as NonNullable<
    ComponentProps<typeof DropdownMenu.SubTrigger>["icon"]
  >
