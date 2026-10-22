import { RegistryProvider } from "@effect/atom-react"
import { Toasty } from "@cloudflare/kumo/components/toast"
import { TooltipProvider } from "@cloudflare/kumo/components/tooltip"
import { type LinkComponentProps, LinkProvider } from "@cloudflare/kumo/utils"
import { createRouter, Link, RouterProvider } from "@tanstack/react-router"
import { forwardRef, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { toasts } from "./lib/toasts.ts"
import { routeTree } from "./routeTree.gen.ts"

const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: true })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

/** kumo's links (breadcrumbs and the like) navigate through the router when they stay in the app */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to, ...rest }, ref) => {
  // some kumo parts still pass the deprecated `to`
  const target = href ?? to
  return target?.startsWith("/") ? <Link ref={ref} to={target} {...rest} /> : <a ref={ref} href={target} {...rest} />
})

const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <StrictMode>
      <RegistryProvider>
        <LinkProvider component={AppLink}>
          <TooltipProvider>
            <Toasty toastManager={toasts}>
              <RouterProvider router={router} />
            </Toasty>
          </TooltipProvider>
        </LinkProvider>
      </RegistryProvider>
    </StrictMode>,
  )
