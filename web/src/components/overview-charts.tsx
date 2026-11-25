// the overview's charts, from the mebius charts kit: each card is a kit block fed review numbers. loaded on their own
// after the page (animejs and the radix primitives the cards use are most of their weight)
import { Alert02Icon, AiBrain01Icon, CheckmarkCircle02Icon, GitBranchIcon } from "@hugeicons/core-free-icons"
import { BalanceChart, type BalanceYear } from "./balance-chart.tsx"
import { FinancialBreakdownChart, type FinancialBreakdownPoint, type FinancialBreakdownSeries } from "./financial-breakdown-chart.tsx"
import { Icon } from "./icon.tsx"
import { ClockIcon } from "./ui/chart-icons.tsx"
import { NetWorthChart } from "./net-worth-chart.tsx"
import { TotalExpensesChart, type TotalExpensesPeriod } from "./total-expenses-chart.tsx"
import { TotalValueChart, type TotalValueList, type TotalValueListItem, type TotalValueRange, type TotalValueTone } from "./total-value-chart.tsx"
import { AGENT_NAMES, median, seconds } from "./ui.tsx"
import type { Review, Severity } from "../lib/mekiki.ts"
import { type Bucket, buckets, change, countTicks, inWindow, RANGE_KEYS, RANGES, type Range } from "../lib/metrics.ts"

type Filter = Review["status"] | "all"

const count = (n: number) => Math.round(n).toLocaleString()
const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : count(n))
const rate = (n: number) => (n >= 99.95 || n <= 0.05 ? Math.round(n).toString() : n.toFixed(1))
const BEFORE = "vs prior period"

// a hairline like kumo's cards, so the white cards don't melt into a light canvas
const CARD = "ring-1 ring-kumo-hairline"

const done = (rs: ReadonlyArray<Review>) => rs.filter((r) => r.status === "done")
const durations = (rs: ReadonlyArray<Review>) => done(rs).flatMap((r) => (r.durationMs === null ? [] : [r.durationMs]))
const issues = (rs: ReadonlyArray<Review>) => done(rs).reduce((n, r) => n + r.findings.length, 0)
const failed = (rs: ReadonlyArray<Review>) => rs.filter((r) => r.status === "failed").length
const files = (rs: ReadonlyArray<Review>) => done(rs).reduce((n, r) => n + r.files, 0)
const clean = (rs: ReadonlyArray<Review>) => done(rs).filter((r) => r.findings.length === 0).length
const withIssues = (rs: ReadonlyArray<Review>) => done(rs).filter((r) => r.findings.length > 0).length
const cleanRate = (rs: ReadonlyArray<Review>) => (done(rs).length === 0 ? undefined : (clean(rs) / done(rs).length) * 100)

/** the bars' dates are their start times; the charts ask for the label under a bar and the title in its tooltip */
const dateFormat = (bs: ReadonlyArray<Bucket>) => {
  const byStart = new Map(bs.map((b) => [String(b.start), b]))
  return (date: string, context: "axis" | "tooltip") => {
    const b = byStart.get(date)
    return b ? (context === "axis" ? b.label : b.title) : date
  }
}

/** a list's rows: one per key (a repo, an agent), the largest first, with the change against the window before */
const rowsBy = (
  current: ReadonlyArray<Review>,
  previous: ReadonlyArray<Review>,
  key: (r: Review) => string,
  measure: (rs: ReadonlyArray<Review>) => number,
  row: (key: string, rs: ReadonlyArray<Review>) => Pick<TotalValueListItem, "name" | "icon" | "tone">,
): TotalValueListItem[] => {
  const groups = Map.groupBy(current, key)
  const before = Map.groupBy(previous, key)
  return [...groups]
    .map(([k, rs]) => ({ k, rs, amount: measure(rs) }))
    .filter(({ amount }) => amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map(({ k, rs, amount }) => ({
      id: k,
      caption: `${rs.length} review${rs.length === 1 ? "" : "s"}`,
      amount,
      change: change(amount, measure(before.get(k) ?? [])),
      changeLabel: BEFORE,
      ...row(k, rs),
    }))
}

const repoRow = (repo: string) => ({ name: repo, icon: <Icon icon={GitBranchIcon} />, tone: "blue" as const })
const agentRow = (agent: string) => ({ name: AGENT_NAMES[agent as Review["agent"]] ?? agent, icon: <Icon icon={AiBrain01Icon} />, tone: "purple" as const })

const SEVERITIES: ReadonlyArray<{ value: Severity; label: string; tone: TotalValueTone }> = [
  { value: "critical", label: "Critical", tone: "red" },
  { value: "high", label: "High", tone: "orange" },
  { value: "medium", label: "Medium", tone: "purple" },
  { value: "low", label: "Low", tone: "blue" },
]

const severityRows = (current: ReadonlyArray<Review>, previous: ReadonlyArray<Review>): TotalValueListItem[] => {
  const tally = (rs: ReadonlyArray<Review>, s: Severity) => done(rs).reduce((n, r) => n + r.findings.filter((f) => f.severity === s).length, 0)
  return SEVERITIES.map((s) => {
    const amount = tally(current, s.value)
    const reviews = done(current).filter((r) => r.findings.some((f) => f.severity === s.value)).length
    return {
      id: s.value,
      name: s.label,
      caption: `in ${reviews} review${reviews === 1 ? "" : "s"}`,
      amount,
      change: change(amount, tally(previous, s.value)),
      changeLabel: BEFORE,
      icon: <Icon icon={Alert02Icon} />,
      tone: s.tone,
    }
  })
}

/** a total-value card's data: the number over each range, its bars and its lists */
const counted = (
  reviews: ReadonlyArray<Review>,
  range: Range,
  now: number,
  measure: (rs: ReadonlyArray<Review>) => number,
  lists: (current: ReadonlyArray<Review>, previous: ReadonlyArray<Review>) => TotalValueList[],
) => {
  const { current, previous } = inWindow(reviews, range, now)
  const value = measure(current)
  const before = measure(previous)
  const ranges: TotalValueRange[] = RANGE_KEYS.map((k) => ({
    value: k,
    label: RANGES[k].short,
    bars: buckets(reviews, k, now, "coarse").map((b) => ({ label: b.label, value: measure(b.reviews) })),
  }))
  return { value, change: { amount: value - before, percent: change(value, before), label: BEFORE }, ranges, lists: lists(current, previous) }
}

export default function OverviewCharts({
  reviews,
  now,
  range,
  onRange,
  onShow,
}: {
  reviews: ReadonlyArray<Review>
  now: number
  range: Range
  onRange: (range: Range) => void
  onShow: (filter: Filter) => void
}) {
  const setRange = (next: string) => onRange(next as Range)
  const { current } = inWindow(reviews, range, now)

  // reviews: a bar per hour or day
  const fine = buckets(reviews, range, now, "fine")
  const perBucket = fine.map((b) => ({ date: String(b.start), value: b.reviews.length }))

  // median review time: a point per bucket that has a finished review
  const times: BalanceYear[] = RANGE_KEYS.map((k) => {
    const w = inWindow(reviews, k, now)
    const total = median(durations(w.current))
    const before = median(durations(w.previous))
    return {
      value: k,
      label: RANGES[k].label,
      total: total ?? 0,
      change: total !== undefined && before !== undefined ? total - before : undefined,
      changeLabel: BEFORE,
      months: buckets(reviews, k, now, "coarse").flatMap((b) => {
        const m = median(durations(b.reviews))
        return m === undefined ? [] : [{ label: b.label, value: m }]
      }),
    }
  })

  const issueCard = counted(reviews, range, now, issues, (c, p) => [
    { value: "severity", label: "Severity", items: severityRows(c, p) },
    { value: "repos", label: "Repos", items: rowsBy(done(c), done(p), (r) => r.repo, issues, repoRow) },
  ])
  const failedCard = counted(reviews, range, now, failed, (c, p) => [
    { value: "repos", label: "Repos", items: rowsBy(c, p, (r) => r.repo, failed, repoRow) },
    { value: "agents", label: "Agents", items: rowsBy(c, p, (r) => r.agent, failed, agentRow) },
  ])
  const filesCard = counted(reviews, range, now, files, (c, p) => [
    { value: "repos", label: "Repos", items: rowsBy(done(c), done(p), (r) => r.repo, files, repoRow) },
    { value: "agents", label: "Agents", items: rowsBy(done(c), done(p), (r) => r.agent, files, agentRow) },
  ])

  // clean reviews: the share of finished reviews with nothing to say, and what the others were
  const quality: TotalExpensesPeriod[] = RANGE_KEYS.map((k) => {
    const w = inWindow(reviews, k, now)
    const total = cleanRate(w.current)
    const before = cleanRate(w.previous)
    const bs = buckets(reviews, k, now, "coarse")
    return {
      value: k,
      label: RANGES[k].label,
      total: total ?? 0,
      // in points, not percent of a percent
      change: total !== undefined && before !== undefined ? total - before : undefined,
      changeLabel: BEFORE,
      categories: [
        {
          id: "clean",
          label: "Clean",
          amount: clean(w.current),
          change: change(clean(w.current), clean(w.previous)),
          changeLabel: BEFORE,
          good: "up",
          color: "green",
        },
        {
          id: "issues",
          label: "With issues",
          amount: withIssues(w.current),
          change: change(withIssues(w.current), withIssues(w.previous)),
          changeLabel: BEFORE,
          good: "none",
          color: "orange",
        },
        {
          id: "failed",
          label: "Failed",
          amount: failed(w.current),
          change: change(failed(w.current), failed(w.previous)),
          changeLabel: BEFORE,
          good: "down",
          color: "red",
        },
      ],
      points: bs.flatMap((b, i) => {
        const value = cleanRate(b.reviews)
        return value === undefined ? [] : [{ x: (i + 0.5) / bs.length, value, label: b.label }]
      }),
      axis: bs.map((b) => b.label),
    }
  })

  // results per bar, stacked
  const series: FinancialBreakdownSeries[] = [
    { key: "clean", label: "Clean", color: "green" },
    { key: "issues", label: "With issues", color: "orange" },
    { key: "failed", label: "Failed", color: "red" },
  ]
  const results: FinancialBreakdownPoint[] = fine.map((b) => ({
    date: String(b.start),
    values: { clean: clean(b.reviews), issues: withIssues(b.reviews), failed: failed(b.reviews) },
  }))
  const resultsMax = Math.max(0, ...results.map((p) => Object.values(p.values).reduce((a, b) => a + b, 0)))

  const show = (filter: Filter) => () => {
    onShow(filter)
    document.getElementById("reviews")?.scrollIntoView({ behavior: "smooth" })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-5">
        {/* a new range remounts the bar charts: they open on the latest bar, and the bars grow in again */}
        <NetWorthChart
          key={range}
          className={`${CARD} xl:col-span-3`}
          title="Reviews"
          total={current.length}
          totalLabel={RANGES[range].label}
          data={perBucket}
          ticks={countTicks(Math.max(0, ...perBucket.map((p) => p.value)))}
          formatDate={dateFormat(fine)}
          format={count}
          formatTick={compact}
          viewDataLabel="View reviews"
          onViewDataClick={show("all")}
        />
        <BalanceChart
          className={`${CARD} xl:col-span-2`}
          title="Median review time"
          icon={<ClockIcon />}
          totalLabel="Median, finished reviews"
          valueLabel="median"
          monthChangeLabel="vs previous"
          emptyText="No finished reviews"
          years={times}
          year={range}
          onYearChange={setRange}
          good="down"
          format={seconds}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <TotalValueChart
          className={`${CARD} h-[440px]`}
          title="Issues found"
          {...issueCard}
          range={range}
          onRangeChange={setRange}
          good="none"
          format={count}
          emptyText="No issues in this range"
          onMoreClick={show("done")}
          moreLabel="Show these reviews"
        />
        <TotalValueChart
          className={`${CARD} h-[440px]`}
          title="Failed reviews"
          {...failedCard}
          range={range}
          onRangeChange={setRange}
          good="down"
          format={count}
          emptyText="Nothing failed in this range"
          onMoreClick={show("failed")}
          moreLabel="Show these reviews"
        />
        <TotalValueChart
          className={`${CARD} h-[440px]`}
          title="Files reviewed"
          {...filesCard}
          range={range}
          onRangeChange={setRange}
          good="none"
          format={count}
          emptyText="No files reviewed in this range"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-5">
        <TotalExpensesChart
          className={`${CARD} xl:col-span-2`}
          eyebrow="Quality"
          title="Clean reviews"
          icon={<Icon icon={CheckmarkCircle02Icon} size={20} />}
          periods={quality}
          period={range}
          onPeriodChange={setRange}
          max={100}
          format={count}
          formatPoint={(n) => `${rate(n)}%`}
          formatParts={(n) => ({ symbol: "%", number: rate(n), symbolFirst: false })}
        />
        <FinancialBreakdownChart
          key={range}
          className={`${CARD} xl:col-span-3`}
          title="Review results"
          series={series}
          data={results}
          ticks={countTicks(resultsMax)}
          formatDate={dateFormat(fine)}
          format={count}
          formatTick={compact}
          viewDataLabel="View reviews"
          onViewDataClick={show("all")}
        />
      </div>
    </div>
  )
}
