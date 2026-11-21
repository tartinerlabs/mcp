import * as z from "zod";
import type { AscClient, AscDocument, AscResource } from "../asc/client.ts";
import { appIdSchema, idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  classifyError,
  InvalidInputError,
  NotEditableError,
} from "../utils/errors.ts";
import { EDITABLE_STATES } from "./app-info.ts";

/** Apple changes the questions over time, so answers are whatever the API returns. */
type Answers = Record<string, unknown>;

function getDeclaration(client: AscClient, appInfoId: string) {
  return client.get<{ data: AscResource<Answers> }>(
    `/v1/appInfos/${appInfoId}/ageRatingDeclaration`,
  );
}

export const ageRatingInput = z.object({ appId: appIdSchema });

/**
 * Each app info's state, App Store age rating and its age rating
 * declaration with every answer the API returns.
 */
export async function getAgeRating(
  client: AscClient,
  input: z.output<typeof ageRatingInput>,
) {
  const response = await client.get<
    AscDocument<{ state?: string; appStoreAgeRating?: string | null }>
  >(`/v1/apps/${input.appId}/appInfos`, {
    "fields[appInfos]": ["state", "appStoreAgeRating"],
    limit: 200,
  });
  const appInfos = [];
  for (const appInfo of response.data) {
    const { data } = await getDeclaration(client, appInfo.id);
    appInfos.push({
      id: appInfo.id,
      state: appInfo.attributes?.state,
      appStoreAgeRating: appInfo.attributes?.appStoreAgeRating ?? null,
      declaration: { id: data.id, answers: data.attributes ?? {} },
    });
  }
  return { appInfos };
}

const ANSWER = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/s;

export const setAgeRatingInput = z.object({
  appInfoId: idSchema("app-info"),
  answers: z
    .array(
      z
        .string()
        .regex(
          ANSWER,
          "Give each answer as name=value, such as gambling=false.",
        ),
    )
    .min(1, "Give at least one --answer name=value, such as gambling=false.")
    .refine(
      (answers) =>
        new Set(answers.map((answer) => answer.split("=")[0])).size ===
        answers.length,
      { message: "Give each answer once." },
    ),
  yes: z.boolean().default(false),
});

/**
 * Changes answers in an app info's age rating declaration. Only an app info
 * being prepared or rejected accepts changes. Names must be ones the API
 * returns for the declaration; a value is sent as a boolean when the current
 * answer is one (or is unset and the value is true or false), otherwise as
 * text, and Apple checks it. Without `yes`, shows the current and new answers.
 */
export async function setAgeRating(
  client: AscClient,
  input: z.output<typeof setAgeRatingInput>,
) {
  const { data: appInfo } = await client.get<{
    data: AscResource<{ state?: string }>;
  }>(`/v1/appInfos/${input.appInfoId}`, { "fields[appInfos]": ["state"] });
  const state = appInfo.attributes?.state;
  if (!EDITABLE_STATES.has(state ?? "")) {
    throw new NotEditableError(
      `App info ${input.appInfoId} is ${state}, so its age rating can no longer be changed. Use the app info that is PREPARE_FOR_SUBMISSION or rejected; the age-rating command lists them.`,
    );
  }
  const { data: declaration } = await getDeclaration(client, input.appInfoId);
  const existing = declaration.attributes ?? {};
  const current: Answers = {};
  const update: Answers = {};
  for (const answer of input.answers) {
    const [, name = "", raw = ""] = ANSWER.exec(answer) ?? [];
    if (!(name in existing)) {
      throw new InvalidInputError(
        `The age rating declaration has no question named ${name}; the age-rating command lists the current ones.`,
      );
    }
    const now = existing[name];
    const value = raw.trim();
    current[name] = now ?? null;
    update[name] =
      (typeof now === "boolean" || now == null) &&
      (value === "true" || value === "false")
        ? value === "true"
        : value;
  }
  const changed = Object.keys(update).filter(
    (name) => current[name] !== update[name],
  );
  if (!input.yes) {
    return {
      dryRun: true,
      action: "age-rating",
      appInfo: { id: input.appInfoId, state },
      declarationId: declaration.id,
      current,
      update,
      changes: changed.length > 0,
    };
  }
  if (changed.length > 0) {
    try {
      await client.patch(`/v1/ageRatingDeclarations/${declaration.id}`, {
        data: {
          type: "ageRatingDeclarations",
          id: declaration.id,
          attributes: Object.fromEntries(
            changed.map((name) => [name, update[name]]),
          ),
        },
      });
    } catch (error) {
      // Apple answers 409 (or 422) when it does not accept the values.
      if (
        error instanceof AscApiError &&
        (error.status === 409 || error.status === 422)
      ) {
        throw new InvalidInputError(
          `App Store Connect rejected the age rating answers ${changed.join(", ")}: a frequency answer takes NONE, INFREQUENT_OR_MILD or FREQUENT_OR_INTENSE, and the age-rating command shows the current answers. ${classifyError(error).message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  return {
    dryRun: false,
    action: "age-rating",
    appInfoId: input.appInfoId,
    declarationId: declaration.id,
    changed,
  };
}
