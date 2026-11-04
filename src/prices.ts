// what a review costs, estimated: dollars per million tokens, by model. edit the table, or set
// MEKIKI_PRICES to add or replace entries without a rebuild. a model that isn't here gets no estimate
// (the dashboard shows its tokens alone). cache writes are counted at the input price
import { Schema } from "effect"
import type { Usage } from "./domain.ts"

export const Price = Schema.Struct({ input: Schema.Finite, cachedInput: Schema.Finite, output: Schema.Finite })
export interface Price extends Schema.Schema.Type<typeof Price> {}

/** MEKIKI_PRICES: `{"my-model": {"input": 1, "cachedInput": 0.1, "output": 5}}` */
export const Prices = Schema.Record(Schema.String, Price)
export type Prices = typeof Prices.Type

const p = (input: number, cachedInput: number, output: number): Price => ({ input, cachedInput, output })

export const PRICES: Prices = {
  // anthropic's list prices, checked 2026-10
  "claude-fable-5-1": p(10, 0.25, 50),
  "claude-fable-5": p(10, 1, 50),
  "claude-opus-5-5": p(4, 0.2, 20),
  "claude-opus-5": p(5, 0.5, 25),
  "claude-opus-4-8": p(5, 0.5, 25),
  "claude-opus-4-7": p(5, 0.5, 25),
  "claude-opus-4-6": p(5, 0.5, 25),
  "claude-sonnet-5-5": p(2, 0.2, 10),
  "claude-sonnet-5": p(2, 0.2, 10),
  "claude-sonnet-4-6": p(3, 0.3, 15),
  "claude-haiku-5-5": p(0.1, 0.01, 0.5),
  "claude-haiku-4-5": p(1, 0.1, 5),
  // openai's, as third-party listings gave them in 2026-10: check openai.com/api/pricing before trusting them
  "gpt-6-astra": p(10, 1, 50),
  "gpt-6-sol": p(2, 0.1, 10),
  "gpt-6-luna": p(0.1, 0.01, 0.5),
  "gpt-5.6-sol": p(5, 0.5, 30),
  "gpt-5.6-terra": p(2.5, 0.25, 15),
  "gpt-5.6-luna": p(1, 0.1, 6),
}

/** a model as a gateway or a dated snapshot names it: `anthropic/claude-sonnet-5-5`, `gpt-6-sol-2026-09-01` */
const bare = (model: string) =>
  model
    .trim()
    .toLowerCase()
    .replace(/^.*\//, "")
    .replace(/-\d{4}-\d{2}-\d{2}$|-\d{8}$/, "")

export const priceOf = (model: string, prices: Prices = PRICES): Price | undefined => prices[bare(model)] ?? prices[model]

/** dollars, or null when the model has no price */
export const estimate = (model: string, tokens: Omit<Usage, "calls" | "costUsd">, prices: Prices = PRICES): number | null => {
  const price = priceOf(model, prices)
  if (!price) return null
  const fresh = Math.max(0, tokens.inputTokens - tokens.cachedInputTokens)
  return (fresh * price.input + tokens.cachedInputTokens * price.cachedInput + tokens.outputTokens * price.output) / 1_000_000
}

export * as Pricing from "./prices.ts"
