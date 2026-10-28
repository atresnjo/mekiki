import { Button } from "@cloudflare/kumo/components/button"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Select } from "@cloudflare/kumo/components/select"
import { Text } from "@cloudflare/kumo/components/text"
import { ArrowDownRightIcon, ArrowUpRightIcon, ChartBarIcon, ChartLineIcon, DotsThreeIcon } from "@phosphor-icons/react"
import { lazy, type ReactNode, Suspense, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useAtomSet } from "@effect/atom-react"
import { loadOlder, type Review, useMoreToLoad } from "../lib/glance.ts"
import { change, type Metric, metric, RANGES, type Range } from "../lib/metrics.ts"
import { SubscriptionUsage } from "./usage.tsx"
import { ReviewsTable } from "./table.tsx"
import { agentName, ago, depthLabel, elapsed, median, report, seconds, StatusBadge, useDarkMode } from "./ui.tsx"

const AreaChart = lazy(() => import("./charts.tsx").then((m) => ({ default: m.AreaChart })))
const Sparkline = lazy(() => import("./charts.tsx").then((m) => ({ default: m.Sparkline })))

const count = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : n.toLocaleString())
const percent = (n: number) => `${n.toFixed(n >= 99.95 || n === 0 ? 0 : 1)}%`
const duration = (ms: number) => seconds(ms)

export const Overview = ({ reviews, now }: { reviews: ReadonlyArray<Review>; now: number }) => {
  const [range, setRange] = useState<Range>("7d")
  const [filter, setFilter] = useState<Review["status"] | "all">("all")
  const finishedTimes = reviews.flatMap((r) => (r.status === "done" && r.durationMs !== null ? [r.durationMs] : []))

  const done = (rs: ReadonlyArray<Review>) => rs.filter((r) => r.status === "done")
  const metrics = {
    reviews: metric(reviews, range, now, (rs) => rs.length),
    time: metric(reviews, range, now, (rs) => median(done(rs).flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]))), { gaps: true }),
    issues: metric(reviews, range, now, (rs) => done(rs).reduce((n, r) => n + r.findings.length, 0)),
    failed: metric(reviews, range, now, (rs) => rs.filter((r) => r.status === "failed").length),
    files: metric(reviews, range, now, (rs) => done(rs).reduce((n, r) => n + r.files, 0)),
    clean: metric(
      reviews,
      range,
      now,
      (rs) => (done(rs).length === 0 ? undefined : (done(rs).filter((r) => r.findings.length === 0).length / done(rs).length) * 100),
      { gaps: true },
    ),
  }

  return (
    <div className="flex flex-col gap-6">
      <LatestCard reviews={reviews} now={now} typical={median(finishedTimes)} />
      <SubscriptionUsage />

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

      <div className="grid gap-4 lg:grid-cols-2">
        <BigCard title="Reviews" metric={metrics.reviews} format={count} good="up" />
        <BigCard title="Median review time" metric={metrics.time} format={duration} good="down" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SmallCard title="Issues found" metric={metrics.issues} format={count} good="none" onShow={() => setFilter("done")} />
        <SmallCard title="Failed reviews" metric={metrics.failed} format={count} good="down" onShow={() => setFilter("failed")} />
        <SmallCard title="Files reviewed" metric={metrics.files} format={count} good="none" />
        <SmallCard title="Clean reviews" metric={metrics.clean} format={percent} good="none" />
      </div>

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

// ---------------------------------------------------------------------------- metric cards

type Good = "up" | "down" | "none"

const Delta = ({ value, good }: { value: number | undefined; good: Good }) => {
  if (value === undefined || !Number.isFinite(value) || Math.abs(value) < 0.05) return null
  const up = value > 0
  const tone = good === "none" ? "text-kumo-subtle" : (good === "up") === up ? "text-kumo-success" : "text-kumo-danger"
  const Icon = up ? ArrowUpRightIcon : ArrowDownRightIcon
  return (
    <span className={`tabular inline-flex items-center gap-0.5 text-base ${tone}`}>
      <Icon size={16} weight="bold" />
      {Math.abs(value).toFixed(1)}%
    </span>
  )
}

const empty = (m: Metric) => m.series.every(([, v]) => v === 0)

/** a quiet wave and a pill: the chart of nothing */
const NoData = ({ height }: { height: number }) => (
  <div className="relative flex items-center justify-center" style={{ height }}>
    <svg className="absolute inset-0 h-full w-full text-kumo-hairline" viewBox="0 0 400 100" preserveAspectRatio="none" aria-hidden>
      <path
        d="M0 55 C 25 45, 40 60, 60 58 S 95 70, 115 62 S 140 30, 150 25 S 170 55, 185 60 S 230 45, 250 52 S 290 70, 310 40 S 345 30, 360 55 S 390 85, 400 60"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
    <span className="relative rounded-full border border-kumo-hairline bg-kumo-base px-3 py-1 text-sm text-kumo-subtle">No data</span>
  </div>
)

const Skeleton = ({ height }: { height: number }) => <div className="animate-pulse rounded-md bg-kumo-recessed" style={{ height }} />

const CardHeader = ({ title, m, format, good, menu }: { title: string; m: Metric; format: (n: number) => string; good: Good; menu: ReactNode }) => (
  <div className="flex items-start justify-between gap-2">
    <div className="flex min-w-0 flex-col gap-1">
      <Text variant="secondary" size="base">
        {title}
      </Text>
      <div className="flex items-baseline gap-2">
        <span className="tabular text-3xl font-semibold tracking-tight text-kumo-strong">
          {m.value === undefined ? (empty(m) ? "0" : "–") : format(m.value)}
        </span>
        <Delta value={change(m)} good={good} />
      </div>
    </div>
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" size="sm" shape="square" icon={<DotsThreeIcon size={18} weight="bold" />} aria-label={`${title} options`} />}
      />
      <DropdownMenu.Content>{menu}</DropdownMenu.Content>
    </DropdownMenu>
  </div>
)

const BigCard = ({ title, metric: m, format, good }: { title: string; metric: Metric; format: (n: number) => string; good: Good }) => {
  const dark = useDarkMode()
  const [type, setType] = useState<"line" | "bar">("line")
  return (
    <LayerCard>
      <LayerCard.Primary className="flex flex-col gap-3">
        <CardHeader
          title={title}
          m={m}
          format={format}
          good={good}
          menu={
            <>
              <DropdownMenu.Item icon={<ChartLineIcon />} selected={type === "line"} onClick={() => setType("line")}>
                Line chart
              </DropdownMenu.Item>
              <DropdownMenu.Item icon={<ChartBarIcon />} selected={type === "bar"} onClick={() => setType("bar")}>
                Bar chart
              </DropdownMenu.Item>
            </>
          }
        />
        {empty(m) ? (
          <NoData height={190} />
        ) : (
          <Suspense fallback={<Skeleton height={190} />}>
            <AreaChart name={title} data={m.series} dark={dark} format={format} type={type} />
          </Suspense>
        )}
      </LayerCard.Primary>
    </LayerCard>
  )
}

const SmallCard = ({
  title,
  metric: m,
  format,
  good,
  onShow,
}: {
  title: string
  metric: Metric
  format: (n: number) => string
  good: Good
  onShow?: () => void
}) => {
  const dark = useDarkMode()
  return (
    <LayerCard className="overflow-hidden">
      <LayerCard.Primary className="flex flex-col gap-3 pb-0">
        <CardHeader
          title={title}
          m={m}
          format={format}
          good={good}
          menu={
            <DropdownMenu.Item
              disabled={!onShow}
              onClick={() => {
                onShow?.()
                document.getElementById("reviews")?.scrollIntoView({ behavior: "smooth" })
              }}
            >
              Show these reviews
            </DropdownMenu.Item>
          }
        />
        <div className="-mx-4">
          {empty(m) ? (
            <NoData height={120} />
          ) : (
            <Suspense fallback={<Skeleton height={120} />}>
              <Sparkline name={title} data={m.series} dark={dark} format={format} />
            </Suspense>
          )}
        </div>
      </LayerCard.Primary>
    </LayerCard>
  )
}

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
