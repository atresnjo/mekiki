// the repositories mekiki can reach, through the real client against a local github: as an app
// (every installation, every page of each) and as a token
import { afterAll, expect, test } from "bun:test"
import { generateKeyPairSync } from "node:crypto"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"
import { GitHub } from "../src/github.ts"
import { configFrom } from "./support.ts"

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString()

const seen: Array<string> = []
const repo = (name: string) => ({ full_name: name })
// installation 1 has 150 repositories (two pages), installation 2 one
const first = Array.from({ length: 150 }, (_, i) => repo(`acme/r${String(i).padStart(3, "0")}`))
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    const url = new URL(request.url)
    const auth = request.headers.get("authorization") ?? ""
    seen.push(`${request.method} ${url.pathname}${url.search} ${auth.split(".")[0]?.slice(0, 12)}`)
    const page = Number(url.searchParams.get("page") ?? 1)
    if (url.pathname === "/app/installations") return Response.json(page === 1 ? [{ id: 1 }, { id: 2 }] : [])
    const minted = url.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/)
    if (minted) return Response.json({ token: `install-${minted[1]}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
    if (url.pathname === "/installation/repositories") {
      if (auth === "Bearer install-2") return Response.json({ repositories: [repo("Vedro-Labs/Citapami")] })
      return Response.json({ repositories: first.slice((page - 1) * 100, page * 100) })
    }
    if (url.pathname === "/user/repos") return Response.json(auth === "Bearer pat" ? [repo("me/one"), repo("me/two")] : [])
    return new Response("not here", { status: 404 })
  },
})
afterAll(() => server.stop(true))

const list = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const github = yield* GitHub.Service
      const once = yield* github.repositories
      // a second read inside five minutes comes from the cache
      const again = yield* github.repositories
      return { once, again }
    }).pipe(Effect.provide(GitHub.layer(configFrom({ GITHUB_API_URL: server.url.href.replace(/\/$/, ""), ...env }).github)), Effect.provide(BunServices.layer)),
  )

test("as an app: every installation's repositories, every page, lowercased, sorted, kept for a while", async () => {
  seen.length = 0
  const { once, again } = await list({ GITHUB_APP_ID: "42", GITHUB_APP_PRIVATE_KEY: pem.replaceAll("\n", "\\n") })
  expect(once).toHaveLength(151)
  expect(once[0]).toBe("acme/r000")
  expect(once.at(-1)).toBe("vedro-labs/citapami")
  expect(again).toEqual(once)
  // one listing of installations, a token for each, two pages for the first and one for the second: and nothing more
  expect(seen.filter((s) => s.startsWith("GET /installation/repositories"))).toHaveLength(3)
  expect(seen.filter((s) => s.startsWith("GET /app/installations"))).toHaveLength(1)
})

test("as a token: what it can reach", async () => {
  const { once } = await list({ GITHUB_TOKEN: "pat" })
  expect(once).toEqual(["me/one", "me/two"])
})
