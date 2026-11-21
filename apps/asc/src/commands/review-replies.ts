import * as z from "zod";
import type { AscClient, AscResource } from "../asc/client.ts";
import { NotFoundError } from "../utils/errors.ts";
import {
  REVIEW_QUERY,
  type ResponseAttributes,
  type ReviewAttributes,
  shapeReview,
} from "./reviews.ts";

/** Review IDs are opaque; letters, digits and hyphens keep them to one path segment. */
const reviewIdSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9-]{1,100}$/,
    "Must be a review id from the reviews command.",
  );

export const replyInput = z.object({
  reviewId: reviewIdSchema,
  body: z.string().trim().min(1, "The reply is empty."),
  yes: z.boolean().default(false),
});

export const deleteReplyInput = z.object({
  reviewId: reviewIdSchema,
  yes: z.boolean().default(false),
});

interface ReviewDocument {
  data: AscResource<ReviewAttributes>;
  included?: AscResource[];
}

interface ResponseDocument {
  data: AscResource<ResponseAttributes>;
}

/** The review as `reviews` prints it, plus the ID of its developer response, if any. */
async function readReview(client: AscClient, reviewId: string) {
  const document = await client.get<ReviewDocument>(
    `/v1/customerReviews/${reviewId}`,
    REVIEW_QUERY,
  );
  return {
    review: shapeReview(document, document.data),
    responseId: document.data.relationships?.response?.data?.id,
  };
}

/**
 * Posts a public reply to a review, replacing the existing one if there is
 * one. Without `yes`, only shows what would be posted.
 */
export async function replyToReview(
  client: AscClient,
  input: z.output<typeof replyInput>,
) {
  const { review, responseId } = await readReview(client, input.reviewId);
  const replaces = responseId !== undefined;
  if (!input.yes) {
    return {
      dryRun: true,
      action: "reply",
      review,
      replaces,
      responseBody: input.body,
    };
  }
  const created = await client.post<ResponseDocument>(
    "/v1/customerReviewResponses",
    {
      data: {
        type: "customerReviewResponses",
        attributes: { responseBody: input.body },
        relationships: {
          review: { data: { type: "customerReviews", id: input.reviewId } },
        },
      },
    },
  );
  return {
    dryRun: false,
    action: "reply",
    reviewId: input.reviewId,
    replaced: replaces,
    response: {
      id: created.data.id,
      responseBody: created.data.attributes?.responseBody,
      state: created.data.attributes?.state,
      lastModifiedDate: created.data.attributes?.lastModifiedDate,
    },
  };
}

/** Deletes the developer response to a review. Without `yes`, only shows what would be deleted. */
export async function deleteReviewReply(
  client: AscClient,
  input: z.output<typeof deleteReplyInput>,
) {
  const { review, responseId } = await readReview(client, input.reviewId);
  if (responseId === undefined) {
    throw new NotFoundError(
      `Review ${input.reviewId} has no developer response to delete.`,
    );
  }
  if (!input.yes) {
    return { dryRun: true, action: "delete-reply", review };
  }
  await client.delete(`/v1/customerReviewResponses/${responseId}`);
  return {
    dryRun: false,
    action: "delete-reply",
    reviewId: input.reviewId,
    deletedResponseId: responseId,
  };
}
