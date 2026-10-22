// shared pieces: formatting, badges, the depth picker
import { Badge } from "@cloudflare/kumo/components/badge"
import { Loader } from "@cloudflare/kumo/components/loader"
import { Tabs } from "@cloudflare/kumo/components/tabs"
import { useEffect, useState } from "react"
import { Exit } from "effect"
import { causeMessage, type Depth, type Failure, type Review, type Severity } from "../lib/glance.ts"
import { toasts } from "../lib/toasts.ts"

export const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)

export const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  return `${Math.floor(s / (30 * 86_400))}mo ago`
}

export const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

export const elapsed = (review: Review, now: number) => review.durationMs ?? now - review.startedAt

export const fail = (message: string) => toasts.add({ title: "Something went wrong", description: message, variant: "error" })

/** a call's outcome, as a toast: why it failed, or `done` when it worked */
export const report = <A,>(exit: Exit.Exit<A, Failure>, done?: string) => {
  if (Exit.isFailure(exit)) fail(causeMessage(exit.cause))
  else if (done) toasts.add({ title: done, variant: "success" })
  return exit
}

export const agentName = (r: Pick<Review, "agent" | "model">) => `${r.agent === "claude" ? "Claude Code" : "Codex"}${r.model ? ` · ${r.model}` : ""}`

export const SEVERITY: Record<Severity, { variant: "red" | "orange" | "warning" | "blue"; label: string }> = {
  critical: { variant: "red", label: "Critical" },
  high: { variant: "orange", label: "High" },
  medium: { variant: "warning", label: "Medium" },
  low: { variant: "blue", label: "Low" },
}

export const DEPTHS: ReadonlyArray<{ value: Depth; label: string; hint: string }> = [
  { value: "light", label: "Light", hint: "Low reasoning: the fastest pass" },
  { value: "medium", label: "Medium", hint: "Medium reasoning: slower, catches more" },
  { value: "high", label: "High", hint: "High reasoning: the most thorough, the slowest" },
]

export const depthLabel = (depth: Depth) => DEPTHS.find((d) => d.value === depth)?.label ?? depth

export const DepthPicker = ({ value, onChange, size = "base" }: { value: Depth; onChange: (depth: Depth) => void; size?: "base" | "sm" }) => (
  <Tabs
    variant="segmented"
    size={size}
    value={value}
    onValueChange={(v) => onChange(v as Depth)}
    tabs={DEPTHS.map((d) => ({ value: d.value, label: <span title={d.hint}>{d.label}</span> }))}
  />
)

export const StatusBadge = ({ review }: { review: Review }) => {
  switch (review.status) {
    case "running":
      return (
        <Badge variant="info" icon={<Loader size={12} />}>
          Reviewing
        </Badge>
      )
    case "done":
      return review.findings.length === 0 ? (
        <Badge variant="success" appearance="dot">
          Clean
        </Badge>
      ) : (
        <Badge variant="warning" appearance="dot">
          {review.findings.length} {review.findings.length === 1 ? "issue" : "issues"}
        </Badge>
      )
    case "failed":
      return (
        <Badge variant="error" appearance="dot">
          Failed
        </Badge>
      )
    case "cancelled":
      return (
        <Badge variant="neutral" appearance="dot">
          Cancelled
        </Badge>
      )
    case "skipped":
      return (
        <Badge variant="neutral" appearance="dot">
          Skipped
        </Badge>
      )
  }
}

export const useDarkMode = () => {
  const [dark, setDark] = useState(() => document.documentElement.dataset.mode === "dark")
  useEffect(() => {
    const observer = new MutationObserver(() => setDark(document.documentElement.dataset.mode === "dark"))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] })
    return () => observer.disconnect()
  }, [])
  return dark
}

/** a clock that ticks while `active`: for live elapsed times */
export const useNow = (active: boolean) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(timer)
  }, [active])
  return now
}
