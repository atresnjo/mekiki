"use client"

import { useCallback, useState } from "react"

/**
 * The content-box size of an element, kept up to date with a ResizeObserver. Returns a callback ref and the size,
 * which starts at `initial` (also the server render), so a chart can draw at its design size before it is measured.
 */
export function useChartSize<T extends HTMLElement = HTMLDivElement>(initial: { width: number; height: number }) {
  const [size, setSize] = useState(initial)
  const ref = useCallback((node: T | null) => {
    if (!node || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const box = entry.contentBoxSize?.[0]
      const width = box ? box.inlineSize : entry.contentRect.width
      const height = box ? box.blockSize : entry.contentRect.height
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, size] as const
}
