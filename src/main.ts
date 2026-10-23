// glance server: the rpc api, sign-in, health and the github webhook. the dashboard is its own app (web/)
import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import * as App from "./app.ts"
import { AppConfig } from "./config.ts"
import { Health } from "./health.ts"
import * as Http from "./http.ts"
import { Observability } from "./observability.ts"
import * as Rpc from "./rpc-server.ts"
import { Session } from "./session.ts"

const Main = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const Routes = Layer.mergeAll(Http.routes(config), Rpc.routes(config), Session.routes(config), Health.routes)
    const Services = Layer.mergeAll(Health.layer, Session.layer(config)).pipe(Layer.provideMerge(App.layer(config)))
    return HttpRouter.serve(Routes).pipe(
      Layer.provide(Services),
      // the review stream's heartbeat keeps its connection busier than this
      // the largest request anything here takes is a webhook delivery (github's own cap is 25 MB)
      Layer.provide(BunHttpServer.layer({ port: config.port, hostname: config.host, idleTimeout: 60, maxRequestBodySize: 32 * 1024 * 1024 })),
      Layer.tap(() => Effect.log(`glance api on http://${config.host}:${config.port}`)),
      Layer.provide(Observability.layer(config.observability)),
    )
  }),
)

Layer.launch(Main).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
