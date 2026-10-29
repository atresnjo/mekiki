import tailwindcss from "@tailwindcss/vite"
import { tanstackRouter } from "@tanstack/router-plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// in development the api is proxied, so the dashboard and the api share an origin
const api = process.env.GLANCE_API_URL ?? "http://127.0.0.1:7420"
// one prefix: the rpc (/api/rpc) and the webhook. it ends in "/" so a page named /api… stays the app's
const proxy = { "/api/": api }
// `bun run tunnel`'s address: vite turns away hosts it doesn't know. vite runs on node, which doesn't
// read the repository's .env the way bun does, so it's read here
const tunnel = process.env.GLANCE_TUNNEL_HOSTNAME || loadEnv("development", `${import.meta.dirname}/..`, "GLANCE_TUNNEL_").GLANCE_TUNNEL_HOSTNAME
const allowedHosts = tunnel ? [tunnel] : []

export default defineConfig({
  // @glance/api is the contract in ../src/rpc.ts (tsconfig paths)
  resolve: { tsconfigPaths: true },
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: { port: 7421, proxy, allowedHosts },
  preview: { port: 7421, proxy, allowedHosts },
  // the charts chunk is echarts (~650 kB, ~220 kB compressed): loaded lazily after the page and
  // cached for good (hashed name, immutable), so it isn't worth splitting further
  build: { chunkSizeWarningLimit: 700 },
})
