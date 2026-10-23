// drizzle-kit: `bun db:generate` diffs src/schema.ts against drizzle/ and writes the migration
import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./drizzle",
})
