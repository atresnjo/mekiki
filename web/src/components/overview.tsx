import { Button } from "@cloudflare/kumo/components/button"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Select } from "@cloudflare/kumo/components/select"
import { Text } from "@cloudflare/kumo/components/text"
import { lazy, type ReactNode, Suspense, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useAtomSet } from "@effect/atom-react"
import { SkeletonBox } from "skullet/react"
import { loadOlder, type Review, useMoreToLoad } from "../lib/mekiki.ts"
import { RANGES, type Range } from "../lib/metrics.ts"
import { ReviewsTable } from "./table.tsx"
import { agentName, ago, depthLabel, elapsed, median, report, seconds, StatusBadge } from "./ui.tsx"

const OverviewCharts = lazy(() => import("./overview-charts.tsx"))

export const Overview = ({ reviews, now }: { reviews: ReadonlyArray<Review>; now: number }) => {
  const [range, setRange] = useState<Range>("7d")
  const [filter, setFilter] = useState<Review["status"] | "all">("all")
  const finishedTimes = reviews.flatMap((r) => (r.status === "done" && r.durationMs !== null ? [r.durationMs] : []))

  return (
    <div className="flex flex-col gap-6">
      <LatestCard reviews={reviews} now={now} typical={median(finishedTimes)} />

      <div className="flex items-center justify-between gap-4">
        <Text variant="heading" as="h2">
          Overview
        </Text>
        <Select
          aria-label="Time range"
          size="sm"
          value={range}
          onValueChange={(v) => v && setRange(v as Range)}
          items={Object.fromEntries(Object.entries(RANGES).map(([k, v]) => [k, v.label]))}
        />
      </div>

      <Suspense fallback={<ChartsSkeleton />}>
        <OverviewCharts reviews={reviews} now={now} range={range} onRange={setRange} onShow={setFilter} />
      </Suspense>

      <ReviewsTable reviews={reviews} now={now} filter={filter} onFilter={setFilter} />
      <LoadOlder oldest={reviews.at(-1)?.id} />
    </div>
  )
}

// ---------------------------------------------------------------------------- now reviewing

const Column = ({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) => (
  <div className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
    <Text bold size="sm">
      {label}
    </Text>
    <div className="min-w-0 text-base text-kumo-default">{children}</div>
  </div>
)

/** like the time a deploy has taken: elapsed against a typical review, capped until it's really done */
const Progress = ({ review, now, typical }: { review: Review; now: number; typical: number | undefined }) => {
  const pct =
    review.status === "running"
      ? Math.min(95, Math.round((elapsed(review, now) / Math.max(typical ?? 20_000, 1000)) * 100))
      : review.status === "done"
        ? 100
        : 100
  const tone = review.status === "failed" ? "bg-kumo-danger" : review.status === "running" || review.status === "done" ? "bg-kumo-brand" : "bg-kumo-fill"
  return (
    <div className="flex items-center gap-4">
      <span className="tabular w-11 shrink-0 text-base">{pct}%</span>
      <div className="relative flex-1 pt-4">
        <span className="tabular absolute -top-0.5 text-xs text-kumo-subtle" style={{ left: `calc(${pct}% - 1.25rem)` }}>
          {pct}%
        </span>
        <div className="h-1.5 w-full rounded-full bg-kumo-fill">
          <div className={`relative h-full rounded-full ${tone} transition-[width] duration-200`} style={{ width: `${pct}%` }}>
            <span className="bg-kumo-strong absolute -top-1 -right-px h-3.5 w-0.5 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  )
}

const LatestCard = ({ reviews, now, typical }: { reviews: ReadonlyArray<Review>; now: number; typical: number | undefined }) => {
  const running = reviews.filter((r) => r.status === "running")
  const rows = running.length > 0 ? running : reviews.slice(0, 1)
  if (rows.length === 0) return null
  return (
    <LayerCard>
      <LayerCard.Secondary>{running.length > 0 ? `Now reviewing${running.length > 1 ? ` (${running.length})` : ""}` : "Latest review"}</LayerCard.Secondary>
      <LayerCard.Primary className="flex flex-col divide-y divide-kumo-hairline py-0">
        {rows.map((r) => (
          <div key={r.id} className="grid grid-cols-2 gap-x-8 gap-y-4 py-4 md:grid-cols-[minmax(0,2.2fr)_auto_auto_minmax(0,3fr)_auto]">
            <Column label="Pull request">
              <Link to="/reviews/$id" params={{ id: String(r.id) }} className="block truncate hover:text-kumo-link">
                {r.title || `#${r.number}`}
              </Link>
              <Text variant="secondary" size="sm" truncate>
                {r.repo}#{r.number}
              </Text>
            </Column>
            <Column label="Started">
              {ago(r.startedAt, now)}
              <Text variant="secondary" size="sm">
                {r.trigger}
              </Text>
            </Column>
            <Column label="Depth">
              {depthLabel(r.depth)}
              <Text variant="secondary" size="sm" truncate>
                {agentName(r)}
              </Text>
            </Column>
            <Column label="Progress" className="col-span-2 md:col-span-1">
              <Progress review={r} now={now} typical={typical} />
            </Column>
            <Column label="Time" className="md:text-right">
              <span className="tabular">{seconds(elapsed(r, now))}</span>
              <div className="md:flex md:justify-end">
                <StatusBadge review={r} />
              </div>
            </Column>
          </div>
        ))}
      </LayerCard.Primary>
    </LayerCard>
  )
}

// ---------------------------------------------------------------------------- charts

/** while the charts chunk loads: the cards' outlines, in the same shimmer as the page skeletons */
const ChartsSkeleton = () => (
  <div className="flex flex-col gap-4">
    <div className="grid gap-4 xl:grid-cols-5">
      <SkeletonBox className="block xl:col-span-3" width="100%" height={300} radius="16px" />
      <SkeletonBox className="block xl:col-span-2" width="100%" height={300} radius="16px" />
    </div>
    <div className="grid gap-4 lg:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <SkeletonBox key={i} className="block" width="100%" height={440} radius="16px" />
      ))}
    </div>
  </div>
)

/** the live list holds the latest reviews; older ones load a page at a time */
const LoadOlder = ({ oldest }: { oldest: number | undefined }) => {
  const more = useMoreToLoad()
  const load = useAtomSet(loadOlder, { mode: "promiseExit" })
  const [busy, setBusy] = useState(false)
  if (!more || oldest === undefined) return null
  return (
    <div className="flex justify-center">
      <Button
        variant="secondary"
        loading={busy}
        onClick={async () => {
          setBusy(true)
          report(await load(oldest))
          setBusy(false)
        }}
      >
        Load older reviews
      </Button>
    </div>
  )
}
