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

export const layer = (config: AppConfig) => {
  const Adapters = Layer.mergeAll(
    GitHub.layer(config.github),
    Agent.layer(config.agent),
    Store.layer({ defaults: config.defaults }).pipe(Layer.provide(Database.layer({ url: config.databaseUrl }))),
  )
  // the http routes use the store, the agents and the panel too, so they stay exposed
  return Reviewer.layer(config.limits).pipe(Layer.provideMerge(Layer.mergeAll(Panel.layer, Checkout.layer(config.checkouts))), Layer.provideMerge(Adapters))
}
