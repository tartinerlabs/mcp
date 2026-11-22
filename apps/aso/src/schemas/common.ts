import * as z from "zod";

export const countrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z]{2}$/, {
    message:
      "country must be a two-letter App Store storefront code such as us, gb or de.",
  });

export const termSchema = z
  .string()
  .trim()
  .min(1, { message: "A search term cannot be empty." })
  .max(100, { message: "A search term is at most 100 characters." });

export const appIdSchema = z.coerce
  .number({
    message:
      "An app ID is the digits after id in its App Store URL (apps.apple.com/…/id123456789).",
  })
  .int()
  .positive();

export const filePathSchema = z.string().trim().min(1);
