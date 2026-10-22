import { Schema } from "effect"

export const AgentKind = Schema.Literals(["claude", "codex"])
export type AgentKind = typeof AgentKind.Type

/** how hard the agent thinks: the one knob between a quick pass and a thorough one */
export const Depth = Schema.Literals(["light", "medium", "high"])
export type Depth = typeof Depth.Type

/** the reasoning effort each depth runs at, in both CLIs */
export const EFFORT: Record<Depth, "low" | "medium" | "high"> = { light: "low", medium: "medium", high: "high" }

/** a depth named in a label or comment: `glance:high`, `glance-light`, `/glance medium` */
export const depthIn = (text: string): Depth | undefined => {
  const m = text.match(/(?:^|[\s/@])glance(?:[:/ -]|\s+)(light|medium|high)\b/i)
  return m?.[1] ? (m[1].toLowerCase() as Depth) : undefined
}

export const Severity = Schema.Literals(["critical", "high", "medium", "low"])
export type Severity = typeof Severity.Type

export const Category = Schema.Literals(["bug", "security", "performance", "reliability", "maintainability"])
export type Category = typeof Category.Type

/** one review comment, as the model is asked to produce it */
export const Finding = Schema.Struct({
  path: Schema.String,
  line: Schema.Int,
  severity: Severity,
  category: Category,
  title: Schema.String,
  body: Schema.String,
  /** replacement for exactly `line`, or null */
  suggestion: Schema.NullOr(Schema.String),
  confidence: Schema.Finite,
})
export interface Finding extends Schema.Schema.Type<typeof Finding> {}

/** what one agent call returns: its JSON schema is handed to the CLI */
export const ChunkReview = Schema.Struct({
  summary: Schema.String,
  findings: Schema.Array(Finding),
})
export interface ChunkReview extends Schema.Schema.Type<typeof ChunkReview> {}

export const Settings = Schema.Struct({
  agent: AgentKind,
  /** empty: the CLI's own default */
  model: Schema.String,
  depth: Depth,
  /** when a pull request opens: review it right away, or post the depth checkboxes and wait for a tick */
  mode: Schema.Literals(["ask", "auto"]),
  postComments: Schema.Boolean,
  maxFindings: Schema.Finite,
  minConfidence: Schema.Finite,
})
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

export const ReviewStatus = Schema.Literals(["running", "done", "failed", "cancelled", "skipped"])
export type ReviewStatus = typeof ReviewStatus.Type

export const Step = Schema.Struct({ name: Schema.String, ms: Schema.Finite })
export interface Step extends Schema.Schema.Type<typeof Step> {}

export const Review = Schema.Struct({
  id: Schema.Finite,
  repo: Schema.String,
  number: Schema.Finite,
  title: Schema.String,
  url: Schema.String,
  headSha: Schema.String,
  agent: AgentKind,
  model: Schema.String,
  depth: Depth,
  status: ReviewStatus,
  trigger: Schema.String,
  /** reviewed, but nothing posted */
  dryRun: Schema.Boolean,
  incremental: Schema.Boolean,
  posted: Schema.Boolean,
  files: Schema.Finite,
  skippedFiles: Schema.Finite,
  chunks: Schema.Finite,
  startedAt: Schema.Finite,
  durationMs: Schema.NullOr(Schema.Finite),
  summary: Schema.String,
  findings: Schema.Array(Finding),
  steps: Schema.Array(Step),
  error: Schema.NullOr(Schema.String),
})
export interface Review extends Schema.Schema.Type<typeof Review> {}

/** owner/repo#number */
export interface PrRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export const prKey = (pr: PrRef) => `${pr.owner}/${pr.repo}#${pr.number}`

export const parsePrUrl = (input: string): PrRef | undefined => {
  const m = input.trim().match(/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/) ?? input.trim().match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/)
  return m?.[1] && m[2] && m[3] ? { owner: m[1], repo: m[2], number: Number(m[3]) } : undefined
}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  agent: AgentKind,
  message: Schema.String,
}) {}

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  operation: Schema.String,
  status: Schema.optional(Schema.Finite),
  message: Schema.String,
}) {}
