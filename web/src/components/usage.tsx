import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Button } from "@cloudflare/kumo/components/button"
import { Popover } from "@cloudflare/kumo/components/popover"
import { Text } from "@cloudflare/kumo/components/text"
import { ArrowReloadHorizontalIcon, DashboardSpeed01Icon } from "@hugeicons/core-free-icons"
import { Icon } from "./icon.tsx"
import { AsyncResult } from "effect/reactivity"
import { Option } from "effect"
import { useEffect, useState } from "react"
import { type ProviderUsage, usageAtom } from "../lib/glance.ts"
import { ago } from "./ui.tsx"

const Provider = ({ name, usage, now }: { name: string; usage: ProviderUsage; now: number }) => (
  <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <Text bold>{name}</Text>
      <span className="text-xs text-kumo-subtle">Checked {ago(usage.checkedAt, now)}</span>
    </div>
    {usage.unavailable ? (
      <p className="text-sm text-kumo-subtle" role="status">
        {usage.unavailable}
      </p>
    ) : (
      usage.windows.map((window, index) => {
        const expired = window.resetsAt !== null && window.resetsAt <= now
        const percent = window.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 1 })
        const tone = window.usedPercent >= 90 ? "bg-kumo-danger" : window.usedPercent >= 75 ? "bg-kumo-warning" : "bg-kumo-brand"
        return (
          <div key={`${window.label}-${index}`} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 break-words">{window.label}</span>
              <span className="tabular shrink-0">{percent}% used</span>
            </div>
            <div
              role="meter"
              aria-label={`${name} ${window.label} usage`}
              aria-valuenow={window.usedPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={`${percent}% used${expired ? ", awaiting reset update" : ""}`}
              className="h-1.5 overflow-hidden rounded-full bg-kumo-fill"
            >
              <div className={`h-full ${tone}`} style={{ width: `${window.usedPercent}%` }} />
            </div>
            <span className="text-xs text-kumo-subtle">
              {window.resetsAt === null ? (
                "Reset time unavailable"
              ) : expired ? (
                "Reset time passed · awaiting provider update"
              ) : (
                <>
                  Resets{" "}
                  <time dateTime={new Date(window.resetsAt).toISOString()}>
                    {new Date(window.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}
                  </time>
                </>
              )}
            </span>
          </div>
        )
      })
    )}
  </div>
)

/** the highest share of any window used, for the header: what's closest to running out */
const highest = (windows: ReadonlyArray<{ readonly usedPercent: number }>) =>
  windows.length === 0 ? undefined : Math.max(...windows.map((w) => w.usedPercent))

/** subscription usage in the header: the closest limit at a glance, every window a click away */
export const UsageMenu = () => {
  const result = useAtomValue(usageAtom)
  const refresh = useAtomRefresh(usageAtom)
  const usage = Option.getOrUndefined(AsyncResult.value(result))
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        setNow(Date.now())
        refresh()
      }
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const top = usage && highest([...usage.claude.windows, ...usage.codex.windows])
  const tone = top === undefined ? "" : top >= 90 ? "text-kumo-danger" : top >= 75 ? "text-kumo-warning" : ""

  return (
    <Popover>
      <Popover.Trigger
        render={
          <button
            type="button"
            aria-label="Subscription usage"
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
          />
        }
      >
        <Icon icon={DashboardSpeed01Icon} className={tone} />
        <span className={`tabular ${tone}`}>{top === undefined ? "Usage" : `${Math.round(top)}%`}</span>
      </Popover.Trigger>
      <Popover.Content align="end" className="flex w-[min(92vw,400px)] flex-col gap-4 p-4">
        <section aria-labelledby="subscription-usage-title" className="flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <Text as="h2" bold id="subscription-usage-title">
                Subscription usage
              </Text>
              <Text variant="secondary" size="xs">
                Account-wide, including use outside glance. Claude updates every 15 minutes, Codex every 5.
              </Text>
            </div>
            <Button
              variant="ghost"
              size="sm"
              shape="square"
              icon={<Icon icon={ArrowReloadHorizontalIcon} />}
              aria-label="Refresh subscription usage"
              loading={result.waiting}
              onClick={refresh}
            />
          </div>
          {AsyncResult.isFailure(result) && (
            <p role="alert" className="text-sm text-kumo-danger">
              Could not load usage. Check your connection and refresh.
            </p>
          )}
          {usage ? (
            <div className="flex flex-col gap-5">
              <Provider name="Claude Code" usage={usage.claude} now={now} />
              <div className="border-t border-kumo-hairline" />
              <Provider name="Codex" usage={usage.codex} now={now} />
            </div>
          ) : (
            !AsyncResult.isFailure(result) && (
              <p role="status" className="text-sm text-kumo-subtle">
                Checking subscription limits…
              </p>
            )
          )}
        </section>
      </Popover.Content>
    </Popover>
  )
}
