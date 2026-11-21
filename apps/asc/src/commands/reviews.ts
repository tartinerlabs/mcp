import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  type AscQuery,
  type AscResource,
  pageInfo,
  related,
} from "../asc/client.ts";
import {
  appIdSchema,
  commaList,
  cursorSchema,
  limitSchema,
} from "../schemas/common.ts";

export interface ReviewAttributes {
  rating?: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  createdDate?: string;
  territory?: string;
}

export interface ResponseAttributes {
  responseBody?: string;
  state?: string;
  lastModifiedDate?: string;
}

/** Fields for a review and its included developer response. */
export const REVIEW_QUERY = {
  include: "response",
  "fields[customerReviews]": [
    "rating",
    "title",
    "body",
    "reviewerNickname",
    "createdDate",
    "territory",
    "response",
  ],
  "fields[customerReviewResponses]": [
    "responseBody",
    "state",
    "lastModifiedDate",
  ],
} satisfies AscQuery;

export const reviewsInput = z.object({
  appId: appIdSchema,
  rating: commaList(z.coerce.number().int().min(1).max(5)),
  territory: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/, "Must be an ISO 3166-1 alpha-3 code such as USA.")
    .optional(),
  hasResponse: z.boolean().optional(),
  sort: z
    .enum(["-createdDate", "createdDate", "-rating", "rating"])
    .default("-createdDate"),
  limit: limitSchema,
  cursor: cursorSchema,
});

export async function listReviews(
  client: AscClient,
  input: z.output<typeof reviewsInput>,
) {
  const response = await client.get<AscDocument<ReviewAttributes>>(
    `/v1/apps/${input.appId}/customerReviews`,
    {
      "filter[rating]": input.rating?.map(String),
      "filter[territory]": input.territory,
      "exists[publishedResponse]": input.hasResponse,
      sort: input.sort,
      ...REVIEW_QUERY,
      limit: input.limit,
      cursor: input.cursor,
    },
  );
  return {
    reviews: response.data.map((review) => shapeReview(response, review)),
    ...pageInfo(response),
  };
}

/** A review with its developer response, as `reviews` prints it. */
export function shapeReview(
  document: Pick<AscDocument<unknown>, "included">,
  review: AscResource<ReviewAttributes>,
) {
  const reply = related<ResponseAttributes>(document, review, "response");
  return {
    id: review.id,
    rating: review.attributes?.rating,
    title: review.attributes?.title,
    body: review.attributes?.body,
    reviewerNickname: review.attributes?.reviewerNickname,
    createdDate: review.attributes?.createdDate,
    territory: review.attributes?.territory,
    response: reply && {
      responseBody: reply.responseBody,
      state: reply.state,
      lastModifiedDate: reply.lastModifiedDate,
    },
  };
}
