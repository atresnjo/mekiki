// the built dashboard (web/dist), served by the api itself when MEKIKI_WEB_DIR names it. the docker image
// does: the dashboard and the api share one origin (the session cookie and the rpc need that), and all that
// goes in front is whatever does https. while developing, vite serves the dashboard instead
import { Effect, FileSystem, Layer, Option, Path } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerRespondable, HttpServerResponse, HttpStaticServer } from "effect/http"
import type { AppConfig } from "./config.ts"

/** on every response, the api's too */
export const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // scripts and data from this origin only; kumo and echarts set inline styles; avatars come from github or the sso
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
} as const

/** vite's file names carry a content hash: cached for good. everything else (index.html) is checked each time */
const cacheControl = (pathname: string, status: number) =>
  pathname.startsWith("/assets/") && status < 300 ? "public, max-age=31536000, immutable" : "no-cache"

const files = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    // a wrong MEKIKI_WEB_DIR is a broken deploy: say so at startup, not with a 404 for every visitor
    if (!(yield* fs.exists(path.join(dir, "index.html")).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* Effect.die(`MEKIKI_WEB_DIR=${dir} has no index.html: build the dashboard (bun run build) or unset it`)
    }
    // any path that isn't a file gets index.html: the dashboard routes in the browser
    const serve = yield* HttpStaticServer.make({ root: dir, spa: true })
    return Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const pathname = request.url.split("?")[0] ?? "/"
      // an api path nothing answers is the api's 404, not the dashboard
      if (pathname === "/api" || pathname.startsWith("/api/")) return HttpServerResponse.jsonUnsafe({ error: "not found" }, { status: 404 })
      const response = yield* serve.pipe(Effect.catch(HttpServerRespondable.toResponse))
      return HttpServerResponse.setHeader(response, "Cache-Control", cacheControl(pathname, response.status))
    })
  })

const securityHeaders = HttpRouter.middleware((app) => Effect.map(app, HttpServerResponse.setHeaders(SECURITY_HEADERS)), { global: true })

/** GET /* (whatever the api's own routes don't take): the dashboard. nothing when MEKIKI_WEB_DIR isn't set */
export const routes = (config: AppConfig) =>
  Option.match(config.webDir, {
    onNone: () => Layer.empty,
    onSome: (dir) => Layer.mergeAll(Layer.unwrap(Effect.map(files(dir), (handler) => HttpRouter.add("GET", "/*", handler))), securityHeaders),
  })

export * as Dashboard from "./dashboard.ts"
