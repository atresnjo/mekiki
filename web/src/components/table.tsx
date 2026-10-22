import { Button } from "@cloudflare/kumo/components/button"
import { DropdownMenu } from "@cloudflare/kumo/components/dropdown"
import { Empty } from "@cloudflare/kumo/components/empty"
import { InputGroup } from "@cloudflare/kumo/components/input-group"
import { LayerCard } from "@cloudflare/kumo/components/layer-card"
import { Pagination } from "@cloudflare/kumo/components/pagination"
import { Select } from "@cloudflare/kumo/components/select"
import { Table } from "@cloudflare/kumo/components/table"
import { Text } from "@cloudflare/kumo/components/text"
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowSquareOutIcon,
  ArrowUpIcon,
  CaretUpDownIcon,
  CopyIcon,
  DotsThreeIcon,
  EyeIcon,
  GitPullRequestIcon,
  MagnifyingGlassIcon,
  StopIcon,
} from "@phosphor-icons/react"
import { useAtomSet } from "@effect/atom-react"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { cancelReview, type Review, retryReview } from "../lib/glance.ts"
import { toasts } from "../lib/toasts.ts"
import { agentName, ago, DEPTHS, depthLabel, elapsed, fail, report, seconds, StatusBadge } from "./ui.tsx"

type Sort = { readonly key: "title" | "result" | "time" | "started"; readonly desc: boolean }

const STATUS_FILTERS = { all: "All results", done: "Reviewed", running: "Reviewing", failed: "Failed", skipped: "Skipped", cancelled: "Cancelled" } as const

const SortHead = ({
  label,
  sortKey,
  sort,
  onSort,
  className = "",
}: {
  label: string
  sortKey: Sort["key"]
  sort: Sort
  onSort: (sort: Sort) => void
  className?: string
}) => {
  const active = sort.key === sortKey
  const Icon = !active ? CaretUpDownIcon : sort.desc ? ArrowDownIcon : ArrowUpIcon
  return (
    <Table.Head className={className}>
      <button
        type="button"
        className="inline-flex items-center gap-1.5 font-medium hover:text-kumo-strong"
        onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : sortKey !== "title" })}
      >
        {label}
        <Icon size={14} className={active ? "text-kumo-default" : "text-kumo-inactive"} />
      </button>
    </Table.Head>
  )
}

/** the row's ⋯ menu */
export const ReviewActions = ({ review, trigger }: { review: Review; trigger?: ReactNode }) => {
  const retry = useAtomSet(retryReview, { mode: "promiseExit" })
  const cancel = useAtomSet(cancelReview, { mode: "promiseExit" })
  const navigate = useNavigate()
  const copy = () =>
    navigator.clipboard.writeText(review.url).then(
      () => toasts.add({ title: "Link copied", variant: "success" }),
      () => fail("couldn't copy the link"),
    )
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          (trigger as React.ReactElement | undefined) ?? (
            <Button variant="ghost" size="sm" shape="square" icon={<DotsThreeIcon size={18} weight="bold" />} aria-label="Review actions" />
          )
        }
      />
      <DropdownMenu.Content>
        <DropdownMenu.Item icon={<EyeIcon />} onClick={() => navigate({ to: "/reviews/$id", params: { id: String(review.id) } })}>
          View review
        </DropdownMenu.Item>
        <DropdownMenu.LinkItem icon={<ArrowSquareOutIcon />} href={review.url} target="_blank">
          Open on GitHub
        </DropdownMenu.LinkItem>
        <DropdownMenu.Item icon={<CopyIcon />} onClick={copy}>
          Copy pull request link
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        <DropdownMenu.Sub>
          <DropdownMenu.SubTrigger icon={ArrowClockwiseIcon}>Review again</DropdownMenu.SubTrigger>
          <DropdownMenu.SubContent>
            {DEPTHS.map((d) => (
              <DropdownMenu.Item
                key={d.value}
                selected={d.value === review.depth}
                onClick={() => retry({ payload: { id: review.id, depth: d.value } }).then((exit) => report(exit, `Reviewing at ${d.label}`))}
              >
                {d.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.SubContent>
        </DropdownMenu.Sub>
        {review.status === "running" && (
          <DropdownMenu.Item
            icon={<StopIcon />}
            variant="danger"
            onClick={() => cancel({ payload: { id: review.id } }).then((exit) => report(exit, "Review cancelled"))}
          >
            Cancel review
          </DropdownMenu.Item>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

export const ReviewsTable = ({
  reviews,
  now,
  filter,
  onFilter,
}: {
  reviews: ReadonlyArray<Review>
  now: number
  filter: Review["status"] | "all"
  onFilter: (filter: Review["status"] | "all") => void
}) => {
  const [query, setQuery] = useState("")
  const [sort, setSort] = useState<Sort>({ key: "started", desc: true })
  const [page, setPage] = useState(1)
  const [perPage, setPerPage] = useState(20)
  const navigate = useNavigate()

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matched = reviews.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (!q || `${r.title} ${r.repo}#${r.number} ${r.agent} ${r.model} ${r.depth} ${r.trigger}`.toLowerCase().includes(q)),
    )
    const value = (r: Review): number | string => {
      switch (sort.key) {
        case "title":
          return (r.title || `#${r.number}`).toLowerCase()
        case "result":
          return r.status === "done" ? r.findings.length : r.status === "failed" ? 1000 : -1
        case "time":
          return elapsed(r, now)
        case "started":
          return r.startedAt
      }
    }
    return [...matched].sort((a, b) => {
      const x = value(a)
      const y = value(b)
      const order = x < y ? -1 : x > y ? 1 : 0
      return sort.desc ? -order : order
    })
  }, [reviews, query, filter, sort, now])

  // a filter or search that shrinks the list shouldn't leave you on an empty page
  const pages = Math.max(1, Math.ceil(rows.length / perPage))
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])
  const visible = rows.slice((page - 1) * perPage, page * perPage)

  return (
    <section id="reviews" className="flex scroll-mt-6 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text variant="heading" as="h2">
          Reviews
        </Text>
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="w-72">
            <InputGroup.Addon>
              <MagnifyingGlassIcon className="text-kumo-subtle" />
            </InputGroup.Addon>
            <InputGroup.Input
              aria-label="Search reviews"
              placeholder="Search..."
              value={query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                setQuery(e.target.value)
                setPage(1)
              }}
            />
          </InputGroup>
          <Select
            aria-label="Filter by result"
            value={filter}
            onValueChange={(v) => {
              onFilter((v ?? "all") as Review["status"] | "all")
              setPage(1)
            }}
            items={STATUS_FILTERS}
          />
        </div>
      </div>

      <LayerCard className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <SortHead label="Pull request" sortKey="title" sort={sort} onSort={setSort} />
                <SortHead label="Result" sortKey="result" sort={sort} onSort={setSort} />
                <Table.Head>Depth</Table.Head>
                <Table.Head>Agent</Table.Head>
                <Table.Head>Trigger</Table.Head>
                <SortHead label="Time" sortKey="time" sort={sort} onSort={setSort} />
                <SortHead label="Started" sortKey="started" sort={sort} onSort={setSort} />
                <Table.Head className="w-12" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {visible.map((r) => (
                <Table.Row key={r.id} className="cursor-pointer" onClick={() => navigate({ to: "/reviews/$id", params: { id: String(r.id) } })}>
                  <Table.Cell className="max-w-[28rem]">
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-kumo-default">{r.title || `#${r.number}`}</span>
                      <span className="truncate text-sm text-kumo-subtle">
                        {r.repo}#{r.number}
                      </span>
                    </div>
                  </Table.Cell>
                  <Table.Cell>
                    <StatusBadge review={r} />
                  </Table.Cell>
                  <Table.Cell>{depthLabel(r.depth)}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{agentName(r)}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap text-kumo-subtle">{r.trigger}</Table.Cell>
                  <Table.Cell className="tabular whitespace-nowrap">
                    {r.status === "running" || r.durationMs !== null ? seconds(elapsed(r, now)) : "—"}
                  </Table.Cell>
                  <Table.Cell className="whitespace-nowrap">{ago(r.startedAt, now)}</Table.Cell>
                  <Table.Cell onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                    <ReviewActions review={r} />
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </div>
        {visible.length === 0 && (
          <div className="py-12">
            <Empty
              size="sm"
              icon={<GitPullRequestIcon size={32} className="text-kumo-inactive" />}
              title={reviews.length === 0 ? "No reviews yet" : "No matching reviews"}
              description={
                reviews.length === 0
                  ? "Paste a pull request link above, or tick a depth in glance's comment on a pull request."
                  : "Try another search or result filter."
              }
            />
          </div>
        )}
      </LayerCard>

      <Pagination page={page} setPage={setPage} perPage={perPage} totalCount={rows.length}>
        <Pagination.Info />
        <Pagination.Separator />
        <Pagination.PageSize
          value={perPage}
          options={[10, 20, 50, 100]}
          onChange={(size: number) => {
            setPerPage(size)
            setPage(1)
          }}
        />
        <Pagination.Controls />
      </Pagination>
    </section>
  )
}
