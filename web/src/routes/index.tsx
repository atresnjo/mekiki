import { createFileRoute } from "@tanstack/react-router"
import { Overview } from "../components/overview.tsx"
import { useNow } from "../components/ui.tsx"
import { useReviews } from "../lib/glance.ts"

export const Route = createFileRoute("/")({ component: Home })

function Home() {
  const reviews = useReviews()
  const now = useNow(reviews.some((r) => r.status === "running"))
  return <Overview reviews={reviews} now={now} />
}
