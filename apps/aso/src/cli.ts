import { Command } from "commander";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { AppStoreClient } from "./appstore/client.ts";
import { competitorsSchema, diffCompetitors } from "./commands/competitors.ts";
import { lintKeywords, lintSchema } from "./commands/lint.ts";
import { checkRanks, ranksSchema } from "./commands/ranks.ts";
import { classifyError } from "./utils/errors.ts";

export interface ProgramOptions {
  /** Milliseconds since the epoch, for timestamps. */
  now?: () => number;
}

/** Validates the arguments, ending the command with `[invalid_input]` when they fail. */
function parseInput<T>(schema: z.ZodType<T>, input: unknown, command: Command) {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  return command.error(`[invalid_input] ${z.prettifyError(parsed.error)}`);
}

function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

/**
 * The command-line program. Results are JSON on stdout; retries and errors go
 * to stderr, and a failure exits with code 1.
 */
export function createProgram(
  client: AppStoreClient,
  { now = Date.now }: ProgramOptions = {},
): Command {
  async function run(command: Command, task: () => Promise<unknown>) {
    let result: unknown;
    try {
      result = await task();
    } catch (error) {
      const { kind, message } = classifyError(error);
      return command.error(`[${kind}] ${message}`);
    }
    print(result);
  }

  const program = new Command()
    .name("aso")
    .description(
      "App Store keyword checks, rank tracking and competitor listing changes, run from your own machine.",
    )
    .version(pkg.version);

  program
    .command("keywords")
    .description("Work with an app's keyword field.")
    .command("lint")
    .description(
      "Check a keyword field, and optionally the name and subtitle, against App Store Connect's limits " +
        "and Apple's keyword guidance. Makes no requests; exits with code 1 when a limit is broken.",
    )
    .requiredOption(
      "--keywords <text>",
      'the keyword field, comma-separated (quote it: "habit,tracker,routine")',
    )
    .option("--name <text>", "the app name, to find words repeated from it")
    .option("--subtitle <text>", "the subtitle, to find words repeated from it")
    .option(
      "--developer <text>",
      "the developer or company name, which Apple also indexes",
    )
    .action((options: Record<string, string>, command: Command) => {
      const input = parseInput(lintSchema, options, command);
      const result = lintKeywords(input);
      print(result);
      if (!result.valid) process.exitCode = 1;
    });

  program
    .command("ranks")
    .description("Track where an app ranks in App Store search.")
    .command("check")
    .description(
      "Search each term in one storefront and report the app's position in the top 200. " +
        "With --history, compare with the last run and append this one. Positions come from the public " +
        "iTunes Search API and can differ from a signed-in device.",
    )
    .argument("<terms...>", "search phrases, up to 50 (quote multi-word ones)")
    .requiredOption("--app-id <id>", "the app's numeric App Store ID")
    .option("--country <code>", "two-letter storefront code", "us")
    .option(
      "--history <file>",
      "a JSON Lines file of earlier runs; created when missing",
    )
    .action(
      async (
        terms: string[],
        options: { appId: string; country: string; history?: string },
        command: Command,
      ) => {
        const input = parseInput(ranksSchema, { terms, ...options }, command);
        await run(command, () => checkRanks(client, input, now));
      },
    );

  program
    .command("competitors")
    .description("Watch other apps' public listings.")
    .command("diff")
    .description(
      "Look up apps' public listings in one storefront, report what changed since the snapshot file " +
        "was last written, then update it. The first run only records. Subtitles and keyword fields are not public.",
    )
    .argument("<app-ids...>", "numeric App Store IDs, up to 200")
    .requiredOption(
      "--snapshot <file>",
      "where the previous listings are kept; created when missing, one file per country",
    )
    .option("--country <code>", "two-letter storefront code", "us")
    .action(
      async (
        appIds: string[],
        options: { snapshot: string; country: string },
        command: Command,
      ) => {
        const input = parseInput(
          competitorsSchema,
          { appIds, ...options },
          command,
        );
        await run(command, () => diffCompetitors(client, input, now));
      },
    );

  return program;
}
