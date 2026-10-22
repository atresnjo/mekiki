// reviews and settings in one sqlite file (bun:sqlite: synchronous and sub-millisecond, so calls
// are plain Effect.sync)
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Review, Settings } from "./domain.ts"

export type NewReview = Omit<Review, "id">

export interface Interface {
  readonly create: (review: NewReview) => Effect.Effect<Review>
  readonly update: (id: number, patch: Partial<NewReview>) => Effect.Effect<Review>
  readonly get: (id: number) => Effect.Effect<Option.Option<Review>>
  readonly list: (limit: number) => Effect.Effect<ReadonlyArray<Review>>
  /** the reviews older than `before`, newest first: the pages after the first */
  readonly listBefore: (before: number, limit: number) => Effect.Effect<ReadonlyArray<Review>>
  /** the last finished review of a pull request: where an incremental review starts from */
  readonly lastDone: (repo: string, number: number) => Effect.Effect<Option.Option<Review>>
  /** reviews still marked running: left by a process that stopped or died mid-review */
  readonly interrupted: Effect.Effect<ReadonlyArray<Review>>
  readonly settings: Effect.Effect<Settings>
  readonly saveSettings: (settings: Settings) => Effect.Effect<Settings>
  /** the id of glance's comment on a pull request */
  readonly panel: (repo: string, number: number) => Effect.Effect<Option.Option<number>>
  readonly savePanel: (repo: string, number: number, commentId: number) => Effect.Effect<void>
  /** remember a webhook delivery: false when it was seen before (github redelivers on request) */
  readonly claimDelivery: (id: string) => Effect.Effect<boolean>
  /** handling it failed on glance's side: a redelivery should be acted on */
  readonly releaseDelivery: (id: string) => Effect.Effect<void>
  /** the database answers */
  readonly ping: Effect.Effect<void, StoreError>
  /** a consistent copy of the database at `path`, taken while it's in use */
  readonly backup: (path: string) => Effect.Effect<void, StoreError>
}

export class Service extends Context.Service<Service, Interface>()("glance/Store") {}

export class StoreError extends Schema.TaggedError<StoreError>()("StoreError", { message: Schema.String }) {}

const storeError = (cause: unknown) => new StoreError({ message: cause instanceof Error ? cause.message : String(cause) })

interface Row {
  readonly id: number
  readonly repo: string
  readonly number: number
  readonly data: string
}

const decodeReview = Schema.decodeUnknownEffect(Review)
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(Settings))

export const make = Effect.fn("Store.make")(function* (options: { readonly path: string; readonly defaults: Settings }) {
  if (options.path !== ":memory:") mkdirSync(dirname(options.path), { recursive: true })
  const db = new Database(options.path, { create: true, strict: true })
  yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run(
    "CREATE TABLE IF NOT EXISTS reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, number INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL)",
  )
  db.run("CREATE INDEX IF NOT EXISTS reviews_pr ON reviews (repo, number, id)")
  db.run("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)")
  db.run("CREATE TABLE IF NOT EXISTS panels (repo TEXT NOT NULL, number INTEGER NOT NULL, comment_id INTEGER NOT NULL, PRIMARY KEY (repo, number))")
  db.run("CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, at INTEGER NOT NULL)")

  const insert = db.query<{ id: number }, { repo: string; number: number; status: string; data: string }>(
    "INSERT INTO reviews (repo, number, status, data) VALUES ($repo, $number, $status, $data) RETURNING id",
  )
  const write = db.query<never, { id: number; status: string; data: string }>("UPDATE reviews SET status = $status, data = $data WHERE id = $id")
  const one = db.query<Row, { id: number }>("SELECT id, repo, number, data FROM reviews WHERE id = $id")
  const recent = db.query<Row, { limit: number }>("SELECT id, repo, number, data FROM reviews ORDER BY id DESC LIMIT $limit")
  const older = db.query<Row, { before: number; limit: number }>("SELECT id, repo, number, data FROM reviews WHERE id < $before ORDER BY id DESC LIMIT $limit")
  const last = db.query<Row, { repo: string; number: number }>(
    "SELECT id, repo, number, data FROM reviews WHERE repo = $repo AND number = $number AND status = 'done' ORDER BY id DESC LIMIT 1",
  )
  const running = db.query<Row, Record<string, never>>("SELECT id, repo, number, data FROM reviews WHERE status = 'running'")
  const readSettings = db.query<{ data: string }, Record<string, never>>("SELECT data FROM settings WHERE id = 1")
  const writeSettings = db.query<never, { data: string }>(
    "INSERT INTO settings (id, data) VALUES (1, $data) ON CONFLICT (id) DO UPDATE SET data = excluded.data",
  )

  // rows are written only by this module: a row that doesn't decode is a bug, not an input error
  // reviews saved before depths existed ran at light; before dry runs were kept, they were posted
  const toReview = (row: Row) => decodeReview({ depth: "light", dryRun: false, ...(JSON.parse(row.data) as object), id: row.id }).pipe(Effect.orDie)

  const get = (id: number) =>
    Effect.suspend(() => {
      const row = one.get({ id })
      return row ? toReview(row).pipe(Effect.map(Option.some)) : Effect.succeedNone
    })

  const create = Effect.fn("Store.create")(function* (review: NewReview) {
    const row = insert.get({ repo: review.repo, number: review.number, status: review.status, data: JSON.stringify(review) })
    if (!row) return yield* Effect.die("insert returned no row")
    return { ...review, id: row.id }
  })

  const update = Effect.fn("Store.update")(function* (id: number, patch: Partial<NewReview>) {
    const current = yield* get(id).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.die(`no review ${id}`), onSome: Effect.succeed })))
    const next: Review = { ...current, ...patch, id }
    write.run({ id, status: next.status, data: JSON.stringify(next) })
    return next
  })

  const list = (limit: number) => Effect.suspend(() => Effect.forEach(recent.all({ limit }), toReview))
  const listBefore = (before: number, limit: number) => Effect.suspend(() => Effect.forEach(older.all({ before, limit }), toReview))

  const lastDone = (repo: string, number: number) =>
    Effect.suspend(() => {
      const row = last.get({ repo, number })
      return row ? toReview(row).pipe(Effect.map(Option.some)) : Effect.succeedNone
    })

  const interrupted = Effect.suspend(() => Effect.forEach(running.all({}), toReview))

  const settings = Effect.suspend(() => {
    const row = readSettings.get({})
    if (!row) return Effect.succeed(options.defaults)
    // settings saved by an older version: keep what still decodes, default the rest
    return decodeSettings(row.data).pipe(
      Effect.catch(() => decodeSettings(JSON.stringify({ ...options.defaults, ...(JSON.parse(row.data) as object) }))),
      Effect.orElseSucceed(() => options.defaults),
    )
  })

  const saveSettings = (next: Settings) =>
    Effect.sync(() => {
      writeSettings.run({ data: JSON.stringify(next) })
      return next
    })

  const readPanel = db.query<{ comment_id: number }, { repo: string; number: number }>("SELECT comment_id FROM panels WHERE repo = $repo AND number = $number")
  const writePanel = db.query<never, { repo: string; number: number; commentId: number }>(
    "INSERT INTO panels (repo, number, comment_id) VALUES ($repo, $number, $commentId) ON CONFLICT (repo, number) DO UPDATE SET comment_id = excluded.comment_id",
  )

  const panel = (repo: string, number: number) => Effect.sync(() => Option.fromNullishOr(readPanel.get({ repo, number })?.comment_id))
  const savePanel = (repo: string, number: number, commentId: number) => Effect.sync(() => void writePanel.run({ repo, number, commentId }))

  const insertDelivery = db.query<{ id: string }, { id: string; at: number }>(
    "INSERT INTO deliveries (id, at) VALUES ($id, $at) ON CONFLICT (id) DO NOTHING RETURNING id",
  )
  const pruneDeliveries = db.query<never, { before: number }>("DELETE FROM deliveries WHERE at < $before")
  // github lets a delivery be redelivered for a few days: a month of ids is plenty
  const claimDelivery = (id: string) =>
    Effect.sync(() => {
      const now = Date.now()
      pruneDeliveries.run({ before: now - 30 * 24 * 3600 * 1000 })
      return insertDelivery.get({ id, at: now }) !== null
    })

  const deleteDelivery = db.query<never, { id: string }>("DELETE FROM deliveries WHERE id = $id")
  const releaseDelivery = (id: string) => Effect.sync(() => void deleteDelivery.run({ id }))

  const ping = Effect.try({ try: () => void db.query("SELECT 1").get(), catch: storeError })

  const backup = (path: string) =>
    Effect.try({
      try: () => {
        mkdirSync(dirname(path), { recursive: true })
        db.run("VACUUM INTO ?", [path])
      },
      catch: storeError,
    })

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
    panel,
    savePanel,
    claimDelivery,
    releaseDelivery,
    ping,
    backup,
  })
})

export const layer = (options: { readonly path: string; readonly defaults: Settings }) => Layer.effect(Service, make(options))

export * as Store from "./store.ts"
