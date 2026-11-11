import * as z from "zod";

export const siteUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(
    /^https?:\/\/\S+$/i,
    "Must be an http(s) URL, as returned by list_sites.",
  )
  .describe("The verified site URL exactly as list_sites returns it.");

export const pageUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .regex(/^https?:\/\/\S+$/i, "Must be an absolute http(s) URL.")
  .describe("The absolute URL of a page on the site.");

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be a YYYY-MM-DD date.");

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(500)
  .default(50)
  .describe("Maximum number of rows (1-500, default 50).");
