// a snapshot of the database every few hours (GLANCE_BACKUP_HOURS), the last few kept. they sit
// beside the database by default: copy GLANCE_BACKUPS off the machine for them to survive it
import { Duration, Effect, FileSystem, Layer, Schedule } from "effect"
import type { AppConfig } from "./config.ts"
import { Store } from "./store.ts"

const PREFIX = "glance-"

export const layer = (options: AppConfig["backups"]) =>
  options.everyHours <= 0
    ? Layer.empty
    : Layer.effectDiscard(
        Effect.gen(function* () {
          const store = yield* Store.Service
          const fs = yield* FileSystem.FileSystem

          const snapshot = Effect.gen(function* () {
            const path = `${options.dir}/${PREFIX}${new Date().toISOString().replaceAll(":", "-")}.db`
            yield* store.backup(path)
            // iso timestamps sort by time: the newest last
            const old = (yield* fs.readDirectory(options.dir))
              .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
              .sort()
              .slice(0, -options.keep)
            yield* Effect.forEach(old, (f) => fs.remove(`${options.dir}/${f}`), { discard: true })
            yield* Effect.logInfo(`database backed up to ${path}`)
          }).pipe(
            Effect.catch((e) => Effect.logError("database backup failed", e)),
            Effect.withSpan("Backup.snapshot"),
          )

          // the first one an hour after starting: a crash loop doesn't churn through the kept ones
          yield* snapshot.pipe(Effect.delay(Duration.hours(1)), Effect.repeat(Schedule.spaced(Duration.hours(options.everyHours))), Effect.forkScoped)
        }),
      )

export * as Backup from "./backup.ts"
