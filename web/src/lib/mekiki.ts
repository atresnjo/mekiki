// mekiki's server, as atoms. reads are query atoms keyed for reactivity; writes are mutations that
// invalidate what they change; the review feed follows the server's stream, reconnecting
import { useAtomValue } from "@effect/atom-react"
import { MekikiRpcs, HEARTBEAT, PAGE, RPC_PATH, type Review, type ReviewsEvent } from "@mekiki/api"
import { Cause, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/http"
import { AsyncResult, Atom, AtomRpc } from "effect/reactivity"
import { RpcClient, RpcSerialization } from "effect/rpc"

export type { Depth, Finding, Models, ProviderUsage, RepoSettings, Review, Settings, Severity, Status, User } from "@mekiki/api"
export { isLogin, isRepo, LIST_MAX, repoIn, repoSettings, RULES_MAX } from "@mekiki/api"

// the api lives on this origin: vite forwards /api/ to it in dev, a reverse proxy does in production

// signing in is better auth's, over plain http (lib/auth.ts): its session cookie goes along with every call

// ---------- client ----------

export class Mekiki extends AtomRpc.Service<Mekiki>()("Mekiki", {
  group: MekikiRpcs,
  // the session cookie goes along on its own: same origin
  protocol: RpcClient.layerProtocolHttp({ url: new URL(RPC_PATH, window.location.origin).href }).pipe(
    Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
  ),
}) {}

// ---------- reads ----------

export const usageAtom = Mekiki.query("GetUsage", undefined)
export const statusAtom = Mekiki.query("GetStatus", undefined)
/** the model lists cost the server a process spawn: mounted only by the settings dialog */
export const modelsAtom = Mekiki.query("GetModels", undefined)
export const settingsAtom = Mekiki.query("GetSettings", undefined, { reactivityKeys: ["settings"] })
export const repoSettingsAtom = Mekiki.query("GetRepoSettings", undefined, { reactivityKeys: ["settings"] })
/** what adding a repository suggests: mounted only by the settings dialog */
/** what adding a repository suggests: where mekiki is installed, and what it has reviewed */
export const reposAtom = Mekiki.query("GetRepos", undefined)

// ---------- writes: run with useAtomSet(…, { mode: "promiseExit" }), which keeps which error it was ----------

export const startReview = Mekiki.mutation("StartReview")
export const retryReview = Mekiki.mutation("RetryReview")
export const cancelReview = Mekiki.mutation("CancelReview")
/** run with reactivityKeys ["settings"]: the settings on screen load again */
export const saveSettings = Mekiki.mutation("SaveSettings")
export const saveRepoSettings = Mekiki.mutation("SaveRepoSettings")
export const deleteRepoSettings = Mekiki.mutation("DeleteRepoSettings")

// every way a call fails has a message: its own errors, Unauthorized, the rpc client's
export type Failure = { readonly message: string }

/** what went wrong, for people: the call's own error, else the first defect */
export const causeMessage = (cause: Cause.Cause<Failure>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: (e) => e.message,
    onNone: () => Cause.prettyErrors(cause)[0]?.message ?? "something went wrong",
  })

/** the value once it's there (kept while it refreshes), else undefined */
export const useValue = <A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>) => Option.getOrUndefined(AsyncResult.value(useAtomValue(atom)))

// ---------- the review feed ----------

export type Feed =
  | { readonly _tag: "Live" | "Reconnecting"; readonly reviews: ReadonlyArray<Review> }
  /** the server wants someone signed in, and nobody is (or they're no longer allowed in) */
  | { readonly _tag: "Locked" }

type FeedStep = Exclude<ReviewsEvent, { readonly _tag: "Heartbeat" }> | { readonly _tag: "Dropped" } | { readonly _tag: "Unauthorized" }

/** the stream ended, or went quiet for longer than heartbeats allow: the connection is gone, though nothing failed */
class Disconnected extends Schema.TaggedError<Disconnected>()("Disconnected", { message: Schema.String }) {}

const step = (feed: Feed, event: FeedStep): Feed => {
  const reviews = feed._tag === "Locked" ? [] : feed.reviews
  switch (event._tag) {
    case "Snapshot":
      return { _tag: "Live", reviews: event.reviews }
    case "Changed":
      return { _tag: "Live", reviews: [event.review, ...reviews.filter((r) => r.id !== event.review.id)].sort((a, b) => b.id - a.id) }
    case "Dropped":
      return { _tag: "Reconnecting", reviews }
    case "Unauthorized":
      return { _tag: "Locked" }
  }
}

/** every review, kept current by the server's stream. a dropped connection is tried again; the new snapshot has what was missed */
export const feedAtom = Mekiki.runtime.atom(
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* Mekiki
      return client("WatchReviews", undefined)
    }),
  ).pipe(
    Stream.timeoutOrElse({
      duration: Duration.times(HEARTBEAT, 2.25),
      orElse: () => Stream.fail(new Disconnected({ message: "the server went quiet" })),
    }),
    Stream.concat(Stream.fail(new Disconnected({ message: "the server ended the stream" }))),
    Stream.filter((event) => event._tag !== "Heartbeat"),
    Stream.catchTag("Unauthorized", () => Stream.succeed<FeedStep>({ _tag: "Unauthorized" })),
    Stream.catchTag(["RpcClientError", "Disconnected"], (error) => Stream.succeed<FeedStep>({ _tag: "Dropped" }).pipe(Stream.concat(Stream.fail(error)))),
    Stream.retry(Schedule.spaced("2 seconds")),
    Stream.scan<Feed, FeedStep>(() => ({ _tag: "Reconnecting", reviews: [] }), step),
    // the seed isn't news: loading until the first snapshot
    Stream.drop(1),
  ),
)

// ---------- older reviews: the live stream holds the latest PAGE, the rest load a page at a time ----------

export interface Older {
  readonly reviews: ReadonlyArray<Review>
  /** every review is loaded */
  readonly done: boolean
}

export const olderAtom = Atom.make<Older>({ reviews: [], done: false }).pipe(Atom.keepAlive)

/** the next page, before the oldest review loaded so far */
export const loadOlder = Mekiki.runtime.fn(
  Effect.fn("Mekiki.loadOlder")(function* (before: number, get: Atom.FnContext) {
    const client = yield* Mekiki
    const page = yield* client("ListReviews", { before })
    const older = get(olderAtom)
    get.set(olderAtom, { reviews: [...older.reviews, ...page], done: page.length < PAGE })
  }),
)

/** the reviews in the feed and the older pages loaded: undefined until it connects, so pages can show a skeleton */
export const useReviews = (): ReadonlyArray<Review> | undefined => {
  const feed = useValue(feedAtom)
  const older = useAtomValue(olderAtom)
  if (!feed) return undefined
  const live = feed._tag !== "Locked" ? feed.reviews : []
  if (older.reviews.length === 0) return live
  const ids = new Set(live.map((r) => r.id))
  return [...live, ...older.reviews.filter((r) => !ids.has(r.id))]
}

/** whether there may be reviews older than the ones loaded: the feed is full and the pages haven't run out */
export const useMoreToLoad = () => {
  const feed = useValue(feedAtom)
  const older = useAtomValue(olderAtom)
  return feed?._tag !== "Locked" && (feed?.reviews.length ?? 0) >= PAGE && !older.done
}
