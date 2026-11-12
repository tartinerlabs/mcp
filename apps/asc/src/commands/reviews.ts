import * as z from "zod";
import {
  type AscClient,
  type AscDocument,
  pageInfo,
  related,
} from "../asc/client.ts";
import { appIdSchema, commaList, limitSchema } from "../schemas/common.ts";

interface ReviewAttributes {
  rating?: number;
  title?: string;
  body?: string;
  reviewerNickname?: string;
  createdDate?: string;
  territory?: string;
}

interface ResponseAttributes {
  responseBody?: string;
  state?: string;
  lastModifiedDate?: string;
}

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
      limit: input.limit,
    },
  );
  return {
    reviews: response.data.map((review) => {
      const reply = related<ResponseAttributes>(response, review, "response");
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
    }),
    ...pageInfo(response),
  };
}
