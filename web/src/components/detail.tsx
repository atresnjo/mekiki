import { Badge } from "@cloudflare/kumo/components/badge"
import { Banner } from "@cloudflare/kumo/components/banner"
import { Breadcrumbs } from "@cloudflare/kumo/components/breadcrumbs"
import { Button } from "@cloudflare/kumo/components/button"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { Empty } from "@cloudflare/kumo/components/empty"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Loader } from "@cloudflare/kumo/components/loader"
import { Text } from "@cloudflare/kumo/components/text"
import { ArrowDown01Icon, ArrowReloadHorizontalIcon, CheckmarkCircle02Icon, LinkSquare02Icon, StopCircleIcon } from "@hugeicons/core-free-icons"
import { Icon } from "./icon.tsx"
import { useAtomSet } from "@effect/atom-react"
import type { ReactNode } from "react"
import { cancelReview, type Finding, type Review, retryReview } from "../lib/mekiki.ts"
import { agentName, ago, DEPTHS, depthLabel, dollars, elapsed, report, seconds, SEVERITY, StatusBadge, tokenCount } from "./ui.tsx"

const Column = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex min-w-0 flex-col gap-1.5">
    <Text bold size="sm">
      {label}
    </Text>
    <div className="min-w-0 text-base text-kumo-default">{children}</div>
  </div>
)

const STEP_TONE = (name: string) => (name.startsWith("review") ? "bg-kumo-brand" : name === "post" ? "bg-kumo-success" : "bg-kumo-fill")

/** where the time went: one segment per step, like a traffic split */
const Timeline = ({ review, now }: { review: Review; now: number }) => {
  const total = Math.max(elapsed(review, now), 1)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-kumo-fill">
        {review.steps.map((s, i) => (
          <div
            key={`${s.name}-${i}`}
            className={`h-full ${STEP_TONE(s.name)} border-r-2 border-kumo-base last:border-r-0`}
            style={{ width: `${(s.ms / total) * 100}%` }}
          />
        ))}
        {review.status === "running" && <div className="h-full flex-1 animate-pulse bg-kumo-brand/40" />}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {review.steps.map((s, i) => (
          <span key={`${s.name}-${i}`} className="inline-flex items-center gap-1.5 text-sm text-kumo-subtle">
            <span className={`size-2 rounded-full ${STEP_TONE(s.name)}`} />
            {s.name} <span className="tabular">{seconds(s.ms)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * what the review's agent calls spent: "≈ $0.14", always an estimate. a subscription cli isn't billed
 * per token, so there it's what the same tokens would cost on an API key
 */
const cost = (review: Review): { label: string; value: string; note?: string; title?: string } => {
  const usage = review.usage
  if (!usage) return { label: "Cost", value: "—" }
  const tokens = `${tokenCount(usage.inputTokens)} in · ${tokenCount(usage.outputTokens)} out`
  const subscription = review.agent !== "api"
  return {
    label: subscription ? "Cost at API prices" : "Cost",
    value: usage.costUsd === null ? "—" : `≈ ${dollars(usage.costUsd)}`,
    note: usage.costUsd === null ? `${tokens} · no price for this model` : `${tokens} · estimate`,
    title: `${usage.inputTokens} input tokens (${usage.cachedInputTokens} cached), ${usage.outputTokens} output, over ${usage.calls} model call${usage.calls === 1 ? "" : "s"}. An estimate from the price table${subscription ? "; the subscription isn't billed per token" : ""}.`,
  }
}

const FindingRow = ({ finding, url }: { finding: Finding; url: string }) => {
  const severity = SEVERITY[finding.severity]
  return (
    <div className="flex flex-col gap-2 px-4 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={severity.variant}>{severity.label}</Badge>
        <Badge variant="outline">{finding.category}</Badge>
        <a href={`${url}/files`} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-sm text-kumo-subtle hover:text-kumo-link">
          {finding.path}:{finding.line}
        </a>
        <span className="tabular ml-auto text-sm text-kumo-subtle">{Math.round(finding.confidence * 100)}% confident</span>
      </div>
      <Text bold>{finding.title}</Text>
      <Text variant="secondary">{finding.body}</Text>
      {finding.suggestion !== null && (
        <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed px-3 py-2 font-mono text-sm text-kumo-default">
          {finding.suggestion}
        </pre>
      )}
    </div>
  )
}

export const ReviewPage = ({ review, now }: { review: Review | undefined; now: number }) => {
  const retry = useAtomSet(retryReview, { mode: "promiseExit" })
  const cancel = useAtomSet(cancelReview, { mode: "promiseExit" })

  if (!review)
    return (
      <div className="flex flex-col gap-6">
        <Breadcrumbs>
          <Breadcrumbs.Link href="/">Reviews</Breadcrumbs.Link>
          <Breadcrumbs.Separator />
          <Breadcrumbs.Current>Not found</Breadcrumbs.Current>
        </Breadcrumbs>
        <LayerCard className="py-12">
          <Empty title="No such review" description="It may have been made by another mekiki, or the link is wrong." />
        </LayerCard>
      </div>
    )

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumbs>
        <Breadcrumbs.Link href="/">Reviews</Breadcrumbs.Link>
        <Breadcrumbs.Separator />
        <Breadcrumbs.Current>
          {review.repo}#{review.number}
        </Breadcrumbs.Current>
      </Breadcrumbs>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <Text variant="heading" size="lg" as="h1">
            {review.title || `#${review.number}`}
          </Text>
          <Text variant="secondary">
            {review.repo}#{review.number} · {agentName(review)}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {review.status === "running" && (
            <Button
              variant="secondary-destructive"
              icon={<Icon icon={StopCircleIcon} />}
              onClick={() => cancel({ payload: { id: review.id } }).then((exit) => report(exit, "Review cancelled"))}
            >
              Cancel
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenu.Trigger
              render={
                <Button variant="secondary" icon={<Icon icon={ArrowReloadHorizontalIcon} />}>
                  Review again <Icon icon={ArrowDown01Icon} size={14} />
                </Button>
              }
            />
            <DropdownMenu.Content>
              {DEPTHS.map((d) => (
                <DropdownMenu.Item
                  key={d.value}
                  selected={d.value === review.depth}
                  onClick={() => retry({ payload: { id: review.id, depth: d.value } }).then((exit) => report(exit, `Reviewing at ${d.label}`))}
                >
                  <span className="flex flex-col">
                    <span>{d.label}</span>
                    <span className="text-xs text-kumo-subtle">{d.hint}</span>
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
          <a href={review.url} target="_blank" rel="noreferrer">
            <Button variant="primary" icon={<Icon icon={LinkSquare02Icon} />}>
              Open on GitHub
            </Button>
          </a>
        </div>
      </div>

      <LayerCard>
        <LayerCard.Secondary>Review</LayerCard.Secondary>
        <LayerCard.Primary className="grid grid-cols-2 gap-x-8 gap-y-5 md:grid-cols-[auto_auto_auto_auto_minmax(0,1fr)_auto]">
          <Column label="Result">
            <StatusBadge review={review} />
          </Column>
          <Column label="Commit">
            <span className="font-mono text-sm">{review.headSha ? review.headSha.slice(0, 8) : "—"}</span>
          </Column>
          <Column label="Started">{ago(review.startedAt, now)}</Column>
          <Column label="Depth">{depthLabel(review.depth)}</Column>
          <div className="col-span-2 md:col-span-1">
            <Column label="Timeline">
              <Timeline review={review} now={now} />
            </Column>
          </div>
          <Column label="Time">
            <span className="tabular text-xl font-semibold text-kumo-strong">{seconds(elapsed(review, now))}</span>
          </Column>
        </LayerCard.Primary>
      </LayerCard>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        {[
          { label: "Files reviewed", value: review.files > 0 ? String(review.files) : "—" },
          { label: "Files skipped", value: String(review.skippedFiles) },
          { label: "Agent calls", value: review.chunks > 0 ? String(review.chunks) : "—" },
          { label: "Scope", value: review.incremental ? "New commits" : "Whole pull request" },
          cost(review),
        ].map(({ label, value, note, title }) => (
          <LayerCard key={label}>
            <LayerCard.Primary className="flex flex-col gap-1" title={title}>
              <Text variant="secondary">{label}</Text>
              <span className="tabular text-2xl font-semibold text-kumo-strong">{value}</span>
              {note && <span className="tabular text-xs text-kumo-subtle">{note}</span>}
            </LayerCard.Primary>
          </LayerCard>
        ))}
      </div>

      {review.error && (
        <Banner
          variant={review.status === "failed" ? "error" : "alert"}
          title={review.status === "failed" ? "Review failed" : "Partly reviewed"}
          description={review.error}
        />
      )}

      {review.summary && (
        <LayerCard>
          <LayerCard.Secondary>{review.status === "skipped" ? "Skipped" : "Summary"}</LayerCard.Secondary>
          <LayerCard.Primary>
            <Text as="p">{review.summary}</Text>
          </LayerCard.Primary>
        </LayerCard>
      )}

      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between">
          <span>Findings</span>
          {review.findings.length > 0 && <span className="tabular text-kumo-subtle">{review.findings.length}</span>}
        </LayerCard.Secondary>
        <LayerCard.Primary className="p-0">
          {review.findings.length > 0 ? (
            <div className="divide-y divide-kumo-hairline">
              {review.findings.map((f, i) => (
                <FindingRow key={`${f.path}:${f.line}:${i}`} finding={f} url={review.url} />
              ))}
            </div>
          ) : review.status === "running" ? (
            <div className="flex items-center gap-3 px-4 py-8">
              <Loader size="sm" /> <Text variant="secondary">The agent is reading the diff…</Text>
            </div>
          ) : review.status === "done" ? (
            <div className="flex items-center gap-2 px-4 py-8 text-kumo-success">
              <Icon icon={CheckmarkCircle02Icon} size={18} strokeWidth={2} /> <Text>No issues worth a comment.</Text>
            </div>
          ) : (
            <div className="px-4 py-8">
              <Text variant="secondary">No findings.</Text>
            </div>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </div>
  )
}
