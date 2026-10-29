// a fixed https address for glance while developing: a named cloudflare tunnel on a domain of yours.
// `bun run tunnel`. the first run creates the tunnel and its dns record; after that it only runs it.
// needs `cloudflared tunnel login` once (it picks the domain), and in .env:
//
//   GLANCE_TUNNEL_HOSTNAME=glance.skela.dev   where it answers
//   GLANCE_TUNNEL=glance                      the tunnel's name (default: glance)
//
// it points at the dashboard (vite, 7421), which hands /api/ on to the server: the webhook, the rpc and
// signing in all work through it. the server keeps listening on 127.0.0.1, so it stays a development glance
import { $ } from "bun"

const name = process.env.GLANCE_TUNNEL || "glance"
const hostname = process.env.GLANCE_TUNNEL_HOSTNAME
const target = process.env.GLANCE_TUNNEL_TARGET || "http://127.0.0.1:7421"
if (!hostname) {
  console.error("set GLANCE_TUNNEL_HOSTNAME in .env: the address on your domain, e.g. glance.skela.dev")
  process.exit(1)
}

const tunnels: ReadonlyArray<{ readonly name: string }> = JSON.parse(await $`cloudflared tunnel list --output json`.text())
if (!tunnels.some((t) => t.name === name)) {
  await $`cloudflared tunnel create ${name}`
  console.log(`created the tunnel ${name}`)
}
// the record is the tunnel's from here on: running this again leaves an existing one alone
await $`cloudflared tunnel route dns ${name} ${hostname}`.nothrow()

console.log(`https://${hostname} → ${target}
  webhook:          https://${hostname}/api/webhooks/github
  BETTER_AUTH_URL:  https://${hostname}
  github callback:  https://${hostname}/api/auth/callback/github`)
await $`cloudflared tunnel run --url ${target} ${name}`
