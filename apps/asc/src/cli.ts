import { readFile } from "node:fs/promises";
import { Command, Option } from "commander";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { AscClient } from "./asc/client.ts";
import type { CredentialOptions } from "./asc/credentials.ts";
import { appsInput, listApps } from "./commands/apps.ts";
import {
  buildsInput,
  complianceInput,
  listBuilds,
  setBuildCompliance,
  type WaitDependencies,
  waitForBuild,
  waitInput,
} from "./commands/builds.ts";
import {
  deleteReplyInput,
  deleteReviewReply,
  replyInput,
  replyToReview,
} from "./commands/review-replies.ts";
import { listReviews, reviewsInput } from "./commands/reviews.ts";
import { getStatus, statusInput } from "./commands/status.ts";
import {
  addBuildInput,
  addBuildToGroup,
  addTesters,
  addTestersInput,
  betaFeedbackInput,
  betaGroupsInput,
  betaTestersInput,
  FEEDBACK_TYPES,
  listBetaFeedback,
  listBetaGroups,
  listBetaTesters,
  notesInput,
  removeTesters,
  removeTestersInput,
  setBuildNotes,
} from "./commands/testflight.ts";
import { listVersions, versionsInput } from "./commands/versions.ts";
import { PLATFORMS } from "./schemas/common.ts";
import { classifyError } from "./utils/errors.ts";

/** Resolves the client inside each command, so a missing key ends that command with an `[auth]` error. */
export type AscClientProvider = (
  credentials: CredentialOptions,
) => AscClient | Promise<AscClient>;

const LIMIT = ["--limit <number>", "maximum number of results, 1 to 200", "50"];
const CURSOR = [
  "--cursor <cursor>",
  "read the next page: the nextCursor value from the previous result",
] as const;
const YES = [
  "--yes",
  "do it; without --yes the command only prints what it would change",
] as const;

/** Where a command writes progress and notes: stderr, or what tests capture. */
function stderr(command: Command): (text: string) => void {
  return (
    command.configureOutput().writeErr ??
    ((text: string) => process.stderr.write(text))
  );
}

/** The text from --body or the file named by --body-file; `what` names it in errors. */
async function readBody(
  command: Command,
  options: { body?: string; bodyFile?: string },
  what: string,
): Promise<string> {
  if (options.body !== undefined && options.bodyFile !== undefined) {
    return command.error(
      "[invalid_input] Give --body or --body-file, not both.",
    );
  }
  if (options.body !== undefined) return options.body;
  if (options.bodyFile === undefined) {
    return command.error(
      `[invalid_input] Give the ${what} with --body or --body-file.`,
    );
  }
  try {
    return await readFile(options.bodyFile, "utf8");
  } catch {
    return command.error(
      `[invalid_input] Could not read the --body-file ${options.bodyFile}.`,
    );
  }
}

/** Collects a repeatable, comma-separated option such as --email a,b --email c. */
function collectList(value: string, previous: string[] = []): string[] {
  return [
    ...previous,
    ...value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  ];
}

/** Clock and sleep for `builds wait`; tests pass fakes. */
export type ProgramOptions = Partial<Pick<WaitDependencies, "sleep" | "now">>;

/**
 * The command-line program: App Store Connect queries, and write commands
 * that change nothing without --yes. Results are
 * JSON on stdout; errors go to stderr and exit with code 1.
 */
export function createProgram(
  getClient: AscClientProvider,
  {
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: ProgramOptions = {},
): Command {
  const program = new Command()
    .name("asc")
    .description(
      "App Store Connect with your own API key: apps, versions, builds, release status, TestFlight groups, testers, feedback and notes, and customer reviews. Commands that change anything only print what they would do unless given --yes.",
    )
    .version(pkg.version)
    .option("--key-id <id>", "API key ID (default: ASC_KEY_ID)")
    .option(
      "--issuer-id <id>",
      "issuer ID, for a team key only (default: ASC_ISSUER_ID)",
    )
    .option(
      "--private-key <path>",
      "path to the key's .p8 file (default: ASC_PRIVATE_KEY_PATH)",
    );

  /**
   * Runs a write command: without --yes its result is a dry run (`dryRun: true`)
   * that changes nothing, and a note on stderr says so.
   */
  async function runWrite<Schema extends z.ZodType>(
    command: Command,
    schema: Schema,
    input: unknown,
    execute: (
      client: AscClient,
      input: z.output<Schema>,
    ) => Promise<{ dryRun: boolean }>,
  ): Promise<void> {
    const result = await run(command, schema, input, execute);
    if (result.dryRun) {
      stderr(command)(
        "Dry run: nothing was changed. Run the same command with --yes to do it.\n",
      );
    }
  }

  /** Validates the input, runs the query, prints its result and returns it. */
  async function run<Schema extends z.ZodType, Result>(
    command: Command,
    schema: Schema,
    input: unknown,
    execute: (client: AscClient, input: z.output<Schema>) => Promise<Result>,
  ): Promise<Result> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return command.error(`[invalid_input] ${z.prettifyError(parsed.error)}`);
    }
    let result: Result;
    try {
      const client = await getClient(program.opts<CredentialOptions>());
      result = await execute(client, parsed.data);
    } catch (error) {
      // Classified messages never carry the token or the private key.
      const { kind, message } = classifyError(error);
      return command.error(`[${kind}] ${message}`);
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  program
    .command("apps")
    .description(
      "Apps the key can see: id, name, bundle ID, SKU and primary locale. Use the id as <app-id> in the other commands.",
    )
    .option("--name <name>", "only apps with this name")
    .option("--bundle-id <id>", "only the app with this bundle ID")
    .option(
      "--sort <field>",
      "name, bundleId or sku; write --sort=-name to sort descending",
      "name",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, appsInput, options, listApps);
    });

  program
    .command("versions")
    .description(
      "App Store versions of an app, newest first: version string, platform, state, release type and date, and the attached build number.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .addOption(
      new Option("--platform <platform>", "only this platform").choices([
        "IOS",
        "MAC_OS",
        "TV_OS",
        "VISION_OS",
      ]),
    )
    .option(
      "--state <states>",
      "only these states, comma-separated, such as IN_REVIEW,REJECTED",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, versionsInput, { appId, ...options }, listVersions);
    });

  const builds = program
    .command("builds")
    .description(
      "An app's builds, newest upload first: build number, marketing version and platform, processing state, upload and expiry dates, and the export compliance answer (usesNonExemptEncryption, null while unanswered).",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--processing-state <states>",
      "only these states, comma-separated: PROCESSING, FAILED, INVALID, VALID",
    )
    .option("--expired", "only expired builds")
    .option("--no-expired", "only unexpired builds")
    .option(
      "--build-number <number>",
      "only builds with this build number (CFBundleVersion)",
    )
    .option(
      "--group <group-id>",
      "only builds this TestFlight group can test (id from testflight groups)",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, buildsInput, { appId, ...options }, listBuilds);
    });

  builds
    .command("wait")
    .description(
      "Wait until a build finishes processing, then print it. Exits 0 when the build is VALID and 1 when it is FAILED or INVALID; progress goes to stderr.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--build-number <number>",
      "the build number (CFBundleVersion) to wait for (required)",
    )
    .option("--timeout <minutes>", "give up after this long, 1 to 180", "30")
    .option(
      "--interval <seconds>",
      "time between checks, 10 to 300; a rate limit backs off further",
      "30",
    )
    .action(async (appId: string, options, command: Command) => {
      const writeErr = stderr(command);
      const build = await run(
        command,
        waitInput,
        // `builds` also defines --build-number, so Commander hands it to the parent.
        { appId, buildNumber: command.parent?.opts().buildNumber, ...options },
        (client, input) =>
          waitForBuild(client, input, {
            sleep,
            now,
            progress: (line) => writeErr(`${line}\n`),
          }),
      );
      if (build.processingState !== "VALID") {
        command.error(
          `Build ${build.version} finished processing as ${build.processingState}.`,
        );
      }
    });

  builds
    .command("compliance")
    .description(
      "Answer a build's export compliance question so it can be tested and submitted. Without --yes, prints the build and its current answer. Setting ITSAppUsesNonExemptEncryption in Info.plist answers it for future builds. Needs a key with the App Manager role.",
    )
    .argument("<build-id>", "build id from the builds command")
    .option(
      "--no-encryption",
      "the build uses no encryption, or only exempt encryption (such as HTTPS)",
    )
    .option(
      "--encryption",
      "the build uses non-exempt encryption; it also needs an encryption declaration in App Store Connect",
    )
    .option(...YES)
    .action(async (buildId: string, options, command: Command) => {
      await runWrite(
        command,
        complianceInput,
        {
          buildId,
          usesNonExemptEncryption: options.encryption,
          yes: options.yes,
        },
        setBuildCompliance,
      );
    });

  const testflight = program
    .command("testflight")
    .description(
      "TestFlight: an app's beta groups, testers and the feedback they sent, plus a build's What to Test notes. Commands that change anything need a key with the App Manager role.",
    );

  const groups = testflight
    .command("groups")
    .description(
      "An app's TestFlight groups by name: internal or external, whether it gets every build, feedback and public link settings. List a group's builds with builds --group and its testers with testflight testers --group.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--internal", "only internal groups")
    .option("--no-internal", "only external groups")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(
        command,
        betaGroupsInput,
        { appId, ...options },
        listBetaGroups,
      );
    });

  groups
    .command("add-build")
    .description(
      "Let a group test a build. An external group can only get a build that passed beta review. Without --yes, prints the group, the build and whether the group already has it.",
    )
    .argument("<group-id>", "group id from testflight groups")
    .argument("<build-id>", "build id from the builds command")
    .option(...YES)
    .action(
      async (group: string, buildId: string, options, command: Command) => {
        await runWrite(
          command,
          addBuildInput,
          { group, buildId, yes: options.yes },
          addBuildToGroup,
        );
      },
    );

  const testers = testflight
    .command("testers")
    .description(
      "An app's TestFlight testers by last name: name, email, how they were invited (EMAIL or PUBLIC_LINK) and their state, such as INVITED, ACCEPTED or INSTALLED.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--group <group-id>",
      "only testers in this group (id from testflight groups)",
    )
    .addOption(
      new Option(
        "--invite-type <type>",
        "only testers invited this way",
      ).choices(["EMAIL", "PUBLIC_LINK"]),
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(
        command,
        betaTestersInput,
        { appId, ...options },
        listBetaTesters,
      );
    });

  testers
    .command("add")
    .description(
      "Add testers to a group by email. Someone already testing the app joins the group; anyone else gets an invitation email. Internal groups only take App Store Connect users. Without --yes, prints what would happen to each email.",
    )
    .argument("<group-id>", "group id from testflight groups")
    .option(
      "--email <emails>",
      "tester emails, comma-separated or repeated (up to 50)",
      collectList,
    )
    .option(...YES)
    .action(async (group: string, options, command: Command) => {
      await runWrite(
        command,
        addTestersInput,
        { group, emails: options.email ?? [], yes: options.yes },
        addTesters,
      );
    });

  testers
    .command("remove")
    .description(
      "Remove testers from a group by email; they can no longer test the group's builds. Without --yes, prints which of the emails are in the group.",
    )
    .argument("<group-id>", "group id from testflight groups")
    .option(
      "--email <emails>",
      "tester emails, comma-separated or repeated (up to 50)",
      collectList,
    )
    .option(...YES)
    .action(async (group: string, options, command: Command) => {
      await runWrite(
        command,
        removeTestersInput,
        { group, emails: options.email ?? [], yes: options.yes },
        removeTesters,
      );
    });

  testflight
    .command("feedback")
    .description(
      "Feedback TestFlight testers sent, newest first: their comment, the build, and the device, OS and platform. Tester emails are left out.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .addOption(
      new Option(
        "--type <type>",
        "crash reports or screenshot feedback (required)",
      ).choices([...FEEDBACK_TYPES]),
    )
    .option(
      "--build <build-id>",
      "only feedback from this build (id from builds)",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(
        command,
        betaFeedbackInput,
        { appId, ...options },
        listBetaFeedback,
      );
    });

  testflight
    .command("notes")
    .description(
      "Set a build's What to Test notes for one language, which testers see in TestFlight. Without --yes, prints the current notes and the new ones.",
    )
    .argument("<build-id>", "build id from the builds command")
    .option(
      "--locale <locale>",
      "the notes' language, such as en-US (required)",
    )
    .option("--body <text>", "the notes, up to 4000 characters")
    .option("--body-file <path>", "read the notes from this file")
    .option(...YES)
    .action(async (buildId: string, options, command: Command) => {
      const whatsNew = await readBody(command, options, "notes");
      await runWrite(
        command,
        notesInput,
        { buildId, locale: options.locale, whatsNew, yes: options.yes },
        setBuildNotes,
      );
    });

  const reviews = program
    .command("reviews")
    .description(
      "Customer reviews of an app: rating, title, body, reviewer nickname, date, territory and your developer response if any.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--rating <stars>",
      "only these star ratings, comma-separated, such as 1,2",
    )
    .option(
      "--territory <code>",
      "only this App Store territory (alpha-3, such as USA, GBR, SGP)",
    )
    .option(
      "--has-response",
      "only reviews with a published developer response",
    )
    .option("--no-has-response", "only reviews without one")
    .option(
      "--sort <field>",
      "createdDate or rating; write --sort=-rating to sort descending",
      "-createdDate",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, reviewsInput, { appId, ...options }, listReviews);
    });

  reviews
    .command("reply")
    .description(
      "Post a public developer response to a review, replacing your existing one. Without --yes, prints the review and the reply it would post. Needs a key with the App Manager or Customer Support role.",
    )
    .argument("<review-id>", "review id from the reviews command")
    .option("--body <text>", "the reply text")
    .option("--body-file <path>", "read the reply text from this file")
    .option(...YES)
    .action(async (reviewId: string, options, command: Command) => {
      const body = await readBody(command, options, "reply text");
      await runWrite(
        command,
        replyInput,
        { reviewId, body, yes: options.yes },
        replyToReview,
      );
    });

  reviews
    .command("delete-reply")
    .description(
      "Delete your developer response to a review. Without --yes, prints the review and the response it would delete.",
    )
    .argument("<review-id>", "review id from the reviews command")
    .option(...YES)
    .action(async (reviewId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteReplyInput,
        { reviewId, yes: options.yes },
        deleteReviewReply,
      );
    });

  program
    .command("status")
    .description(
      "Where an app stands on each platform: the live version, a newer version being prepared or in review (with its build and any phased release), and the newest build with its processing state.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .addOption(
      new Option("--platform <platform>", "only this platform").choices([
        ...PLATFORMS,
      ]),
    )
    .action(async (appId: string, options, command: Command) => {
      await run(command, statusInput, { appId, ...options }, getStatus);
    });

  return program;
}
