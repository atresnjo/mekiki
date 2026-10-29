// the api agent's tools on a checkout: a hostile path gets nothing outside it, and every answer is capped
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Sandbox } from "../src/sandbox.ts"

const root = mkdtempSync(join(tmpdir(), "glance-sandbox-"))
const code = join(root, "checkout")
mkdirSync(join(code, "src", "deep"), { recursive: true })
writeFileSync(join(root, "secret.txt"), "OUTSIDE-SECRET\n")
mkdirSync(join(root, "checkout-sibling"))
writeFileSync(join(root, "checkout-sibling", "x.txt"), "SIBLING-SECRET\n")
writeFileSync(join(code, "README.md"), "# readme\nsee src/main.ts\n")
writeFileSync(join(code, "src", "main.ts"), Array.from({ length: 50 }, (_, i) => `export const line${i + 1} = ${i + 1}`).join("\n"))
writeFileSync(join(code, "src", "deep", "util.py"), "def helper():\n    return 'needle'\n")
writeFileSync(join(code, "big.txt"), "x".repeat(4096))
writeFileSync(join(code, "image.png"), new Uint8Array([137, 80, 78, 71, 0, 0, 0, 13]))
// checkouts have none, but a symlink must never be the way out
symlinkSync(join(root, "secret.txt"), join(code, "link.txt"))
symlinkSync(root, join(code, "src", "up"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const LIMITS: Sandbox.Limits = { maxFileBytes: 2048, maxOutputChars: 400, maxTotalChars: 2000, maxResults: 5, maxEntries: 1000, maxScanBytes: 1024 * 1024 }
const run = <A>(f: (sandbox: Sandbox.Sandbox) => Effect.Effect<A, Sandbox.SandboxError>, limits = LIMITS) =>
  Effect.runPromise(Sandbox.make(code, limits).pipe(Effect.flatMap(f)))
const refusal = (f: (sandbox: Sandbox.Sandbox) => Effect.Effect<unknown, Sandbox.SandboxError>) =>
  Effect.runPromise(Sandbox.make(code, LIMITS).pipe(Effect.flatMap(f), Effect.flip)).then((e) => e.message)

describe("paths", () => {
  test.each([
    ["../secret.txt", '".." isn\'t allowed'],
    ["src/../../secret.txt", '".." isn\'t allowed'],
    ["src\\..\\..\\secret.txt", '".." isn\'t allowed'],
    ["../checkout-sibling/x.txt", '".." isn\'t allowed'],
    ["/etc/passwd", "absolute paths aren't allowed"],
    [`${root}/secret.txt`, "absolute paths aren't allowed"],
    ["C:\\Windows\\win.ini", "absolute paths aren't allowed"],
    ["\\\\server\\share", "absolute paths aren't allowed"],
    ["link.txt", "symlinks aren't followed"],
    ["src/up/secret.txt", "symlinks aren't followed"],
    ["src/up", "symlinks aren't followed"],
    ["README.md\0.png", "not a usable path"],
    ["missing.ts", "no such file"],
  ])("%s is refused", async (path, why) => {
    expect(await refusal((s) => s.read({ path }))).toContain(why)
  })

  test("a path inside resolves, however it's written", async () => {
    const resolved = await run((s) => Effect.all([s.resolve("src/main.ts"), s.resolve("./src//main.ts"), s.resolve(""), s.resolve(".")]))
    expect(resolved.map((r) => r.rel)).toEqual(["src/main.ts", "src/main.ts", ".", "."])
    expect(resolved[0]?.full.endsWith(join("checkout", "src", "main.ts"))).toBe(true)
  })

  test("search and listing refuse the same paths, and never walk into a symlink", async () => {
    expect(await refusal((s) => s.grep({ pattern: "SECRET", path: "../" }))).toContain('".."')
    expect(await refusal((s) => s.list({ path: "/" }))).toContain("absolute")
    expect(await refusal((s) => s.list({ path: "src/up" }))).toContain("symlinks")
    const [found, listed] = await run((s) => Effect.all([s.grep({ pattern: "SECRET" }), s.list({})]))
    expect(found).toBe("No matches.")
    expect(listed).not.toContain("link.txt")
    expect(listed).not.toContain("up")
    // a glob is only ever matched against what's inside
    expect(await run((s) => s.list({ glob: "../**" }))).toBe("No files.")
  })
})

describe("reading", () => {
  test("a file comes back numbered, a range of it when asked", async () => {
    expect(await run((s) => s.read({ path: "README.md" }))).toBe("1\t# readme\n2\tsee src/main.ts\n3\t")
    expect(await run((s) => s.read({ path: "src/main.ts", startLine: 10, endLine: 11 }))).toBe("10\texport const line10 = 10\n11\texport const line11 = 11")
    expect(await refusal((s) => s.read({ path: "src/main.ts", startLine: 90 }))).toContain("has 50 lines")
    // an inverted range is refused, not answered with nothing
    expect(await refusal((s) => s.read({ path: "src/main.ts", startLine: 3, endLine: 1 }))).toContain("endLine 1 is before startLine 3")
  })

  test("a long read stops at the output cap and says where to go on", async () => {
    const text = await run((s) => s.read({ path: "src/main.ts" }))
    expect(text.length).toBeLessThanOrEqual(LIMITS.maxOutputChars)
    expect(text).toMatch(/stopped at line (\d+) of 50: read on with startLine \d+/)
  })

  test("an oversized file, a binary one or a directory isn't read", async () => {
    expect(await refusal((s) => s.read({ path: "big.txt" }))).toContain("over the 2 KB a file may be")
    expect(await refusal((s) => s.read({ path: "image.png" }))).toContain("binary")
    expect(await refusal((s) => s.read({ path: "src" }))).toContain("is a directory")
  })

  test("past the review's budget, every answer says to stop reading", async () => {
    const answers = await run((s) => Effect.forEach(Array.from({ length: 12 }), () => s.read({ path: "src/main.ts" })))
    const spent = "The reading budget for this review is spent: answer now, with what you have."
    expect(answers.filter((a) => a !== spent).reduce((n, a) => n + a.length, 0)).toBeLessThanOrEqual(LIMITS.maxTotalChars)
    expect(answers.at(-1)).toContain("reading budget for this review is spent")
  })
})

describe("searching and listing", () => {
  test("search finds plain text, never as a regular expression", async () => {
    expect(await run((s) => s.grep({ pattern: "needle" }))).toBe("src/deep/util.py:2: return 'needle'")
    expect(await run((s) => s.grep({ pattern: "(a+)+$" }))).toBe("No matches.")
    expect(await run((s) => s.grep({ pattern: "README", ignoreCase: true }))).toBe("README.md:1: # readme")
  })

  test("a glob narrows the files, by name alone or by path", async () => {
    expect(await run((s) => s.list({ glob: "*.py" }))).toBe("src/deep/util.py")
    expect(await run((s) => s.list({ glob: "src/**/*.ts" }))).toBe("src/main.ts")
    expect(await run((s) => s.grep({ pattern: "line1", glob: "*.py" }))).toBe("No matches.")
  })

  test("results stop at the cap, and say so", async () => {
    const found = await run((s) => s.grep({ pattern: "export const" }))
    expect(found.split("\n").filter((l) => l.startsWith("src/main.ts:"))).toHaveLength(LIMITS.maxResults)
    expect(found).toContain("narrow the path or glob")
  })

  test("search and listing take a file as their path too", async () => {
    expect(await run((s) => s.grep({ pattern: "helper", path: "src/deep/util.py" }))).toBe("src/deep/util.py:1: def helper():")
    expect(await run((s) => s.list({ path: "README.md" }))).toBe("README.md")
  })

  test("a walk stops at maxEntries", async () => {
    const listed = await run((s) => s.list({}), { ...LIMITS, maxEntries: 3 })
    expect(listed).toContain("… stopped at")
  })

  test("a called-off search stops", async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await refusal((s) => s.grep({ pattern: "x" }, controller.signal))).toBe("cancelled")
  })
})
