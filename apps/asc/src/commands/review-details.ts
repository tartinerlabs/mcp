import { stat } from "node:fs/promises";
import { basename } from "node:path";
import * as z from "zod";
import type { AscClient, AscResource, UploadOperation } from "../asc/client.ts";
import { idSchema } from "../schemas/common.ts";
import {
  AscApiError,
  InvalidInputError,
  NotEditableError,
  NotFoundError,
  UnexpectedResponseError,
  UploadIncompleteError,
} from "../utils/errors.ts";
import { md5, sendParts } from "./build-upload.ts";
import { EDITABLE_STATES, readVersion } from "./metadata.ts";

/**
 * A version's App Review details: the contact App Review calls, the demo
 * account it signs in with, notes, and attachments such as a demo video.
 * The demo account password is a secret: it is sent to Apple but never
 * printed, and output only says whether one is set.
 *
 * Assumption: Apple's docs do not say in which version states App Review
 * details accept changes; like metadata, only a version being prepared or
 * rejected is changed here.
 */

const versionIdSchema = idSchema("versions");

/** The detail fields the update request accepts, other than the password. */
const FIELDS = [
  "contactFirstName",
  "contactLastName",
  "contactPhone",
  "contactEmail",
  "demoAccountRequired",
  "demoAccountName",
  "notes",
] as const;

type Field = (typeof FIELDS)[number];

interface DetailAttributes {
  contactFirstName?: string | null;
  contactLastName?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
  demoAccountRequired?: boolean | null;
  demoAccountName?: string | null;
  demoAccountPassword?: string | null;
  notes?: string | null;
}

interface AttachmentAttributes {
  fileName?: string;
  fileSize?: number;
  assetDeliveryState?: {
    state?: string;
    errors?: { code?: string; description?: string }[] | null;
  } | null;
  uploadOperations?: UploadOperation[] | null;
}

/** What output shows of an attachment: never its upload URLs. */
function shapeAttachment(attachment: AscResource<AttachmentAttributes>) {
  const state = attachment.attributes?.assetDeliveryState;
  return {
    id: attachment.id,
    fileName: attachment.attributes?.fileName,
    fileSize: attachment.attributes?.fileSize,
    state: state?.state,
    errors: (state?.errors ?? []).map(({ code, description }) => ({
      code,
      description,
    })),
  };
}

/**
 * The version's App Review details with their attachments, or null when it
 * has none yet. The password is read only to report whether one is set.
 */
export async function readReviewDetail(client: AscClient, versionId: string) {
  let response: {
    data: AscResource<DetailAttributes> | null;
    included?: AscResource[];
  };
  try {
    response = await client.get(
      `/v1/appStoreVersions/${versionId}/appStoreReviewDetail`,
      {
        include: "appStoreReviewAttachments",
        "fields[appStoreReviewDetails]": [
          ...FIELDS,
          "demoAccountPassword",
          "appStoreReviewAttachments",
        ],
        "fields[appStoreReviewAttachments]": [
          "fileName",
          "fileSize",
          "assetDeliveryState",
        ],
        "limit[appStoreReviewAttachments]": 50,
      },
    );
  } catch (error) {
    // Unverified: a version without details may answer 404 rather than null data.
    if (error instanceof AscApiError && error.status === 404) return null;
    throw error;
  }
  const { data } = response;
  if (!data) return null;
  const attributes = data.attributes ?? {};
  return {
    id: data.id,
    contactFirstName: attributes.contactFirstName ?? null,
    contactLastName: attributes.contactLastName ?? null,
    contactPhone: attributes.contactPhone ?? null,
    contactEmail: attributes.contactEmail ?? null,
    demoAccountRequired: attributes.demoAccountRequired ?? null,
    demoAccountName: attributes.demoAccountName ?? null,
    demoAccountPasswordSet: Boolean(attributes.demoAccountPassword),
    notes: attributes.notes ?? null,
    attachments: (response.included ?? [])
      .filter((item) => item.type === "appStoreReviewAttachments")
      .map((item) =>
        shapeAttachment(item as AscResource<AttachmentAttributes>),
      ),
  };
}

export type ReviewDetail = NonNullable<
  Awaited<ReturnType<typeof readReviewDetail>>
>;

/** The fields App Review needs that the details leave blank. */
export function missingReviewDetails(detail: ReviewDetail | null): string[] {
  const missing: string[] = [
    "contactFirstName",
    "contactLastName",
    "contactPhone",
    "contactEmail",
  ].filter((field) => !detail?.[field as Field]);
  if (detail?.demoAccountRequired) {
    if (!detail.demoAccountName) missing.push("demoAccountName");
    if (!detail.demoAccountPasswordSet) missing.push("demoAccountPassword");
  }
  return missing;
}

async function editableVersion(client: AscClient, versionId: string) {
  const version = await readVersion(client, versionId);
  if (!EDITABLE_STATES.has(version.state ?? "")) {
    throw new NotEditableError(
      `Version ${version.version} is ${version.state}, so its App Review details can no longer be changed. Use a version that is PREPARE_FOR_SUBMISSION or rejected.`,
    );
  }
  return version;
}

export const reviewDetailsInput = z.object({ versionId: versionIdSchema });

/** A version's App Review details and attachments, without the demo account password. */
export async function getReviewDetails(
  client: AscClient,
  input: z.output<typeof reviewDetailsInput>,
) {
  const version = await readVersion(client, input.versionId);
  const detail = await readReviewDetail(client, input.versionId);
  return {
    version,
    reviewDetail: detail,
    missing: missingReviewDetails(detail),
  };
}

const text = z.string().trim().min(1).max(4000).optional();

export const setReviewDetailsInput = z
  .object({
    versionId: versionIdSchema,
    contactFirstName: text,
    contactLastName: text,
    contactPhone: z
      .string()
      .trim()
      .regex(
        /^\+?[0-9 ()./-]{4,40}$/,
        "The contact phone must be a phone number such as +1 408 555 0100.",
      )
      .optional(),
    contactEmail: z
      .email("The contact email must be an email address.")
      .optional(),
    demoAccountRequired: z.boolean().optional(),
    demoAccountName: text,
    // No format check: a message about it must not echo the value.
    demoAccountPassword: z
      .string()
      .min(1, "The demo account password must not be empty.")
      .optional(),
    notes: text,
    yes: z.boolean().default(false),
  })
  .refine(
    (input) =>
      FIELDS.some((field) => input[field] !== undefined) ||
      input.demoAccountPassword !== undefined,
    {
      message:
        "Give at least one field to change, such as --contact-email or --notes.",
    },
  );

const HIDDEN = "[hidden]";

/** Replaces the password wherever Apple's error body repeats it. */
function withoutSecret(error: unknown, secret: string | undefined): unknown {
  if (!secret || !(error instanceof AscApiError)) return error;
  const escaped = JSON.stringify(secret).slice(1, -1);
  const body = JSON.stringify(error.data ?? null);
  if (!body.includes(escaped)) return error;
  return new AscApiError(
    error.status,
    JSON.parse(body.replaceAll(escaped, HIDDEN)),
  );
}

/**
 * Sets a version's App Review details, creating them if it has none. The
 * password is always sent when given, since it cannot be compared without
 * printing it, and shows as "[hidden]".
 */
export async function setReviewDetails(
  client: AscClient,
  input: z.output<typeof setReviewDetailsInput>,
) {
  const version = await editableVersion(client, input.versionId);
  const detail = await readReviewDetail(client, input.versionId);
  const current: Partial<Record<Field, string | boolean | null>> = {};
  const update: Partial<Record<Field, string | boolean>> = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    current[field] = detail?.[field] ?? null;
    if (current[field] !== value) update[field] = value;
  }
  const password = input.demoAccountPassword;
  const changed: string[] = Object.keys(update);
  if (password !== undefined) changed.push("demoAccountPassword");
  const base = {
    action: "review-details",
    version,
    reviewDetailId: detail?.id ?? null,
    current,
    update: {
      ...update,
      ...(password === undefined ? {} : { demoAccountPassword: HIDDEN }),
    },
  };
  if (!input.yes) {
    return { dryRun: true, ...base, changes: changed.length > 0 };
  }
  const attributes = {
    ...update,
    ...(password === undefined ? {} : { demoAccountPassword: password }),
  };
  let id = detail?.id ?? null;
  try {
    if (!detail) {
      const created = await client.post<{ data: AscResource }>(
        "/v1/appStoreReviewDetails",
        {
          data: {
            type: "appStoreReviewDetails",
            attributes,
            relationships: {
              appStoreVersion: {
                data: { type: "appStoreVersions", id: input.versionId },
              },
            },
          },
        },
      );
      id = created.data.id;
    } else if (changed.length > 0) {
      await client.patch(`/v1/appStoreReviewDetails/${detail.id}`, {
        data: { type: "appStoreReviewDetails", id: detail.id, attributes },
      });
    }
  } catch (error) {
    throw withoutSecret(error, password);
  }
  return { dryRun: false, ...base, reviewDetailId: id, changed };
}

export const attachInput = z.object({
  versionId: versionIdSchema,
  file: z.string().min(1),
  yes: z.boolean().default(false),
});

/**
 * Uploads a file, such as a demo video, as an App Review attachment: it is
 * reserved, sent in the parts Apple's response lists, and committed with its
 * MD5 checksum. Creates the version's App Review details if it has none.
 */
export async function attachReviewFile(
  client: AscClient,
  input: z.output<typeof attachInput>,
) {
  let fileSize: number;
  try {
    const info = await stat(input.file);
    if (!info.isFile()) throw new Error("not a file");
    fileSize = info.size;
  } catch {
    throw new NotFoundError(`Could not read the file ${input.file}.`);
  }
  const fileName = basename(input.file);
  if (fileSize === 0) throw new InvalidInputError(`${fileName} is empty.`);
  const version = await editableVersion(client, input.versionId);
  const detail = await readReviewDetail(client, input.versionId);
  const base = {
    action: "review-details attach",
    version,
    reviewDetailId: detail?.id ?? null,
    file: { fileName, fileSize },
  };
  if (!input.yes) return { dryRun: true, ...base };

  let detailId = detail?.id;
  if (!detailId) {
    const created = await client.post<{ data: AscResource }>(
      "/v1/appStoreReviewDetails",
      {
        data: {
          type: "appStoreReviewDetails",
          relationships: {
            appStoreVersion: {
              data: { type: "appStoreVersions", id: input.versionId },
            },
          },
        },
      },
    );
    detailId = created.data.id;
  }
  const checksum = await md5(input.file);
  const { data: reserved } = await client.post<{
    data: AscResource<AttachmentAttributes>;
  }>("/v1/appStoreReviewAttachments", {
    data: {
      type: "appStoreReviewAttachments",
      attributes: { fileName, fileSize },
      relationships: {
        appStoreReviewDetail: {
          data: { type: "appStoreReviewDetails", id: detailId },
        },
      },
    },
  });
  try {
    const operations = reserved.attributes?.uploadOperations ?? [];
    if (operations.length === 0) {
      throw new UnexpectedResponseError(
        "App Store Connect reserved the attachment but gave no upload operations.",
      );
    }
    await sendParts(client, input.file, fileSize, operations);
    await client.patch(`/v1/appStoreReviewAttachments/${reserved.id}`, {
      data: {
        type: "appStoreReviewAttachments",
        id: reserved.id,
        attributes: { uploaded: true, sourceFileChecksum: checksum },
      },
    });
  } catch (error) {
    throw new UploadIncompleteError(
      `The attachment ${reserved.id} was reserved but not committed; remove it with review-details detach ${reserved.id} and run the command again.`,
      { cause: error },
    );
  }
  const { data: committed } = await client.get<{
    data: AscResource<AttachmentAttributes>;
  }>(`/v1/appStoreReviewAttachments/${reserved.id}`, {
    "fields[appStoreReviewAttachments]": [
      "fileName",
      "fileSize",
      "assetDeliveryState",
    ],
  });
  return {
    dryRun: false,
    ...base,
    reviewDetailId: detailId,
    attachment: shapeAttachment(committed),
  };
}

export const detachInput = z.object({
  attachmentId: idSchema("review-details"),
  yes: z.boolean().default(false),
});

/** Removes an App Review attachment from a version being prepared or rejected. */
export async function detachReviewFile(
  client: AscClient,
  input: z.output<typeof detachInput>,
) {
  const { data: attachment } = await client.get<{
    data: AscResource<AttachmentAttributes>;
  }>(`/v1/appStoreReviewAttachments/${input.attachmentId}`, {
    "fields[appStoreReviewAttachments]": [
      "fileName",
      "fileSize",
      "assetDeliveryState",
      "appStoreReviewDetail",
    ],
    include: "appStoreReviewDetail",
    "fields[appStoreReviewDetails]": ["appStoreVersion"],
  });
  const detailId = attachment.relationships?.appStoreReviewDetail?.data?.id;
  const detail = detailId
    ? await client.get<{ data: AscResource }>(
        `/v1/appStoreReviewDetails/${detailId}`,
        {
          "fields[appStoreReviewDetails]": ["appStoreVersion"],
          include: "appStoreVersion",
          "fields[appStoreVersions]": ["versionString"],
        },
      )
    : undefined;
  const versionId = detail?.data.relationships?.appStoreVersion?.data?.id;
  if (!versionId) {
    throw new NotFoundError(
      `App Store Connect returned attachment ${input.attachmentId} without its version.`,
    );
  }
  const version = await editableVersion(client, versionId);
  const base = {
    action: "review-details detach",
    version,
    attachment: shapeAttachment(attachment),
  };
  if (!input.yes) return { dryRun: true, ...base };
  await client.delete(`/v1/appStoreReviewAttachments/${input.attachmentId}`);
  return { dryRun: false, ...base };
}
