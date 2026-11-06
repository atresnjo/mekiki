// the service graph, shared by the server and the cli
import { Layer } from "effect"
import { Agent } from "./agent.ts"
import { Checkout } from "./checkout.ts"
import type { AppConfig } from "./config.ts"
import { Database } from "./database.ts"
import { GitHub } from "./github.ts"
import { Panel } from "./panel.ts"
import { Reviewer } from "./reviewer.ts"
import { Store } from "./store.ts"
import { Triggers } from "./triggers.ts"

export const layer = (config: AppConfig) => {
  const Adapters = Layer.mergeAll(
    GitHub.layer(config.github),
    Agent.layer(config.agent),
    // the database stays exposed too: signing in (auth.ts) starts once it has been migrated
    Store.layer({ defaults: config.defaults, clis: config.agent.clis }).pipe(Layer.provideMerge(Database.layer({ url: config.databaseUrl }))),
  )
  // the http routes use the store, the agents and the panel too, so they stay exposed
  return Reviewer.layer(config.limits, { resolveFixed: config.github.resolveFixed }).pipe(
    Layer.provideMerge(Layer.mergeAll(Panel.layer, Checkout.layer(config.checkouts), Triggers.layer(config.triggers))),
    Layer.provideMerge(Adapters),
  )
}
