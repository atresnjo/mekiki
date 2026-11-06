// what the api agent may do with a review's checkout: read a file, search the files, list them.
// the pull request is untrusted, and so is whatever the model asks for after reading it: every path
// is relative, has no `..`, crosses no symlink and resolves inside the checkout. no shell, no
// network, no writes. every answer is capped, and so is all the reading one review may do
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { join, sep } from "node:path"
import { Effect, Ref, Schema } from "effect"

export class SandboxError extends Schema.TaggedError<SandboxError>()("SandboxError", { message: Schema.String }) {}

export interface Limits {
  /** a bigger file isn't read or searched */
  readonly maxFileBytes: number
  /** characters one answer may hold */
  readonly maxOutputChars: number
  /** characters every answer of one review may hold together: past it, the agent is told to answer */
  readonly maxTotalChars: number
  /** matching lines one search returns, files one listing returns */
  readonly maxResults: number
  /** entries one search or listing walks past */
  readonly maxEntries: number
  /** bytes one search reads */
  readonly maxScanBytes: number
}

export const LIMITS: Limits = {
  maxFileBytes: 1024 * 1024,
  maxOutputChars: 40_000,
  maxTotalChars: 600_000,
  maxResults: 200,
  maxEntries: 20_000,
  maxScanBytes: 32 * 1024 * 1024,
}

/** a line longer than this is cut, in reads and in search results */
const LINE = 2000
/** git's own directory, should a checkout ever hold one */
const SKIP = new Set([".git"])

export interface Read {
  readonly path: string
  /** 1-based, inclusive */
  readonly startLine?: number | undefined
  readonly endLine?: number | undefined
}

export interface Grep {
  /** plain text, not a regular expression: a pattern from the model can't hang the process */
  readonly pattern: string
  readonly path?: string | undefined
  readonly glob?: string | undefined
  readonly ignoreCase?: boolean | undefined
}

export interface List {
  readonly path?: string | undefined
  readonly glob?: string | undefined
}

export interface Sandbox {
  /** a path inside the checkout, checked: its absolute path, and the relative one it stands for */
  readonly resolve: (path: string) => Effect.Effect<{ readonly full: string; readonly rel: string }, SandboxError>
  readonly read: (input: Read) => Effect.Effect<string, SandboxError>
  readonly grep: (input: Grep, signal?: AbortSignal) => Effect.Effect<string, SandboxError>
  readonly list: (input: List, signal?: AbortSignal) => Effect.Effect<string, SandboxError>
}

const fail = (message: string) => new SandboxError({ message })
const fs = <A>(what: string, f: () => Promise<A>) =>
  Effect.tryPromise({
    try: f,
    catch: (e) => fail(e instanceof Error && "code" in e && e.code === "ENOENT" ? `${what}: no such file or directory` : `${what}: can't be read`),
  })

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0)
const cut = (line: string) => (line.length > LINE ? `${line.slice(0, LINE)}…` : line)

/** a file's first `limit` bytes: no more is ever read into memory */
const head = (path: string, limit: number) =>
  fs(path, async () => {
    const file = await open(path, "r")
    try {
      const buffer = new Uint8Array(limit)
      const { bytesRead } = await file.read(buffer, 0, limit, 0)
      return buffer.subarray(0, bytesRead)
    } finally {
      await file.close()
    }
  })

export const make = Effect.fn("Sandbox.make")(function* (root: string, limits: Limits = LIMITS) {
  const real = yield* fs("the checkout", () => realpath(root))
  const spent = yield* Ref.make(0)

  const resolve = Effect.fn("Sandbox.resolve")(function* (path: string) {
    if (path.length > 1024 || path.includes("\0")) return yield* fail("not a usable path")
    const slashed = path.trim().replaceAll("\\", "/")
    if (slashed.startsWith("/") || /^[a-z]:/i.test(slashed))
      return yield* fail(`${path}: absolute paths aren't allowed, give one relative to the repository root`)
    const parts = slashed.split("/").filter((part) => part !== "" && part !== ".")
    if (parts.includes("..")) return yield* fail(`${path}: ".." isn't allowed, give a path inside the repository`)
    // each step is looked at, not followed: a symlink anywhere on the way is refused
    let full = real
    for (const part of parts) {
      full = join(full, part)
      const info = yield* fs(path, () => lstat(full))
      if (info.isSymbolicLink()) return yield* fail(`${path}: symlinks aren't followed`)
    }
    const resolved = yield* fs(path, () => realpath(full))
    if (resolved !== real && !resolved.startsWith(real + sep)) return yield* fail(`${path}: outside the repository`)
    return { full, rel: parts.join("/") || "." }
  })

  /** every answer goes through here: capped on its own, and counted against the review's whole budget */
  const answer = (text: string) =>
    Ref.modify(spent, (used): [string, number] => {
      if (used >= limits.maxTotalChars) return ["The reading budget for this review is spent: answer now, with what you have.", used]
      const room = Math.min(limits.maxOutputChars, limits.maxTotalChars - used)
      const note = `\n… cut at ${room} characters`
      const out = text.length > room ? `${text.slice(0, Math.max(0, room - note.length))}${note}` : text
      return [out, used + out.length]
    })

  const read = Effect.fn("Sandbox.read")(function* (input: Read) {
    const { full, rel } = yield* resolve(input.path)
    const info = yield* fs(rel, () => lstat(full))
    if (info.isDirectory()) return yield* fail(`${rel} is a directory: list it instead`)
    if (!info.isFile()) return yield* fail(`${rel} isn't a regular file`)
    if (info.size > limits.maxFileBytes)
      return yield* fail(`${rel} is ${Math.round(info.size / 1024)} KB, over the ${Math.round(limits.maxFileBytes / 1024)} KB a file may be: search it instead`)
    const bytes = yield* head(full, info.size)
    if (isBinary(bytes)) return yield* fail(`${rel} is a binary file`)
    const lines = new TextDecoder().decode(bytes).split("\n")
    const start = Math.max(1, Math.floor(input.startLine ?? 1))
    const end = Math.min(lines.length, Math.floor(input.endLine ?? lines.length))
    if (start > lines.length) return yield* fail(`${rel} has ${lines.length} lines`)
    if (end < start) return yield* fail(`${rel}: endLine ${end} is before startLine ${start}`)
    const out: Array<string> = []
    let size = 0
    for (let n = start; n <= end; n++) {
      const line = `${n}\t${cut(lines[n - 1] ?? "")}`
      // room left for saying where it stopped
      if (size + line.length > limits.maxOutputChars - 100) {
        out.push(`… stopped at line ${n - 1} of ${lines.length}: read on with startLine ${n}`)
        break
      }
      out.push(line)
      size += line.length + 1
    }
    return yield* answer(out.join("\n"))
  })

  /**
   * the files under `from`, in order, walked by hand: a directory is read with lstat's eyes, so a
   * symlink is never entered nor listed. stops at maxEntries, or when the review is called off
   */
  const walk = (
    from: { readonly full: string; readonly rel: string },
    signal: AbortSignal | undefined,
    visit: (file: { full: string; rel: string; size: number }) => Effect.Effect<boolean, SandboxError>,
  ) =>
    Effect.gen(function* () {
      const top = yield* fs(from.rel, () => lstat(from.full))
      if (top.isFile()) return yield* visit({ ...from, size: top.size }).pipe(Effect.as({ truncated: false }))
      const stack = [from]
      let seen = 0
      while (stack.length > 0) {
        if (signal?.aborted) return yield* fail("cancelled")
        const dir = stack.pop()
        if (!dir) break
        const entries = yield* fs(dir.rel, () => readdir(dir.full, { withFileTypes: true }))
        entries.sort((a, b) => (a.name < b.name ? -1 : 1))
        const dirs: Array<{ full: string; rel: string }> = []
        for (const entry of entries) {
          if (++seen > limits.maxEntries) return { truncated: true }
          if (entry.isSymbolicLink() || SKIP.has(entry.name)) continue
          const next = { full: join(dir.full, entry.name), rel: dir.rel === "." ? entry.name : `${dir.rel}/${entry.name}` }
          if (entry.isDirectory()) dirs.push(next)
          else if (entry.isFile()) {
            const info = yield* fs(next.rel, () => lstat(next.full))
            if (!(yield* visit({ ...next, size: info.size }))) return { truncated: true }
          }
        }
        stack.push(...dirs.reverse())
      }
      return { truncated: false }
    })

  const matcher = (glob: string | undefined): Effect.Effect<(rel: string) => boolean, SandboxError> => {
    if (glob === undefined || glob.trim() === "") return Effect.succeed(() => true)
    if (glob.length > 200) return Effect.fail(fail("the glob is too long"))
    const compiled = new Bun.Glob(glob.trim())
    // `*.ts` means every .ts file, wherever it is, as in ripgrep
    return Effect.succeed((rel: string) => compiled.match(rel) || (!glob.includes("/") && compiled.match(rel.slice(rel.lastIndexOf("/") + 1))))
  }

  const grep = Effect.fn("Sandbox.grep")(function* (input: Grep, signal?: AbortSignal) {
    const pattern = input.pattern
    if (pattern.length === 0 || pattern.length > 200) return yield* fail("the pattern must be 1 to 200 characters")
    const needle = input.ignoreCase ? pattern.toLowerCase() : pattern
    const matches = yield* matcher(input.glob)
    const from = yield* resolve(input.path ?? ".")
    const found: Array<string> = []
    let scanned = 0
    let size = 0
    const { truncated } = yield* walk(from, signal, (file) =>
      Effect.gen(function* () {
        if (!matches(file.rel) || file.size > limits.maxFileBytes) return true
        if ((scanned += file.size) > limits.maxScanBytes) return false
        const bytes = yield* head(file.full, file.size)
        if (isBinary(bytes)) return true
        const lines = new TextDecoder().decode(bytes).split("\n")
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ""
          if (!(input.ignoreCase ? line.toLowerCase() : line).includes(needle)) continue
          const hit = `${file.rel}:${i + 1}: ${cut(line.trim())}`
          if (found.length >= limits.maxResults || size + hit.length > limits.maxOutputChars) return false
          found.push(hit)
          size += hit.length + 1
        }
        return true
      }),
    )
    if (found.length === 0) return yield* answer(truncated ? "No matches in the part searched: narrow the path or glob." : "No matches.")
    return yield* answer([...found, ...(truncated ? ["… more not searched or not shown: narrow the path or glob"] : [])].join("\n"))
  })

  const list = Effect.fn("Sandbox.list")(function* (input: List, signal?: AbortSignal) {
    const matches = yield* matcher(input.glob)
    const from = yield* resolve(input.path ?? ".")
    const files: Array<string> = []
    const max = limits.maxResults * 2
    const { truncated } = yield* walk(from, signal, (file) =>
      Effect.sync(() => {
        if (!matches(file.rel)) return true
        files.push(file.rel)
        return files.length < max
      }),
    )
    if (files.length === 0) return yield* answer("No files.")
    return yield* answer([...files, ...(truncated ? [`… stopped at ${files.length}: narrow the path or glob`] : [])].join("\n"))
  })

  return { resolve, read, grep, list } satisfies Sandbox
})

export * as Sandbox from "./sandbox.ts"
