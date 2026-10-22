// the contract between the dashboard (web/) and the server: every call, its input, output and errors.
// both sides import this; the server implements it (rpc-server.ts), the dashboard calls it through an
// atom-backed client (web/src/lib/glance.ts). transport: http + ndjson at RPC_PATH.
//
// not in here, on purpose: the github webhook (plain http, guarded by its signature)
import { Duration, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"
import { Depth, Review, Settings } from "./domain.ts"

// what the dashboard shows comes from the domain
export { Depth, Finding, Review, Settings, Severity } from "./domain.ts"

/** where the server mounts the rpc endpoint */
export const RPC_PATH = "/api/rpc"

/** how often the review stream says it's still there */
export const HEARTBEAT = Duration.seconds(20)

// ---------- errors ----------

/** the review the call names doesn't exist */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { message: Schema.String }) {}

/** the input can't be used as it is */
export class Invalid extends Schema.TaggedError<Invalid>()("Invalid", { message: Schema.String }) {}

/** glance tried and failed: the details are in the server's log */
export class Failed extends Schema.TaggedError<Failed>()("Failed", { message: Schema.String }) {}

/** every way a call can be refused or fail */
export const ApiError = Schema.Union([NotFound, Invalid, Failed])
export type ApiError = typeof ApiError.Type

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", { message: Schema.String }) {}

// ---------- auth: with a token set, every call carries the session cookie POST /api/session gave ----------

export class Authenticated extends RpcMiddleware.Service<Authenticated>()("@glance/api/Authenticated", {
  error: Unauthorized,
}) {}

// ---------- views ----------

export const Model = Schema.Struct({ id: Schema.String, label: Schema.String })
export interface Model extends Schema.Schema.Type<typeof Model> {}

export const Models = Schema.Struct({ claude: Schema.Array(Model), codex: Schema.Array(Model) })
export interface Models extends Schema.Schema.Type<typeof Models> {}

export const Status = Schema.Struct({
  /** the version each cli reports, or null when it isn't installed or logged in */
  agents: Schema.Struct({ claude: Schema.NullOr(Schema.String), codex: Schema.NullOr(Schema.String) }),
  webhook: Schema.Boolean,
  /** signing in is on: the dashboard offers to sign out */
  auth: Schema.Boolean,
})
export interface Status extends Schema.Schema.Type<typeof Status> {}

/**
 * what the live stream carries: the recent reviews first, then each review as it changes, and a
 * heartbeat every HEARTBEAT, so a connection a proxy left hanging shows as silence. a second
 * snapshot means it reconnected: what happened in between wasn't heard, the snapshot has it
 */
export const ReviewsEvent = Schema.TaggedUnion({
  Snapshot: { reviews: Schema.Array(Review) },
  Changed: { review: Review },
  Heartbeat: {},
})
export type ReviewsEvent = typeof ReviewsEvent.Type

// ---------- calls ----------

/** how many reviews the live stream's snapshot holds; older ones come a page at a time */
export const PAGE = 200

export class GlanceRpcs extends RpcGroup.make(
  Rpc.make("WatchReviews", { success: ReviewsEvent, error: ApiError, stream: true }),
  /** the reviews before `before` (an id), newest first: what the live stream's snapshot doesn't hold */
  Rpc.make("ListReviews", { payload: { before: Schema.Finite }, success: Schema.Array(Review), error: ApiError }),
  Rpc.make("StartReview", {
    payload: { url: Schema.String, dryRun: Schema.Boolean, depth: Schema.optional(Depth) },
    error: ApiError,
  }),
  /** review the same pull request again, at another depth if one is given */
  Rpc.make("RetryReview", { payload: { id: Schema.Finite, depth: Schema.optional(Depth) }, error: ApiError }),
  Rpc.make("CancelReview", { payload: { id: Schema.Finite }, error: ApiError }),
  Rpc.make("GetStatus", { success: Status, error: ApiError }),
  Rpc.make("GetSettings", { success: Settings, error: ApiError }),
  /** only a model the chosen cli offers */
  Rpc.make("SaveSettings", { payload: Settings, success: Settings, error: ApiError }),
  Rpc.make("GetModels", { success: Models, error: ApiError }),
).middleware(Authenticated) {}
