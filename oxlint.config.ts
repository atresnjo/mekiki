import { defineConfig } from "oxlint"

export default defineConfig({
  ignorePatterns: ["web/src/routeTree.gen.ts", "web/.tanstack/**", ".tanstack/**", "web/dist/**", ".claude/**"],
})
