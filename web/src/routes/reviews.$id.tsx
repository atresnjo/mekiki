import { createFileRoute } from "@tanstack/react-router"
import { Skeleton } from "skullet/react"
import { ReviewPage } from "../components/detail.tsx"
import { useNow } from "../components/ui.tsx"
import { useReviews } from "../lib/glance.ts"
import { SAMPLE_REVIEW } from "../lib/samples.ts"

export const Route = createFileRoute("/reviews/$id")({ component: Review })

function Review() {
  const { id } = Route.useParams()
  const reviews = useReviews()
  const review = reviews?.find((r) => r.id === Number(id))
  const now = useNow(review?.status === "running")
  // loading until the feed connects; after that a missing review is "not found", not a skeleton
  return (
    <Skeleton id={`review-${id}`} data={reviews && { review }} sample={{ review: SAMPLE_REVIEW }} label="Loading review">
      {({ review }) => <ReviewPage review={review} now={now} />}
    </Skeleton>
  )
}
