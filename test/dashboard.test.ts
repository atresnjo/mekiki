import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunHttpServer } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { Dashboard } from "../src/dashboard.ts"
import { Health } from "../src/health.ts"
import { configFrom, fakeHealth } from "./support.ts"

// a built dashboard: index.html and one hashed asset
const dir = mkdtempSync(join(tmpdir(), "mekiki-web-"))
mkdirSync(join(dir, "assets"))
writeFileSync(join(dir, "index.html"), "<!doctype html><div id=root></div>")
writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)")

const config = configFrom({ MEKIKI_WEB_DIR: dir })
// the api's own routes, as main.ts mounts them beside the dashboard: they keep answering
const api = Layer.mergeAll(Health.routes, HttpRouter.add("*", "/api/auth/*", Effect.succeed(HttpServerResponse.text("auth")))).pipe(Layer.provide(fakeHealth))
const { handler, dispose } = HttpRouter.toWebHandler(Layer.mergeAll(api, Dashboard.routes(config)).pipe(Layer.provide(BunHttpServer.layerHttpServices)), {
  disableLogger: true,
})
afterAll(async () => {
  await dispose()
  rmSync(dir, { recursive: true, force: true })
})

const get = (path: string, accept = "text/html") => handler(new Request(`http://mekiki${path}`, { headers: { accept } }))

test("serves index.html at / and for the dashboard's own routes, never cached", async () => {
  for (const path of ["/", "/reviews/acme/api/7", "/settings?tab=rules"]) {
    const response = await get(path)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toStartWith("text/html")
    expect(response.headers.get("cache-control")).toBe("no-cache")
    expect(await response.text()).toContain("id=root")
  }
})

test("hashed assets are cached for good", async () => {
  const response = await get("/assets/index-abc123.js", "*/*")
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toStartWith("text/javascript")
  expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
})

test("a missing file is a 404, not index.html", async () => {
  const response = await get("/assets/gone-999.js", "*/*")
  expect(response.status).toBe(404)
  expect(response.headers.get("cache-control")).toBe("no-cache")
})

test("the api's routes win, and an unknown api path is the api's 404", async () => {
  expect((await get("/api/health", "application/json")).status).toBe(200)
  expect(await (await get("/api/auth/session")).text()).toBe("auth")
  const missing = await get("/api/nope")
  expect(missing.status).toBe(404)
  expect(await missing.json()).toEqual({ error: "not found" })
})

test("every response carries the security headers", async () => {
  for (const path of ["/", "/api/health"]) {
    const response = await get(path)
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("content-security-policy")).toBe(Dashboard.SECURITY_HEADERS["Content-Security-Policy"])
  }
})

test("without MEKIKI_WEB_DIR nothing is mounted", () => {
  expect(configFrom({}).webDir._tag).toBe("None")
})
