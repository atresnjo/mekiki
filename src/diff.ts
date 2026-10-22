// unified diff → files the model can review. pure: no effects here

export interface Line {
  readonly kind: "+" | "-" | " "
  /** line number in the new file; absent for removed lines */
  readonly newLine: number | undefined
  readonly text: string
}

export interface Hunk {
  readonly header: string
  readonly lines: ReadonlyArray<Line>
}

export interface FileDiff {
  readonly path: string
  readonly status: "added" | "deleted" | "modified" | "renamed"
  readonly binary: boolean
  readonly hunks: ReadonlyArray<Hunk>
  readonly additions: number
  readonly deletions: number
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export const parseDiff = (text: string): Array<FileDiff> => {
  const files: Array<FileDiff> = []
  let file: { path: string; status: FileDiff["status"]; binary: boolean; hunks: Array<Hunk>; additions: number; deletions: number } | undefined
  let hunk: { header: string; lines: Array<Line> } | undefined
  let next = 0

  const flush = () => {
    if (file) files.push(file)
    file = undefined
    hunk = undefined
  }

  for (const raw of text.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush()
      const m = raw.match(/^diff --git a\/(.+) b\/(.+)$/)
      file = { path: m?.[2] ?? "", status: "modified", binary: false, hunks: [], additions: 0, deletions: 0 }
      continue
    }
    if (!file) continue
    if (!hunk) {
      if (raw.startsWith("new file mode")) file.status = "added"
      else if (raw.startsWith("deleted file mode")) file.status = "deleted"
      else if (raw.startsWith("rename to ")) file.status = "renamed"
      else if (raw.startsWith("Binary files ")) file.binary = true
      else if (raw.startsWith("+++ ") && raw !== "+++ /dev/null") file.path = raw.slice(4).replace(/^b\//, "")
    }
    const h = raw.match(HUNK)
    if (h) {
      hunk = { header: raw, lines: [] }
      file.hunks.push(hunk)
      next = Number(h[1])
      continue
    }
    if (!hunk) continue
    const kind = raw[0]
    if (kind === "+") {
      hunk.lines.push({ kind: "+", newLine: next++, text: raw.slice(1) })
      file.additions++
    } else if (kind === "-") {
      hunk.lines.push({ kind: "-", newLine: undefined, text: raw.slice(1) })
      file.deletions++
    } else if (kind === " ") {
      hunk.lines.push({ kind: " ", newLine: next++, text: raw.slice(1) })
    }
    // "\ No newline at end of file" and trailing blanks fall through
  }
  flush()
  return files
}

const IGNORED: ReadonlyArray<RegExp> = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|go\.sum|Podfile\.lock|flake\.lock)$/,
  /\.(min\.(js|css)|map|snap|lock|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|mp4|mp3|zip|gz)$/i,
  /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage|__generated__|generated)\//,
  /\.(pb|generated|gen)\.\w+$/,
]

export const isIgnored = (path: string) => IGNORED.some((re) => re.test(path))

/** lower is reviewed first when the diff doesn't fit */
const priority = (path: string): number => {
  if (/(auth|security|crypto|payment|billing|session|token|password|secret|permission|migration)/i.test(path)) return 0
  if (/\.(test|spec)\.\w+$|(^|\/)(tests?|__tests__|spec)\//i.test(path)) return 3
  if (/\.(md|mdx|txt|rst)$/i.test(path) || /(^|\/)docs?\//i.test(path)) return 4
  if (/\.(json|ya?ml|toml|ini|env|cfg)$/i.test(path)) return 2
  return 1
}

/** characters the model will see for this file */
export const size = (file: FileDiff) => file.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length + 8, h.header.length), file.path.length)

export interface Selection {
  readonly selected: ReadonlyArray<FileDiff>
  readonly skipped: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

export const select = (files: ReadonlyArray<FileDiff>, options: { readonly maxTotalChars: number; readonly maxFileChars: number }): Selection => {
  const selected: Array<FileDiff> = []
  const skipped: Array<{ path: string; reason: string }> = []
  let total = 0
  const ranked = [...files].sort((a, b) => priority(a.path) - priority(b.path) || size(a) - size(b))
  for (const file of ranked) {
    if (file.binary) skipped.push({ path: file.path, reason: "binary" })
    else if (file.status === "deleted") skipped.push({ path: file.path, reason: "deleted" })
    else if (isIgnored(file.path)) skipped.push({ path: file.path, reason: "generated or lockfile" })
    else if (file.additions === 0) skipped.push({ path: file.path, reason: "no additions" })
    else if (size(file) > options.maxFileChars) skipped.push({ path: file.path, reason: "too large" })
    else if (total + size(file) > options.maxTotalChars) skipped.push({ path: file.path, reason: "diff budget" })
    else {
      selected.push(file)
      total += size(file)
    }
  }
  return { selected, skipped }
}

/** first-fit decreasing: as few chunks as fit, since every chunk is one CLI process */
export const chunk = (files: ReadonlyArray<FileDiff>, maxChars: number): Array<Array<FileDiff>> => {
  const bins: Array<{ files: Array<FileDiff>; size: number }> = []
  for (const file of [...files].sort((a, b) => size(b) - size(a))) {
    const s = size(file)
    const bin = bins.find((b) => b.size + s <= maxChars)
    if (bin) {
      bin.files.push(file)
      bin.size += s
    } else bins.push({ files: [file], size: s })
  }
  return bins.map((b) => b.files)
}

/** the file as the model sees it: every reviewable line carries its new-file line number */
export const render = (file: FileDiff): string => {
  const out = [`### ${file.path} (${file.status})`]
  for (const hunk of file.hunks) {
    out.push(hunk.header)
    for (const line of hunk.lines) out.push(`${line.newLine === undefined ? "     " : String(line.newLine).padStart(5)} ${line.kind} ${line.text}`)
  }
  return out.join("\n")
}

/** lines github accepts review comments on (RIGHT side): added and context lines */
export const commentable = (files: ReadonlyArray<FileDiff>): Map<string, Set<number>> =>
  new Map(files.map((f) => [f.path, new Set(f.hunks.flatMap((h) => h.lines.flatMap((l) => (l.newLine === undefined ? [] : [l.newLine]))))]))

/** keep only the sections of `diff` for files in `paths` */
export const restrictTo = (diff: string, paths: ReadonlySet<string>): string =>
  diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const m = section.match(/^diff --git a\/.+ b\/(.+)$/m)
      return m?.[1] !== undefined && paths.has(m[1])
    })
    .join("")
