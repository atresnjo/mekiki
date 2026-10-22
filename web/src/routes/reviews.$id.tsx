import { createFileRoute } from "@tanstack/react-router"
import { ReviewPage } from "../components/detail.tsx"
import { useNow } from "../components/ui.tsx"
import { useReviews } from "../lib/glance.ts"

export const Route = createFileRoute("/reviews/$id")({ component: Review })

function Review() {
  const { id } = Route.useParams()
  const review = useReviews().find((r) => r.id === Number(id))
  const now = useNow(review?.status === "running")
  return <ReviewPage review={review} now={now} />
}
