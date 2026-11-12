import * as z from "zod";

/** Apple's API key IDs are 10 uppercase letters and digits, e.g. 2X9R4HXF34. */
const KEY_ID_PATTERN = /^[A-Z0-9]{10}$/;
const GUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An App Store Connect API key: a team key names its issuer, an individual key does not. */
export const keySchema = z.object({
  keyId: z
    .string()
    .trim()
    .regex(
      KEY_ID_PATTERN,
      "The key ID must be 10 characters such as 2X9R4HXF34.",
    ),
  issuerId: z
    .string()
    .trim()
    .refine((value) => value === "" || GUID_PATTERN.test(value), {
      message: "The issuer ID must be the one shown above the team's keys.",
    })
    .default(""),
  /** The contents of the `.p8` file. */
  privateKey: z.string(),
});

export type AscKey = z.output<typeof keySchema>;

export const appIdSchema = z
  .string()
  .trim()
  .regex(/^\d{1,20}$/, "Must be a numeric App Store Connect app ID.");

export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

/** A comma-separated option value, such as `IN_REVIEW,REJECTED`. */
export function commaList<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) =>
      typeof value === "string"
        ? value.split(",").map((part) => part.trim())
        : value,
    z.array(item).min(1).optional(),
  );
}

export const PLATFORMS = ["IOS", "MAC_OS", "TV_OS", "VISION_OS"] as const;
