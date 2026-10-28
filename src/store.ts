// reviews, settings (global and per repository), panels and webhook deliveries in postgres. Infrastructure and persisted-data
// failures stay typed until the transport boundary decides how to report them.
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "./database.ts"
import { effective, RepoSettings, repoSettings as emptyRepoSettings, Review, Settings } from "./domain.ts"
import { deliveries, panels, repoSettings as repoSettingsTable, reviews, settings as settingsTable } from "./schema.ts"

export type NewReview = Omit<Review, "id">

export interface Interface {
  readonly create: (review: NewReview) => Effect.Effect<Review, StoreError>
  readonly update: (id: number, patch: Partial<NewReview>) => Effect.Effect<Review, StoreError>
  readonly get: (id: number) => Effect.Effect<Option.Option<Review>, StoreError>
  readonly list: (limit: number) => Effect.Effect<ReadonlyArray<Review>, StoreError>
  /** the reviews older than `before`, newest first: the pages after the first */
  readonly listBefore: (before: number, limit: number) => Effect.Effect<ReadonlyArray<Review>, StoreError>
  /** the last finished review of a pull request that covered all of it: where an incremental review starts from */
  readonly lastDone: (repo: string, number: number) => Effect.Effect<Option.Option<Review>, StoreError>
  /** reviews still marked running: left by a process that stopped or died mid-review */
  readonly interrupted: Effect.Effect<ReadonlyArray<Review>, StoreError>
  readonly settings: Effect.Effect<Settings, StoreError>
  readonly saveSettings: (settings: Settings) => Effect.Effect<Settings, StoreError>
  /** what a review of owner/repo runs with: the global settings with the repository's on top */
  readonly settingsFor: (repo: string) => Effect.Effect<Settings, StoreError>
  /** every repository with settings of its own, by name */
  readonly repoSettings: Effect.Effect<ReadonlyArray<RepoSettings>, StoreError>
  readonly saveRepoSettings: (settings: RepoSettings) => Effect.Effect<RepoSettings, StoreError>
  readonly deleteRepoSettings: (repo: string) => Effect.Effect<void, StoreError>
  /** the repositories glance has reviewed, by name: what the dashboard suggests */
  readonly reviewedRepos: Effect.Effect<ReadonlyArray<string>, StoreError>
  /** the id of glance's comment on a pull request */
  readonly panel: (repo: string, number: number) => Effect.Effect<Option.Option<number>, StoreError>
  readonly savePanel: (repo: string, number: number, commentId: number) => Effect.Effect<void, StoreError>
  /** remember a webhook delivery: false when it was seen before (github redelivers on request) */
  readonly claimDelivery: (id: string) => Effect.Effect<boolean, StoreError>
  /** handling it failed on glance's side: a redelivery should be acted on */
  readonly releaseDelivery: (id: string) => Effect.Effect<void, StoreError>
  /** the database answers */
  readonly ping: Effect.Effect<void, StoreError>
}

export class Service extends Context.Service<Service, Interface>()("glance/Store") {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const query =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.mapError((cause) => new StoreError({ operation, message: cause instanceof Error ? cause.message : String(cause), cause })))

const decodeReview = Schema.decodeUnknownEffect(Review)
const decodeSettings = Schema.decodeUnknownEffect(Settings)
const decodeRepoSettings = Schema.decodeUnknownEffect(RepoSettings)

export const make = Effect.fn("Store.make")(function* (options: { readonly defaults: Settings }) {
  const db = yield* Database.Service

  // Persisted JSON can outlive the version that wrote it: validate it when reading.
  const toReview = (row: typeof reviews.$inferSelect) => decodeReview({ ...row.data, id: row.id }).pipe(query("decodeReview"))
  const toReviews = (rows: ReadonlyArray<typeof reviews.$inferSelect>) => Effect.forEach(rows, toReview)
  const first = (rows: ReadonlyArray<typeof reviews.$inferSelect>) => (rows[0] ? toReview(rows[0]).pipe(Effect.map(Option.some)) : Effect.succeedNone)

  const create = Effect.fn("Store.create")(function* (review: NewReview) {
    const [row] = yield* db
      .insert(reviews)
      .values({ repo: review.repo, number: review.number, status: review.status, data: review })
      .returning({ id: reviews.id })
      .pipe(query("create"))
    if (!row) return yield* new StoreError({ operation: "create", message: "insert returned no row" })
    return { ...review, id: row.id }
  })

  // the patch is merged in the database (jsonb ||): two fibers saving different fields of the same
  // review can't overwrite each other's
  const update = Effect.fn("Store.update")(function* (id: number, patch: Partial<NewReview>) {
    const [row] = yield* db
      .update(reviews)
      .set({ data: sql`${reviews.data} || ${JSON.stringify(patch)}::jsonb`, ...(patch.status ? { status: patch.status } : {}) })
      .where(eq(reviews.id, id))
      .returning()
      .pipe(query("update"))
    if (!row) return yield* new StoreError({ operation: "update", message: `no review ${id}` })
    return yield* toReview(row)
  })

  const get = Effect.fn("Store.get")(function* (id: number) {
    return yield* first(yield* db.select().from(reviews).where(eq(reviews.id, id)).pipe(query("get")))
  })

  const list = Effect.fn("Store.list")(function* (limit: number) {
    return yield* toReviews(yield* db.select().from(reviews).orderBy(desc(reviews.id)).limit(limit).pipe(query("list")))
  })

  const listBefore = Effect.fn("Store.listBefore")(function* (before: number, limit: number) {
    return yield* toReviews(yield* db.select().from(reviews).where(lt(reviews.id, before)).orderBy(desc(reviews.id)).limit(limit).pipe(query("listBefore")))
  })

  const lastDone = Effect.fn("Store.lastDone")(function* (repo: string, number: number) {
    return yield* first(
      yield* db
        .select()
        .from(reviews)
        // a partial review left files unreviewed: the next one starts from before it, so they're looked at
        .where(
          and(
            eq(reviews.repo, repo),
            eq(reviews.number, number),
            eq(reviews.status, "done"),
            sql`coalesce(jsonb_array_length(${reviews.data} -> 'unreviewed'), 0) = 0`,
          ),
        )
        .orderBy(desc(reviews.id))
        .limit(1)
        .pipe(query("lastDone")),
    )
  })

  const interrupted = db
    .select()
    .from(reviews)
    .where(eq(reviews.status, "running"))
    .pipe(query("interrupted"), Effect.flatMap(toReviews), Effect.withSpan("Store.interrupted"))

  const settings = Effect.gen(function* () {
    const [row] = yield* db.select().from(settingsTable).where(eq(settingsTable.id, 1)).pipe(query("settings"))
    if (!row) return options.defaults
    // settings saved by an older version: keep what still decodes, default the rest
    return yield* decodeSettings(row.data).pipe(
      Effect.catch(() => decodeSettings({ ...options.defaults, ...row.data })),
      Effect.orElseSucceed(() => options.defaults),
    )
  }).pipe(Effect.withSpan("Store.settings"))

  const saveSettings = Effect.fn("Store.saveSettings")(function* (next: Settings) {
    yield* db
      .insert(settingsTable)
      .values({ id: 1, data: next })
      .onConflictDoUpdate({ target: settingsTable.id, set: { data: next } })
      .pipe(query("saveSettings"))
    return next
  })

  // a repository's settings saved by an older version: what's missing is the repository's nothing-of-its-own
  const toRepoSettings = (row: typeof repoSettingsTable.$inferSelect) =>
    decodeRepoSettings({ ...emptyRepoSettings(row.repo), ...row.data, repo: row.repo }).pipe(query("decodeRepoSettings"))

  const settingsFor = Effect.fn("Store.settingsFor")(function* (repo: string) {
    const [global, rows] = yield* Effect.all(
      [settings, db.select().from(repoSettingsTable).where(eq(repoSettingsTable.repo, repo.toLowerCase())).pipe(query("settingsFor"))],
      { concurrency: "unbounded" },
    )
    const [row] = rows
    return effective(global, row ? yield* toRepoSettings(row) : undefined)
  })

  const repoSettings = db
    .select()
    .from(repoSettingsTable)
    .orderBy(repoSettingsTable.repo)
    .pipe(query("repoSettings"), Effect.flatMap(Effect.forEach(toRepoSettings)), Effect.withSpan("Store.repoSettings"))

  const saveRepoSettings = Effect.fn("Store.saveRepoSettings")(function* (next: RepoSettings) {
    const { repo: name, ...data } = next
    const repo = name.toLowerCase()
    yield* db
      .insert(repoSettingsTable)
      .values({ repo, data })
      .onConflictDoUpdate({ target: repoSettingsTable.repo, set: { data } })
      .pipe(query("saveRepoSettings"))
    return { ...next, repo }
  })

  const deleteRepoSettings = Effect.fn("Store.deleteRepoSettings")(function* (repo: string) {
    yield* db.delete(repoSettingsTable).where(eq(repoSettingsTable.repo, repo.toLowerCase())).pipe(query("deleteRepoSettings"))
  })

  const reviewedRepos = db
    .selectDistinct({ repo: reviews.repo })
    .from(reviews)
    .orderBy(reviews.repo)
    .limit(500)
    .pipe(
      query("reviewedRepos"),
      Effect.map((rows) => rows.map((r) => r.repo)),
      Effect.withSpan("Store.reviewedRepos"),
    )

  const panel = Effect.fn("Store.panel")(function* (repo: string, number: number) {
    const [row] = yield* db
      .select({ commentId: panels.commentId })
      .from(panels)
      .where(and(eq(panels.repo, repo), eq(panels.number, number)))
      .pipe(query("panel"))
    return Option.fromNullishOr(row?.commentId)
  })

  const savePanel = Effect.fn("Store.savePanel")(function* (repo: string, number: number, commentId: number) {
    yield* db
      .insert(panels)
      .values({ repo, number, commentId })
      .onConflictDoUpdate({ target: [panels.repo, panels.number], set: { commentId } })
      .pipe(query("savePanel"))
  })

  // github lets a delivery be redelivered for a few days: a month of ids is plenty
  const claimDelivery = Effect.fn("Store.claimDelivery")(function* (id: string) {
    yield* db
      .delete(deliveries)
      .where(lt(deliveries.at, sql`now() - interval '30 days'`))
      .pipe(query("claimDelivery"))
    const claimed = yield* db.insert(deliveries).values({ id }).onConflictDoNothing().returning({ id: deliveries.id }).pipe(query("claimDelivery"))
    return claimed.length > 0
  })

  const releaseDelivery = Effect.fn("Store.releaseDelivery")(function* (id: string) {
    yield* db.delete(deliveries).where(eq(deliveries.id, id)).pipe(query("releaseDelivery"))
  })

  const ping = db.execute(sql`select 1`).pipe(Effect.asVoid, query("ping"), Effect.withSpan("Store.ping"))

  return Service.of({
    create,
    update,
    get,
    list,
    listBefore,
    lastDone,
    interrupted,
    settings,
    saveSettings,
    settingsFor,
    repoSettings,
    saveRepoSettings,
    deleteRepoSettings,
    reviewedRepos,
    panel,
    savePanel,
    claimDelivery,
    releaseDelivery,
    ping,
  })
})

export const layer = (options: { readonly defaults: Settings }) => Layer.effect(Service, make(options))

export * as Store from "./store.ts"
