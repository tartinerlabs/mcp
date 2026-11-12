import { Command } from "commander";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { IndexNowClient } from "./indexnow/client.ts";
import { checkKeyFile, isCoveredBy, keyFileUrl } from "./indexnow/key.ts";
import { runSubmission } from "./indexnow/submission.ts";
import {
  keyLocationSchema,
  keySchema,
  parsePublicUrl,
  publicUrlSchema,
} from "./schemas/common.ts";
import { classifyError } from "./utils/errors.ts";

// IndexNow accepts up to 10,000 URLs in one POST.
const MAX_URLS = 10_000;
const KIND_PREFIX = /^\[[a-z_]+\] /;

const submitSchema = z
  .object({
    urls: z.array(publicUrlSchema).min(1).max(MAX_URLS),
    key: keySchema,
    keyLocation: keyLocationSchema,
  })
  .superRefine((input, ctx) => {
    // Field checks already reported unparsable URLs.
    const urls = input.urls.map(parsePublicUrl);
    const keyLocation =
      input.keyLocation === undefined
        ? undefined
        : parsePublicUrl(input.keyLocation);
    if (
      urls.length === 0 ||
      urls.includes(undefined) ||
      (input.keyLocation !== undefined && keyLocation === undefined)
    ) {
      return;
    }
    const host = urls[0]?.host;
    if (urls.some((url) => url?.host !== host)) {
      ctx.addIssue({
        code: "custom",
        path: ["urls"],
        message: "All urls must be on one host. Run once per host.",
      });
      return;
    }
    if (
      keyLocation !== undefined &&
      input.urls.some((url) => !isCoveredBy(url, keyLocation.href))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["keyLocation"],
        message:
          "keyLocation must be on the same host as the urls, in their directory or above.",
      });
    }
  });

const verifySchema = z
  .object({
    url: publicUrlSchema,
    key: keySchema,
    keyLocation: keyLocationSchema,
  })
  .refine(
    (input) =>
      input.keyLocation === undefined ||
      // Field checks already reported unparsable URLs.
      parsePublicUrl(input.url) === undefined ||
      parsePublicUrl(input.keyLocation) === undefined ||
      isCoveredBy(input.url, input.keyLocation),
    {
      message:
        "keyLocation must be on the same host as url, in its directory or above.",
      path: ["keyLocation"],
    },
  );

interface KeyOptions {
  key: string;
  keyLocation?: string;
}

/** Validates the arguments, ending the command with `[invalid_input]` when they fail. */
function parseInput<T>(schema: z.ZodType<T>, input: unknown, command: Command) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  return command.error(`[invalid_input] ${z.prettifyError(parsed.error)}`);
}

/** The "[kind] message" line for a failure; runSubmission's errors already have one. */
function failureMessage(error: unknown): string {
  if (error instanceof Error && KIND_PREFIX.test(error.message)) {
    return error.message;
  }
  const { kind, message } = classifyError(error);
  return `[${kind}] ${message}`;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The command-line program. Results are JSON on stdout; progress and errors
 * go to stderr, and a failure exits with code 1.
 */
export function createProgram(client: IndexNowClient): Command {
  const program = new Command()
    .name("index-now")
    .description(
      "Submit changed URLs to IndexNow (Bing, Yandex, Seznam, Naver and others; not Google).",
    )
    .version(pkg.version);

  program
    .command("submit")
    .description(
      "Submit URLs on one host that were added, updated or deleted. Waits for the site to serve the key file " +
        "and retries when IndexNow is unavailable; a rate limit fails at once.",
    )
    .argument("<urls...>", "production URLs, all on one host (up to 10,000)")
    .requiredOption(
      "--key <key>",
      "the IndexNow key: the name of the site's <key>.txt file without .txt",
    )
    .option(
      "--key-location <url>",
      "full URL of the key file when it is not at the site root",
    )
    .action(async (urls: string[], options: KeyOptions, command: Command) => {
      const input = parseInput(submitSchema, { urls, ...options }, command);
      const urlList = [...new Set(input.urls)];
      const host = new URL(urlList[0] as string).hostname;
      let output: Awaited<ReturnType<typeof runSubmission>>;
      try {
        output = await runSubmission(
          {
            host,
            key: input.key,
            ...(input.keyLocation && { keyLocation: input.keyLocation }),
            urlList,
          },
          {
            ...client,
            async sleep(seconds, reason) {
              console.error(`Retrying in ${seconds}s: ${reason}`);
              await sleep(seconds * 1000);
            },
          },
        );
      } catch (error) {
        return command.error(failureMessage(error));
      }
      console.log(
        JSON.stringify(
          {
            ...output,
            // 202: received, with IndexNow's own key check still pending.
            note:
              output.status === 202
                ? "Accepted; IndexNow will validate the key before processing."
                : "Accepted.",
          },
          null,
          2,
        ),
      );
    });

  program
    .command("verify")
    .description(
      "Check that the live site serves the key file with the key as its contents. Submits nothing; " +
        "exits with code 1 when the key file is not valid.",
    )
    .argument("<url>", "the site, or any page on it")
    .requiredOption(
      "--key <key>",
      "the IndexNow key: the name of the site's <key>.txt file without .txt",
    )
    .option(
      "--key-location <url>",
      "full URL of the key file when it is not at the site root",
    )
    .action(async (url: string, options: KeyOptions, command: Command) => {
      const input = parseInput(verifySchema, { url, ...options }, command);
      const location = keyFileUrl(input.url, input.key, input.keyLocation);
      let reason: Awaited<ReturnType<typeof checkKeyFile>>;
      try {
        reason = await checkKeyFile(client, location, input.key);
      } catch (error) {
        return command.error(failureMessage(error));
      }
      console.log(
        JSON.stringify(
          reason
            ? { valid: false, keyLocation: location, reason }
            : { valid: true, keyLocation: location },
          null,
          2,
        ),
      );
      if (reason) process.exitCode = 1;
    });

  return program;
}
