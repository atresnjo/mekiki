import { createFileRoute } from "@tanstack/react-router"
import { Skeleton } from "skullet/react"
import { Overview } from "../components/overview.tsx"
import { useNow } from "../components/ui.tsx"
import { useReviews } from "../lib/glance.ts"
import { SAMPLE_REVIEWS } from "../lib/samples.ts"

export const Route = createFileRoute("/")({ component: Home })

function Home() {
  const reviews = useReviews()
  const now = useNow(reviews?.some((r) => r.status === "running") ?? false)
  return (
    <Skeleton id="overview" data={reviews} sample={SAMPLE_REVIEWS} label="Loading reviews">
      {(reviews) => <Overview reviews={reviews} now={now} />}
    </Skeleton>
  )
}
