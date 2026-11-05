// mekiki's comment on a pull request: what it's doing, and Light / Medium / High checkboxes.
// ticking one edits the comment, github sends `issue_comment.edited`, and the review starts.
// mekiki only ever writes the boxes unticked, so a ticked box is always a person asking
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect"
import { type Depth, Depth as DepthSchema, partial, type PrRef, type Review } from "./domain.ts"
import { GitHub } from "./github.ts"
import { Store } from "./store.ts"

export const MARKER = "<!-- mekiki:panel -->"

/** the heading on everything mekiki posts. the logo comes from the repository's main branch, github proxies it */
export const HEADING = `### <img src="https://raw.githubusercontent.com/atresnjo/mekiki/main/docs/logo-mark.png" alt="" width="20" height="20" align="top"> mekiki`

export type State =
  /** nothing reviewed yet */
  | { readonly kind: "waiting" }
  | { readonly kind: "running"; readonly depth: Depth }
  /** `head` is the pull request's head now, when it has moved past the review */
  | { readonly kind: "finished"; readonly review: Review; readonly head?: string | undefined }

const DEPTHS: ReadonlyArray<readonly [Depth, string, string]> = [
  ["light", "Light", "the fastest pass"],
  ["medium", "Medium", "more reasoning, catches more"],
  ["high", "High", "the most thorough, the slowest"],
]

const label = (depth: Depth) => DEPTHS.find(([d]) => d === depth)?.[1] ?? depth
const short = (sha: string) => `\`${sha.slice(0, 7)}\``

const status = (state: State): readonly [string, string] => {
  switch (state.kind) {
    case "waiting":
      return ["Pick a depth to review this pull request.", "Review at:"]
    case "running":
      return [`⏳ Reviewing at **${label(state.depth)}**…`, "Tick another depth to restart at it:"]
    case "finished": {
      const r = state.review
      const stale = state.head && r.headSha && state.head !== r.headSha ? `\n\n🔁 New commits since: ${short(r.headSha)} → ${short(state.head)}.` : ""
      if (r.status === "failed") return [`❌ The **${label(r.depth)}** review failed: ${(r.error ?? "unknown error").slice(0, 300)}${stale}`, "Try again at:"]
      if (r.status === "skipped") return [`⏭️ Skipped: ${r.summary}${stale}`, "Review anyway at:"]
      if (r.status !== "done") return [`The **${label(r.depth)}** review was ${r.status}.${stale}`, "Review at:"]
      const seconds = ((r.durationMs ?? 0) / 1000).toFixed(1)
      const issues = r.findings.length === 0 ? "no issues found" : `**${r.findings.length} issue${r.findings.length === 1 ? "" : "s"}** in the review below`
      if (partial(r))
        return [
          `⚠️ **Partly reviewed** ${short(r.headSha)} at **${label(r.depth)}**: ${r.unreviewed.length} of ${r.files} file${r.files === 1 ? "" : "s"} couldn't be reviewed, ${issues} in the rest.${stale}`,
          "Try again at:",
        ]
      return [
        `✅ Reviewed ${short(r.headSha)} at **${label(r.depth)}** in ${seconds}s: ${issues}.${stale}`,
        stale ? "Review the new commits at:" : "Review again at:",
      ]
    }
  }
}

export const render = (state: State): string => {
  const [line, prompt] = status(state)
  const boxes = DEPTHS.map(([depth, name, hint]) => `- [ ] **${name}**: ${hint} <!-- mekiki:${depth} -->`).join("\n")
  return `${MARKER}\n${HEADING}\n\n${line}\n\n${prompt}\n\n${boxes}`
}

const ticked = (body: string): Set<Depth> =>
  new Set(
    [...body.matchAll(/^\s*[-*] \[[xX]\].*<!-- mekiki:(light|medium|high) -->/gm)].flatMap((match) =>
      Option.toArray(Schema.decodeUnknownOption(DepthSchema)(match[1])),
    ),
  )

/** the depth a person just ticked in the panel, if any */
export const tickedDepth = (body: string, before?: string): Depth | undefined => {
  if (!body.includes(MARKER)) return undefined
  const was = ticked(before ?? "")
  // several ticked at once: the deepest wins
  return [...ticked(body)].filter((d) => !was.has(d)).sort((a, b) => DEPTHS.findIndex(([d]) => d === b) - DEPTHS.findIndex(([d]) => d === a))[0]
}

export interface Interface {
  /** create or update the panel. never fails: a panel that can't be written is logged, not fatal */
  readonly show: (pr: PrRef, state: State) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("mekiki/Panel") {}

export const make = Effect.gen(function* () {
  const github = yield* GitHub.Service
  const store = yield* Store.Service
  // one write at a time: two first writes would otherwise both create a comment
  const lock = yield* Semaphore.make(1)

  const show = Effect.fn("Panel.show")(
    function* (pr: PrRef, state: State) {
      const repo = `${pr.owner}/${pr.repo}`
      const body = render(state)
      const existing = yield* store.panel(repo, pr.number)
      if (Option.isSome(existing)) {
        const updated = yield* github.updateComment(pr, existing.value, body).pipe(
          Effect.as(true),
          // deleted by someone: post a new one
          Effect.catchIf(
            (e) => e.status === 404,
            () => Effect.succeed(false),
          ),
        )
        if (updated) return
      }
      const id = yield* github.createComment(pr, body)
      yield* store.savePanel(repo, pr.number, id)
    },
    (effect, pr) =>
      effect.pipe(
        Semaphore.withPermit(lock),
        Effect.catch((e) => Effect.logWarning(`couldn't update the mekiki comment on ${pr.owner}/${pr.repo}#${pr.number}: ${e.message}`)),
      ),
  )

  return Service.of({ show })
})

export const layer = Layer.effect(Service, make)

export * as Panel from "./panel.ts"
