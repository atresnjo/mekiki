// stand-ins the pages render from while the feed connects: skullet lays them out unseen and draws the
// skeleton from them, so it takes the space the real page will. their text is never shown, only measured
import type { Finding, Review } from "./glance.ts"

const HOUR = 3_600_000
const now = Date.now()

const finding = (severity: Finding["severity"], category: Finding["category"], title: string, body: string): Finding => ({
  path: "src/components/review-panel.tsx",
  line: 128,
  severity,
  category,
  title,
  body,
  suggestion: null,
  confidence: 0.86,
})

const review = (id: number, hoursAgo: number, title: string, findings: ReadonlyArray<Finding>): Review => ({
  id,
  repo: "acme/dashboard",
  number: 1200 + id,
  title,
  url: `https://github.com/acme/dashboard/pull/${1200 + id}`,
  headSha: "3f9c2a7be41d",
  agent: "claude",
  model: "claude-sonnet-5-5",
  depth: "medium",
  status: "done",
  trigger: "webhook",
  dryRun: false,
  incremental: false,
  posted: true,
  files: 12,
  skippedFiles: 1,
  chunks: 2,
  startedAt: now - hoursAgo * HOUR,
  durationMs: 48_000,
  summary: "Tidy change overall; one missed null check on the empty state and a query that runs once per row.",
  findings,
  unreviewed: [],
  steps: [
    { name: "checkout", ms: 6_000 },
    { name: "review", ms: 38_000 },
    { name: "post", ms: 4_000 },
  ],
  error: null,
  usage: { calls: 2, inputTokens: 48_200, cachedInputTokens: 12_000, outputTokens: 3_400, costUsd: 0.14 },
})

const FINDINGS = [
  finding(
    "high",
    "bug",
    "The empty state reads a review that isn't there",
    "When the list is empty this indexes the first row anyway and throws before the placeholder renders.",
  ),
  finding("medium", "performance", "One query per row", "Each row fetches its author separately; loading them together keeps the page to one round trip."),
]

export const SAMPLE_REVIEWS: ReadonlyArray<Review> = [
  review(8, 2, "Show the review summary above the findings", FINDINGS),
  review(7, 9, "Retry webhook deliveries that time out", []),
  review(6, 20, "Move repository settings into their own table", FINDINGS.slice(0, 1)),
  review(5, 30, "Cache the model list for the settings dialog", []),
  review(4, 52, "Paginate older reviews", FINDINGS),
  review(3, 75, "Add a dark mode to the charts", []),
  review(2, 100, "Sign in with the company's SSO", FINDINGS.slice(1)),
  review(1, 130, "Count tokens per agent call", []),
]

export const SAMPLE_REVIEW = SAMPLE_REVIEWS[0] as Review
