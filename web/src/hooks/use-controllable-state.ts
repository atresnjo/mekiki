"use client"

import { useCallback, useState } from "react"

/**
 * State that a parent may control (`value` + `onChange`) or leave to the component (`defaultValue`).
 * The setter always calls `onChange`; it only updates local state when uncontrolled.
 */
export function useControllableState<T>({ value, defaultValue, onChange }: { value?: T; defaultValue: T; onChange?: (value: T) => void }) {
  const [local, setLocal] = useState(defaultValue)
  const controlled = value !== undefined
  const current = controlled ? value : local

  const set = useCallback(
    (next: T) => {
      if (!controlled) setLocal(next)
      onChange?.(next)
    },
    [controlled, onChange],
  )
  return [current, set] as const
}
