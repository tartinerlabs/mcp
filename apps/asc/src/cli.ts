import { readFile } from "node:fs/promises";
import { Argument, Command, Option } from "commander";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { AscClient } from "./asc/client.ts";
import type { CredentialOptions } from "./asc/credentials.ts";
import {
  ageRatingInput,
  getAgeRating,
  setAgeRating,
  setAgeRatingInput,
} from "./commands/age-rating.ts";
import {
  createKey,
  createKeyInput,
  createWebhook,
  createWebhookInput,
  deleteKey,
  deleteKeyInput,
  deleteMarketplace,
  deleteMarketplaceInput,
  deleteWebhook,
  deleteWebhookInput,
  downloadInput,
  downloadPackage,
  exportKey,
  exportKeyInput,
  getMarketplace,
  getPackage,
  keysInput,
  listKeys,
  listPackageVersions,
  listWebhooks,
  marketplaceInput,
  packageInput,
  packageVersionsInput,
  requestPackage,
  requestPackageInput,
  setMarketplace,
  setMarketplaceInput,
  setWebhook,
  setWebhookInput,
  webhooksInput,
} from "./commands/alt-distribution.ts";
import {
  analyticsInput,
  analyticsInstancesInput,
  analyticsReportsInput,
  analyticsSummaryInput,
  CATEGORIES,
  GRANULARITIES,
  getAnalyticsSummary,
  listAnalyticsInstances,
  listAnalyticsReports,
  listAnalyticsRequests,
  requestAnalytics,
  requestAnalyticsInput,
} from "./commands/analytics.ts";
import {
  appInfoInput,
  getAppInfo,
  setAppInfo,
  setAppInfoInput,
} from "./commands/app-info.ts";
import { appsInput, listApps } from "./commands/apps.ts";
import {
  availabilityInput,
  getAvailability,
  setAvailability,
  setAvailabilityInput,
} from "./commands/availability.ts";
import { buildUploadInput, uploadBuild } from "./commands/build-upload.ts";
import {
  buildsInput,
  complianceInput,
  expireBuild,
  expireInput,
  listBuilds,
  setBuildCompliance,
  type WaitDependencies,
  waitForBuild,
  waitInput,
} from "./commands/builds.ts";
import {
  createCustomPage,
  createCustomPageInput,
  customPageInput,
  customPagesInput,
  getCustomPage,
  listCustomPages,
  setCustomPage,
  setCustomPageInput,
  submitCustomPage,
  submitCustomPageInput,
  uploadCustomPageInput,
  uploadCustomPageScreenshots,
} from "./commands/custom-pages.ts";
import {
  BADGES,
  createEvent,
  createEventInput,
  eventInput,
  eventsInput,
  getEvent,
  listEvents,
  PRIORITIES,
  PURCHASE_REQUIREMENTS,
  PURPOSES,
  setEvent,
  setEventInput,
  submitEvent,
  submitEventInput,
  uploadEventInput,
  uploadEventMedia,
} from "./commands/events.ts";
import {
  getIap,
  getSubscription,
  IAP_TYPES,
  iapInput,
  iapListInput,
  listIaps,
  listSubscriptions,
  PRODUCT_STATES,
  subscriptionInput,
  subscriptionsInput,
} from "./commands/iap.ts";
import {
  getMetadata,
  metadataInput,
  setMetadata,
  setMetadataInput,
} from "./commands/metadata.ts";
import {
  DIAGNOSTIC_TYPES,
  diagnosticLogsInput,
  diagnosticsInput,
  getDiagnosticLogs,
  getMetrics,
  listDiagnostics,
  metricsInput,
} from "./commands/metrics.ts";
import {
  createPageTest,
  createPageTestInput,
  getPageTest,
  listPageTests,
  pageTestInput,
  pageTestsInput,
  pageTestWriteInput,
  startPageTest,
  stopPageTest,
  submitPageTest,
  uploadPageTestInput,
  uploadPageTestScreenshots,
} from "./commands/page-tests.ts";
import { getPricing, pricingInput } from "./commands/pricing.ts";
import {
  bundleIdsInput,
  CERTIFICATE_TYPES,
  certificatesInput,
  createCertificate,
  createCertificateInput,
  createProfile,
  createProfileInput,
  deleteProfile,
  deleteProfileInput,
  devicesInput,
  listBundleIds,
  listCertificates,
  listDevices,
  listProfiles,
  PROFILE_TYPES,
  profilesInput,
  renewCertificate,
  renewCertificateInput,
  renewProfile,
  renewProfileInput,
  revokeCertificate,
  revokeCertificateInput,
} from "./commands/provisioning.ts";
import {
  attachBuild,
  attachBuildInput,
  cancelReview,
  cancelReviewInput,
  PHASED_RELEASE_ACTIONS,
  phasedReleaseInput,
  releaseVersion,
  releaseVersionInput,
  setPhasedRelease,
  submitVersion,
  submitVersionInput,
} from "./commands/release.ts";
import {
  deleteReplyInput,
  deleteReviewReply,
  replyInput,
  replyToReview,
} from "./commands/review-replies.ts";
import { listReviews, reviewsInput } from "./commands/reviews.ts";
import {
  financeInput,
  getFinance,
  getSales,
  salesInput,
} from "./commands/sales.ts";
import {
  deleteInput,
  deleteScreenshots,
  getScreenshots,
  reorderInput,
  reorderScreenshots,
  screenshotsInput,
  uploadInput,
  uploadScreenshots,
} from "./commands/screenshots.ts";
import { getStatus, statusInput } from "./commands/status.ts";
import {
  addBuildInput,
  addBuildToGroup,
  addTesters,
  addTestersInput,
  betaFeedbackInput,
  betaGroupsInput,
  betaReviewInput,
  betaTestersInput,
  FEEDBACK_TYPES,
  getBetaReview,
  listBetaFeedback,
  listBetaGroups,
  listBetaTesters,
  notesInput,
  removeTesters,
  removeTestersInput,
  setBuildNotes,
  submitBetaReview,
  submitBetaReviewInput,
} from "./commands/testflight.ts";
import { listVersions, versionsInput } from "./commands/versions.ts";
import {
  artifactsInput,
  getRun,
  listArtifacts,
  listProducts,
  listRuns,
  listWorkflows,
  productsInput,
  runInput,
  runsInput,
  workflowsInput,
} from "./commands/xcode-cloud.ts";
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
      "App Store Connect with your own API key: apps, versions and their metadata, screenshots and app previews, custom product pages, product page optimization tests, in-app events, in-app purchases and subscriptions, app info, pricing, availability and age rating, builds, release status, TestFlight groups, testers, feedback and notes, and customer reviews. Commands that change anything only print what they would do unless given --yes.",
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

  const versions = program
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

  versions
    .command("attach-build")
    .description(
      "Attach a build to a version being prepared or rejected. Refuses a build of another app or platform, or one that is expired or not VALID. Without --yes, prints the version, its current build and the new one. Needs a key with the Admin or App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .argument("<build-id>", "build id from the builds command")
    .option(...YES)
    .action(
      async (versionId: string, buildId: string, options, command: Command) => {
        await runWrite(
          command,
          attachBuildInput,
          { versionId, buildId, yes: options.yes },
          attachBuild,
        );
      },
    );

  versions
    .command("submit")
    .description(
      "Submit a version for App Review on its own. Refuses a version that is not being prepared or rejected, has no VALID build or an unanswered export compliance question, is already submitted, or has unanswered age rating or accessibility questions, and when the app has a review submission being prepared with other items. Without --yes, prints the app, version, build and the submission it would use. Needs a key with the Admin or App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        submitVersionInput,
        { versionId, yes: options.yes },
        submitVersion,
      );
    });

  versions
    .command("cancel-review")
    .description(
      "Cancel the review submission of a version waiting for or in review, returning the version to an editable state; it loses its place in the review queue. Refuses when the submission holds other items. Without --yes, prints the app, version and submission. Needs a key with the Admin or App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        cancelReviewInput,
        { versionId, yes: options.yes },
        cancelReview,
      );
    });

  versions
    .command("release")
    .description(
      "Release a version that App Review approved and that is PENDING_DEVELOPER_RELEASE; with a phased release, it starts the rollout. Without --yes, prints the app and version. Needs a key with the Admin or App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        releaseVersionInput,
        { versionId, yes: options.yes },
        releaseVersion,
      );
    });

  versions
    .command("phased-release")
    .description(
      "Pause, resume or complete a version's phased release; complete releases it to every user at once. Without --yes, prints the app, version and phased release. Needs a key with the Admin or App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .addArgument(
      new Argument("<action>", "what to do").choices(PHASED_RELEASE_ACTIONS),
    )
    .option(...YES)
    .action(
      async (versionId: string, action: string, options, command: Command) => {
        await runWrite(
          command,
          phasedReleaseInput,
          { versionId, action, yes: options.yes },
          setPhasedRelease,
        );
      },
    );

  const metadata = program
    .command("metadata")
    .description(
      "A version's App Store metadata in every locale: description, keywords, promotional text, What's New, support and marketing URLs.",
    )
    .argument("<version-id>", "version id from the versions command")
    .action(async (versionId: string, _options, command: Command) => {
      await run(command, metadataInput, { versionId }, getMetadata);
    });

  metadata
    .command("set")
    .description(
      "Change a version's metadata for one locale. Only a version being prepared or rejected accepts changes, except --promotional-text, which can change at any time. Without --yes, prints the current and new values. Needs a key with the App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option(
      "--locale <locale>",
      "the locale to change, such as en-US (required)",
    )
    .option("--description <text>", "the App Store description")
    .option("--keywords <text>", "comma-separated search keywords")
    .option("--promotional-text <text>", "the promotional text")
    .option("--whats-new <text>", "What's New in this version")
    .option("--support-url <url>", "the support URL")
    .option("--marketing-url <url>", "the marketing URL")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        setMetadataInput,
        { versionId, ...options },
        setMetadata,
      );
    });

  const appInfo = program
    .command("app-info")
    .description(
      "An app's app infos, usually the live one and one being prepared: state, age rating, category IDs, and each locale's name, subtitle and privacy policy links.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, appInfoInput, { appId }, getAppInfo);
    });

  appInfo
    .command("set")
    .description(
      "Change an app info for one locale. Only an app info being prepared or rejected accepts changes. Without --yes, prints the current and new values. Needs a key with the App Manager role.",
    )
    .argument("<app-info-id>", "app info id from the app-info command")
    .option(
      "--locale <locale>",
      "the locale to change, such as en-US (required)",
    )
    .option("--name <text>", "the app's name on the App Store")
    .option("--subtitle <text>", "the subtitle")
    .option("--privacy-policy-url <url>", "the privacy policy URL")
    .option("--privacy-choices-url <url>", "the privacy choices URL")
    .option("--privacy-policy-text <text>", "the privacy policy text (tvOS)")
    .option(...YES)
    .action(async (appInfoId: string, options, command: Command) => {
      await runWrite(
        command,
        setAppInfoInput,
        { appInfoId, ...options },
        setAppInfo,
      );
    });

  program
    .command("pricing")
    .description(
      "An app's price schedule: its base territory and currency, the prices set by hand (current and scheduled) and the prices Apple derives for every other territory, each with customer price, proceeds and start and end dates. Prices can only be changed in App Store Connect.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--territory <codes>",
      "only these territories, comma-separated alpha-3 codes such as USA,JPN",
    )
    .action(async (appId: string, options, command: Command) => {
      await run(command, pricingInput, { appId, ...options }, getPricing);
    });

  const availability = program
    .command("availability")
    .description(
      "Where an app is sold: whether it joins new territories automatically, the territories it is missing from, and each territory's availability, release date, pre-order and content statuses (such as one that blocks sale there).",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, availabilityInput, { appId }, getAvailability);
    });

  availability
    .command("set")
    .description(
      "Add an app to territories (--available) or remove it from them (--no-available). Without --yes, prints each territory's current availability. Needs a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--territory <codes>",
      "alpha-3 territory codes, comma-separated or repeated, such as USA,GBR (required)",
      collectList,
    )
    .option("--available", "make the app available in these territories")
    .option("--no-available", "remove the app from these territories")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setAvailabilityInput,
        {
          appId,
          territories: options.territory ?? [],
          available: options.available,
          yes: options.yes,
        },
        setAvailability,
      );
    });

  const iap = program
    .command("iap")
    .description(
      "An app's in-app purchases: reference name, product ID, type and review state. A product missing from the app is often one never submitted for review. Read only: change products in App Store Connect.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--type <types>",
      `only these types, comma-separated: ${IAP_TYPES.join(", ")}`,
    )
    .option(
      "--state <states>",
      `only these states, comma-separated, such as ${PRODUCT_STATES.slice(3, 6).join(",")}`,
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, iapListInput, { appId, ...options }, listIaps);
    });

  iap
    .command("show")
    .description(
      "One in-app purchase: its review state, localizations, availability, base territory, the prices in effect today in each territory, and its offer codes with their counts (never the codes).",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .action(async (iapId: string, _options, command: Command) => {
      await run(command, iapInput, { iapId }, getIap);
    });

  const subscriptions = program
    .command("subscriptions")
    .description(
      "An app's subscription groups, each with its subscriptions' reference name, product ID, period, level and review state. Read only: change subscriptions in App Store Connect.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, subscriptionsInput, { appId }, listSubscriptions);
    });

  subscriptions
    .command("show")
    .description(
      "One subscription: its review state, localizations, availability, the price in effect today and scheduled changes in each territory, introductory offers that have not ended, promotional offers, offer codes with their counts (never the codes) and win-back offers that have not ended.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .action(async (subscriptionId: string, _options, command: Command) => {
      await run(
        command,
        subscriptionInput,
        { subscriptionId },
        getSubscription,
      );
    });

  const ageRating = program
    .command("age-rating")
    .description(
      "Each app info's state, App Store age rating and age rating declaration, with every answer App Store Connect returns. Apple changes the questions over time, so this lists the current ones.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, ageRatingInput, { appId }, getAgeRating);
    });

  ageRating
    .command("set")
    .description(
      "Change answers in an app info's age rating declaration, such as --answer gambling=false --answer violenceRealistic=INFREQUENT. Names are those the age-rating command lists; Apple checks the values. Only an app info being prepared or rejected accepts changes. Without --yes, prints the current and new answers. Needs a key with the App Manager role.",
    )
    .argument("<app-info-id>", "app info id from the age-rating command")
    .option(
      "--answer <name=value>",
      "one answer, repeated for more",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(...YES)
    .action(async (appInfoId: string, options, command: Command) => {
      await runWrite(
        command,
        setAgeRatingInput,
        { appInfoId, answers: options.answer ?? [], yes: options.yes },
        setAgeRating,
      );
    });

  const screenshots = program
    .command("screenshots")
    .description(
      "A version's screenshots and app previews per locale and device group, in display order: placement id, file name and state.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option("--locale <locale>", "only this locale, such as en-US")
    .action(async (versionId: string, options, command: Command) => {
      await run(
        command,
        screenshotsInput,
        { versionId, ...options },
        getScreenshots,
      );
    });

  screenshots
    .command("upload")
    .description(
      "Upload a folder of screenshots (.png, .jpg) and app previews (.mp4, .m4v, .mov) to a version: one subfolder per locale, such as en-US. A file goes to the device group its name contains, such as IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE, or for a screenshot the one its pixel size fits; previews must name it. Files are added after those already there, in file name order. Only a version being prepared or rejected accepts them, and a device group holds at most Apple's limit (10 screenshots, 3 app previews). Without --yes, prints where each file would go. Needs a key with the App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option("--dir <folder>", "the folder of locale subfolders (required)")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        uploadInput,
        { versionId, ...options },
        uploadScreenshots,
      );
    });

  screenshots
    .command("reorder")
    .description(
      "Set the display order of one locale's screenshots, or app previews, in one device group: give all of them, in the new order. Without --yes, prints the current and new order.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option("--locale <locale>", "the locale, such as en-US (required)")
    .option(
      "--group <group>",
      "the device group from the screenshots command (required)",
    )
    .option(
      "--placement <ids>",
      "placement ids in the new order, comma-separated or repeated",
      collectList,
    )
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        reorderInput,
        {
          versionId,
          // `screenshots` also defines --locale, so Commander hands it to the parent.
          locale: command.parent?.opts().locale,
          ...options,
          placements: options.placement ?? [],
        },
        reorderScreenshots,
      );
    });

  screenshots
    .command("delete")
    .description(
      "Remove screenshots or app previews from a version being prepared or rejected, by placement id; the files stay in the app's asset library. Without --yes, prints each one with its version and locale.",
    )
    .argument(
      "<placement-id...>",
      "placement ids from the screenshots command (up to 50)",
    )
    .option(...YES)
    .action(async (placements: string[], options, command: Command) => {
      await runWrite(
        command,
        deleteInput,
        { placements, yes: options.yes },
        deleteScreenshots,
      );
    });

  const customPages = program
    .command("custom-pages")
    .description(
      "An app's custom product pages: id, name, App Store URL and whether it is visible. Commands that change anything need a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--visible", "only visible pages")
    .option("--no-visible", "only hidden pages")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(
        command,
        customPagesInput,
        { appId, ...options },
        listCustomPages,
      );
    });

  customPages
    .command("show")
    .description(
      "One custom product page with each of its versions: version id, state, deep link, and each locale's promotional text.",
    )
    .argument("<page-id>", "page id from the custom-pages command")
    .action(async (pageId: string, _options, command: Command) => {
      await run(command, customPageInput, { pageId }, getCustomPage);
    });

  customPages
    .command("create")
    .description(
      "Create a custom product page with its first version and one locale; add screenshots with custom-pages upload, then submit it. Apple limits how many pages an app has. Without --yes, prints the page and how many the app already has.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--name <name>", "the page's name in App Store Connect (required)")
    .option(
      "--locale <locale>",
      "the page's first locale, such as en-US (required)",
    )
    .option("--promotional-text <text>", "that locale's promotional text")
    .option("--deep-link <url>", "the URL the app opens from the page")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        createCustomPageInput,
        { appId, ...options },
        createCustomPage,
      );
    });

  customPages
    .command("set")
    .description(
      "Change a page version's deep link, or one locale's promotional text. Only a page version being prepared or rejected accepts changes. Without --yes, prints the current and new values.",
    )
    .argument("<page-version-id>", "version id from custom-pages show")
    .option(
      "--locale <locale>",
      "the locale of --promotional-text, such as en-US",
    )
    .option("--promotional-text <text>", "the promotional text")
    .option("--deep-link <url>", "the URL the app opens from the page")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        setCustomPageInput,
        { versionId, ...options },
        setCustomPage,
      );
    });

  customPages
    .command("upload")
    .description(
      "Upload a folder of screenshots and app previews to a page version, as screenshots upload does for a version: one subfolder per locale, each file placed by the device group in its name or its pixel size. Only a page version being prepared or rejected accepts them. Without --yes, prints where each file would go.",
    )
    .argument("<page-version-id>", "version id from custom-pages show")
    .option("--dir <folder>", "the folder of locale subfolders (required)")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        uploadCustomPageInput,
        { versionId, ...options },
        uploadCustomPageScreenshots,
      );
    });

  customPages
    .command("submit")
    .description(
      "Submit a page version for App Review on its own. Refuses when the app has a review submission being prepared with other items, which would go for review too. Without --yes, prints the version and the submission it would use.",
    )
    .argument("<page-version-id>", "version id from custom-pages show")
    .addOption(
      new Option("--platform <platform>", "the review submission's platform")
        .choices([...PLATFORMS])
        .default("IOS"),
    )
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        submitCustomPageInput,
        { versionId, ...options },
        submitCustomPage,
      );
    });

  const pageTests = program
    .command("page-tests")
    .description(
      "An app's product page optimization tests: id, name, platform, state, traffic proportion, start and end dates, and each treatment's name and alternate icon. Apple's API returns no conversion results; read those in App Store Connect. Commands that change anything need a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--state <states>",
      "only these states, comma-separated, such as APPROVED,COMPLETED",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, pageTestsInput, { appId, ...options }, listPageTests);
    });

  pageTests
    .command("show")
    .description(
      "One product page test with each treatment: treatment id, name, alternate icon, and its locales.",
    )
    .argument("<test-id>", "test id from the page-tests command")
    .action(async (testId: string, _options, command: Command) => {
      await run(command, pageTestInput, { testId }, getPageTest);
    });

  pageTests
    .command("create")
    .description(
      "Create a product page test with up to three treatments, each with a localization per --locale; add screenshots with page-tests upload, then submit it. An alternate icon must already ship in the app's binary. Without --yes, prints the test and how many of the app's tests have not ended.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--name <name>", "the test's name in App Store Connect (required)")
    .option(
      "--traffic-proportion <percent>",
      "the share of visitors in the test, 1 to 100 (required)",
    )
    .option(
      "--treatment <name[=icon]>",
      "a treatment's name, with the alternate icon it shows after = (repeat, up to 3)",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--locale <locales>",
      "locales each treatment gets, such as en-US, comma-separated or repeated (required)",
      collectList,
    )
    .addOption(
      new Option("--platform <platform>", "the test's platform")
        .choices([...PLATFORMS])
        .default("IOS"),
    )
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        createPageTestInput,
        {
          appId,
          ...options,
          treatments: options.treatment ?? [],
          locales: options.locale ?? [],
        },
        createPageTest,
      );
    });

  pageTests
    .command("upload")
    .description(
      "Upload a folder of screenshots and app previews to a treatment, as screenshots upload does for a version: one subfolder per locale, each file placed by the device group in its name or its pixel size. Only a test being prepared or rejected accepts them. Without --yes, prints where each file would go.",
    )
    .argument("<treatment-id>", "treatment id from page-tests show")
    .option("--dir <folder>", "the folder of locale subfolders (required)")
    .option(...YES)
    .action(async (treatmentId: string, options, command: Command) => {
      await runWrite(
        command,
        uploadPageTestInput,
        { treatmentId, ...options },
        uploadPageTestScreenshots,
      );
    });

  pageTests
    .command("submit")
    .description(
      "Submit a test for App Review on its own. Refuses when the app has a review submission being prepared with other items, which would go for review too. Without --yes, prints the test and the submission it would use.",
    )
    .argument("<test-id>", "test id from the page-tests command")
    .option(...YES)
    .action(async (testId: string, options, command: Command) => {
      await runWrite(
        command,
        pageTestWriteInput,
        { testId, yes: options.yes },
        submitPageTest,
      );
    });

  pageTests
    .command("start")
    .description(
      "Start a test that App Review approved, or one that needs no review. Without --yes, prints the test.",
    )
    .argument("<test-id>", "test id from the page-tests command")
    .option(...YES)
    .action(async (testId: string, options, command: Command) => {
      await runWrite(
        command,
        pageTestWriteInput,
        { testId, yes: options.yes },
        startPageTest,
      );
    });

  pageTests
    .command("stop")
    .description(
      "Stop a running test; it cannot start again. Without --yes, prints the test.",
    )
    .argument("<test-id>", "test id from the page-tests command")
    .option(...YES)
    .action(async (testId: string, options, command: Command) => {
      await runWrite(
        command,
        pageTestWriteInput,
        { testId, yes: options.yes },
        stopPageTest,
      );
    });

  const events = program
    .command("events")
    .description(
      "An app's in-app events: id, reference name, state, badge, priority, purpose, primary locale, deep link, and each schedule's territories and publish, start and end dates. Commands that change anything need a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--state <states>",
      "only these states, comma-separated, such as DRAFT,PUBLISHED",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (appId: string, options, command: Command) => {
      await run(command, eventsInput, { appId, ...options }, listEvents);
    });

  events
    .command("show")
    .description(
      "One in-app event with each locale's name, short and long description, and its event card and details page images and videos.",
    )
    .argument("<event-id>", "event id from the events command")
    .action(async (eventId: string, _options, command: Command) => {
      await run(command, eventInput, { eventId }, getEvent);
    });

  events
    .command("create")
    .description(
      "Create an in-app event in its primary locale, with one schedule and that locale's name and descriptions when given; add images with events upload, then submit it. Without --yes, prints the event and how many the app already has.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--reference-name <name>",
      "the event's name in App Store Connect (required)",
    )
    .option(
      "--locale <locale>",
      "the event's primary locale, such as en-US (required)",
    )
    .option("--name <text>", "the event's name in that locale")
    .option("--short-description <text>", "its short description")
    .option("--long-description <text>", "its long description")
    .addOption(
      new Option("--badge <badge>", "the event's badge").choices([...BADGES]),
    )
    .addOption(
      new Option("--purpose <purpose>", "who the event is for").choices([
        ...PURPOSES,
      ]),
    )
    .addOption(
      new Option("--priority <priority>", "the event's priority").choices([
        ...PRIORITIES,
      ]),
    )
    .addOption(
      new Option(
        "--purchase-requirement <requirement>",
        "whether taking part needs an in-app purchase",
      ).choices([...PURCHASE_REQUIREMENTS]),
    )
    .option("--deep-link <url>", "the URL the app opens from the event")
    .option(
      "--territories <codes>",
      "the schedule's territories, comma-separated, such as USA,GBR",
    )
    .option(
      "--publish-start <date-time>",
      "when the event card appears, such as 2026-12-01T09:00:00Z",
    )
    .option("--event-start <date-time>", "when the event starts")
    .option("--event-end <date-time>", "when the event ends")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        createEventInput,
        { appId, ...options },
        createEvent,
      );
    });

  events
    .command("set")
    .description(
      "Change one locale's event name, short or long description, adding the locale when the event has none. Only an event in draft or rejected accepts changes. Without --yes, prints the current and new values.",
    )
    .argument("<event-id>", "event id from the events command")
    .option("--locale <locale>", "the locale to change, such as en-US")
    .option("--name <text>", "the event's name")
    .option("--short-description <text>", "the short description")
    .option("--long-description <text>", "the long description")
    .option(...YES)
    .action(async (eventId: string, options, command: Command) => {
      await runWrite(command, setEventInput, { eventId, ...options }, setEvent);
    });

  events
    .command("upload")
    .description(
      "Upload a folder of event card and details page images and videos to an event, through the asset library as screenshots upload does: one subfolder per locale, each file naming EVENT_CARD_ASSET or EVENT_DETAILS_PAGE_ASSET, and its group when the type has more than one. Only an event in draft or rejected accepts them. Without --yes, prints where each file would go.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .argument("<event-id>", "event id from the events command")
    .option("--dir <folder>", "the folder of locale subfolders (required)")
    .option(...YES)
    .action(
      async (appId: string, eventId: string, options, command: Command) => {
        await runWrite(
          command,
          uploadEventInput,
          { appId, eventId, ...options },
          uploadEventMedia,
        );
      },
    );

  events
    .command("submit")
    .description(
      "Submit an event for App Review on its own. Refuses when the app has a review submission being prepared with other items, which would go for review too. Without --yes, prints the event, the submission it would use and how many of the app's events are past review, since Apple limits how many run at once.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .argument("<event-id>", "event id from the events command")
    .addOption(
      new Option("--platform <platform>", "the review submission's platform")
        .choices([...PLATFORMS])
        .default("IOS"),
    )
    .option(...YES)
    .action(
      async (appId: string, eventId: string, options, command: Command) => {
        await runWrite(
          command,
          submitEventInput,
          { appId, eventId, ...options },
          submitEvent,
        );
      },
    );

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
    .command("upload")
    .description(
      "Upload an .ipa or .pkg to App Store Connect through the API and print the build upload's id and state. Without --yes, checks the file and the app and prints what would be uploaded. With --wait, then waits for the build as builds wait does. Needs a key with the App Manager or Developer role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--file <path>", "the exported .ipa, or .pkg for a Mac app")
    .option(
      "--app-version <version>",
      "the build's CFBundleShortVersionString, such as 1.2.0",
    )
    .option(
      "--build-number <number>",
      "the build's CFBundleVersion, such as 42",
    )
    .option(
      "--platform <platform>",
      "IOS, MAC_OS, TV_OS or VISION_OS (default: MAC_OS for a .pkg, IOS for an .ipa)",
    )
    .option(
      "--wait",
      "after uploading, wait until the build finishes processing",
    )
    .option("--timeout <minutes>", "with --wait, give up after this long", "30")
    .option(
      "--interval <seconds>",
      "with --wait, time between checks, 10 to 300",
      "30",
    )
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      const writeErr = stderr(command);
      let failed: string | undefined;
      await runWrite(
        command,
        buildUploadInput,
        {
          appId,
          // `builds` also defines --build-number, so Commander hands it to the parent.
          buildNumber: command.parent?.opts().buildNumber,
          version: options.appVersion,
          ...options,
        },
        async (client, input) => {
          const result = await uploadBuild(client, input, {
            sleep,
            now,
            progress: (line) => writeErr(`${line}\n`),
          });
          const state = "build" in result ? result.build.processingState : "";
          if (state && state !== "VALID") failed = state;
          return result;
        },
      );
      if (failed) {
        command.error(`The build finished processing as ${failed}.`);
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

  builds
    .command("expire")
    .description(
      "Expire a build so testers can no longer install it from TestFlight. This cannot be undone. Without --yes, prints the build and whether it is already expired. Needs a key with the App Manager role.",
    )
    .argument("<build-id>", "build id from the builds command")
    .option(...YES)
    .action(async (buildId: string, options, command: Command) => {
      await runWrite(
        command,
        expireInput,
        { buildId, yes: options.yes },
        expireBuild,
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

  const betaReview = testflight
    .command("review")
    .description(
      "A build's beta app review: the submission's state (WAITING_FOR_REVIEW, IN_REVIEW, REJECTED or APPROVED, or null if never submitted) and the build's external and internal TestFlight states.",
    )
    .argument("<build-id>", "build id from the builds command")
    .action(async (buildId: string, _options, command: Command) => {
      await run(command, betaReviewInput, { buildId }, getBetaReview);
    });

  betaReview
    .command("submit")
    .description(
      "Submit a build for beta app review, which it needs before external groups can test it. The app's review details (contact and, if required, demo account) must be filled in first; missing ones are named in the error. Without --yes, prints the build and any existing submission.",
    )
    .argument("<build-id>", "build id from the builds command")
    .option(...YES)
    .action(async (buildId: string, options, command: Command) => {
      await runWrite(
        command,
        submitBetaReviewInput,
        { buildId, yes: options.yes },
        submitBetaReview,
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

  /** Sales and finance reports refuse individual keys, so say so before calling Apple. */
  function requireTeamKey(command: Command, what: string): boolean {
    const issuerId =
      program.opts<CredentialOptions>().issuerId ?? process.env.ASC_ISSUER_ID;
    if (issuerId) return true;
    command.error(
      `[permission] ${what} reports need a team API key, which has an issuer ID: pass --issuer-id or set ASC_ISSUER_ID. Individual keys cannot read them; an Admin creates a team key in App Store Connect → Users and Access → Integrations → Team Keys.`,
    );
    return false;
  }

  const VENDOR = new Option(
    "--vendor-number <number>",
    "your vendor number, from Payments and Financial Reports",
  ).env("ASC_VENDOR_NUMBER");

  program
    .command("sales")
    .description(
      "Sales and Trends summary for one day, week, month or year, aggregated: total units and proceeds, then by product type, country and product (apps and in-app purchases). Proceeds stay in each currency of proceeds. Needs a team key with the Admin, Finance or Sales and Reports role.",
    )
    .addOption(VENDOR)
    .addOption(
      new Option("--frequency <frequency>", "report period")
        .choices(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
        .default("DAILY"),
    )
    .option(
      "--date <date>",
      "YYYY-MM-DD for daily and weekly (the Sunday the week ends), YYYY-MM for monthly, YYYY for yearly; a daily report without it is the latest",
    )
    .action(async (options, command: Command) => {
      if (!requireTeamKey(command, "Sales")) return;
      await run(command, salesInput, options, getSales);
    });

  program
    .command("finance")
    .description(
      "Financial report for one Apple fiscal month, aggregated like sales: units and proceeds (extended partner share) by product type, country and product. Needs a team key with the Admin or Finance role.",
    )
    .addOption(VENDOR)
    .option("--month <month>", "the fiscal month, YYYY-MM (required)")
    .option(
      "--region <code>",
      "a report region such as US or EU; ZZ is all regions consolidated",
      "ZZ",
    )
    .option("--detail", "the finance detail report (region Z1) instead")
    .action(async (options, command: Command) => {
      if (!requireTeamKey(command, "Finance")) return;
      await run(command, financeInput, options, getFinance);
    });

  const analytics = program
    .command("analytics")
    .description(
      "App analytics through Apple's Analytics Reports API. Lists the app's report requests; create one with analytics request, then use analytics reports, analytics instances and analytics summary. Reading needs the Admin, Finance or Sales and Reports role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, analyticsInput, { appId }, listAnalyticsRequests);
    });

  analytics
    .command("request")
    .description(
      "Ask Apple to start generating analytics reports for an app (ongoing by default); an active request of the same kind is reused. The first reports arrive in 1 to 2 days. Needs a key with the Admin role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--one-time", "a one-time snapshot instead of ongoing reports")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        requestAnalyticsInput,
        { appId, ...options },
        requestAnalytics,
      );
    });

  analytics
    .command("reports")
    .description(
      "The reports Apple generates for an app, such as App Downloads Standard or App Sessions Standard: id, name and category. Use the id with analytics instances.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .addOption(
      new Option("--category <category>", "only this category").choices([
        ...CATEGORIES,
      ]),
    )
    .option("--name <name>", "only the report with this exact name")
    .action(async (appId: string, options, command: Command) => {
      await run(
        command,
        analyticsReportsInput,
        { appId, ...options },
        listAnalyticsReports,
      );
    });

  analytics
    .command("instances")
    .description(
      "A report's instances, one per granularity and processing date. Use the id with analytics summary.",
    )
    .argument("<report-id>", "report id from the analytics reports command")
    .addOption(
      new Option("--granularity <granularity>", "instance period")
        .choices([...GRANULARITIES])
        .default("DAILY"),
    )
    .option("--date <date>", "only this processing date, YYYY-MM-DD")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (reportId: string, options, command: Command) => {
      await run(
        command,
        analyticsInstancesInput,
        { reportId, ...options },
        listAnalyticsInstances,
      );
    });

  analytics
    .command("summary")
    .description(
      "Download one instance's files and sum its numeric columns, in total and by the --group-by columns. Prints the report's columns, so a first run without --group-by shows what to group by.",
    )
    .argument(
      "<instance-id>",
      "instance id from the analytics instances command",
    )
    .option(
      "--group-by <columns>",
      'comma-separated column names, such as "Territory,Source Type"',
    )
    .option("--top <number>", "at most this many groups, largest first", "50")
    .action(async (instanceId: string, options, command: Command) => {
      await run(
        command,
        analyticsSummaryInput,
        { instanceId, ...options },
        getAnalyticsSummary,
      );
    });

  const TEAM_KEY =
    "Needs a team key: individual keys cannot use certificates, profiles, bundle IDs or devices.";
  const KEY_OUT = [
    "--key-out <path>",
    "new file for the private key (PKCS#8 PEM, readable only by you); never overwritten (required)",
  ] as const;
  const CERT_OUT = [
    "--cert-out <path>",
    "new file for the certificate (DER .cer); never overwritten (required)",
  ] as const;
  const COMMON_NAME = [
    "--common-name <name>",
    "the CSR's common name; Apple names the certificate itself",
  ] as const;

  const certificates = program
    .command("certificates")
    .description(
      `Signing certificates: type, platform, serial number and expiry. ${TEAM_KEY}`,
    )
    .option(
      "--type <types>",
      "only these certificate types, comma-separated, such as DISTRIBUTION,IOS_DISTRIBUTION",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, certificatesInput, options, listCertificates);
    });

  certificates
    .command("create")
    .description(
      `Create a certificate from a new RSA 2048 private key, writing the key and the certificate to the files you name. The key is never printed. Without --yes, checks the files and lists the existing certificates of that type. ${TEAM_KEY}`,
    )
    .addOption(
      new Option("--type <type>", "certificate type (required)").choices([
        ...CERTIFICATE_TYPES,
      ]),
    )
    .option(...KEY_OUT)
    .option(...CERT_OUT)
    .option(...COMMON_NAME)
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `certificates` also has --type, so Commander gives it the value.
      await runWrite(
        command,
        createCertificateInput,
        command.optsWithGlobals(),
        createCertificate,
      );
    });

  certificates
    .command("renew")
    .description(
      `Create a replacement for an expiring certificate: a new certificate of the same type from a new private key. The old one keeps working until it expires or is revoked. Without --yes, prints the certificate it replaces. ${TEAM_KEY}`,
    )
    .argument(
      "<certificate-id>",
      "certificate id from the certificates command",
    )
    .option(...KEY_OUT)
    .option(...CERT_OUT)
    .option(...COMMON_NAME)
    .option(...YES)
    .action(async (certificateId: string, options, command: Command) => {
      await runWrite(
        command,
        renewCertificateInput,
        { certificateId, ...options },
        renewCertificate,
      );
    });

  certificates
    .command("revoke")
    .description(
      `Revoke a certificate. This cannot be undone and makes every profile that includes it invalid; without --yes, prints the certificate and those profiles. ${TEAM_KEY}`,
    )
    .argument(
      "<certificate-id>",
      "certificate id from the certificates command",
    )
    .option(...YES)
    .action(async (certificateId: string, options, command: Command) => {
      await runWrite(
        command,
        revokeCertificateInput,
        { certificateId, yes: options.yes },
        revokeCertificate,
      );
    });

  const profiles = program
    .command("profiles")
    .description(
      `Provisioning profiles: type, state, expiry, bundle ID, certificates and devices (up to 50 of each shown). Never prints the profile contents. ${TEAM_KEY}`,
    )
    .option(
      "--type <types>",
      "only these profile types, comma-separated, such as IOS_APP_STORE",
    )
    .option("--state <states>", "only ACTIVE or INVALID profiles")
    .option("--name <name>", "only the profile with this name")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, profilesInput, options, listProfiles);
    });

  profiles
    .command("create")
    .description(
      `Create a provisioning profile for a bundle ID and certificates (and, for development and ad hoc profiles, devices) and write it to --out. Without --yes, prints what it would create. ${TEAM_KEY}`,
    )
    .option(
      "--name <name>",
      "the profile's name, unique in the team (required)",
    )
    .addOption(
      new Option("--type <type>", "profile type (required)").choices([
        ...PROFILE_TYPES,
      ]),
    )
    .option(
      "--bundle-id <id>",
      "bundle ID resource id from the bundle-ids command (required)",
    )
    .option(
      "--certificate <ids>",
      "certificate ids from the certificates command; repeat or comma-separate (required)",
      collectList,
    )
    .option(
      "--device <ids>",
      "device ids from the devices command, for development and ad hoc profiles; repeat or comma-separate",
      collectList,
    )
    .option(
      "--out <path>",
      "new file for the profile; never overwritten (required)",
    )
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `profiles` also has --type and --name, so Commander gives it those values.
      const options = command.optsWithGlobals();
      await runWrite(
        command,
        createProfileInput,
        { ...options, certificate: options.certificate ?? [] },
        createProfile,
      );
    });

  profiles
    .command("renew")
    .description(
      `Replace an invalid or expiring profile: deletes it and creates one with the same name, type, bundle ID, certificates and devices (or the ones you give), written to --out. Without --yes, prints the profile it replaces and what it would create. ${TEAM_KEY}`,
    )
    .argument("<profile-id>", "profile id from the profiles command")
    .option(
      "--certificate <ids>",
      "use these certificates instead; repeat or comma-separate",
      collectList,
    )
    .option(
      "--device <ids>",
      "use these devices instead; repeat or comma-separate",
      collectList,
    )
    .option(
      "--out <path>",
      "new file for the profile; never overwritten (required)",
    )
    .option(...YES)
    .action(async (profileId: string, options, command: Command) => {
      await runWrite(
        command,
        renewProfileInput,
        { profileId, ...options },
        renewProfile,
      );
    });

  profiles
    .command("delete")
    .description(
      `Delete a provisioning profile. This cannot be undone; without --yes, prints the profile. ${TEAM_KEY}`,
    )
    .argument("<profile-id>", "profile id from the profiles command")
    .option(...YES)
    .action(async (profileId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteProfileInput,
        { profileId, yes: options.yes },
        deleteProfile,
      );
    });

  program
    .command("bundle-ids")
    .description(
      `Bundle IDs (App IDs) with their capabilities. Use the id as --bundle-id in profiles create. ${TEAM_KEY}`,
    )
    .option(
      "--identifier <bundle-id>",
      "only this identifier, such as com.example.app",
    )
    .option(
      "--platform <platforms>",
      "only these platforms, such as IOS,MAC_OS",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, bundleIdsInput, options, listBundleIds);
    });

  program
    .command("devices")
    .description(
      `Registered devices: name, UDID, platform, model and status. Use the id as --device in profiles create. ${TEAM_KEY}`,
    )
    .option(
      "--platform <platforms>",
      "only these platforms, such as IOS,MAC_OS",
    )
    .option("--status <statuses>", "only ENABLED or DISABLED devices")
    .option("--name <name>", "only devices with this name")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, devicesInput, options, listDevices);
    });

  program
    .command("metrics")
    .description(
      "Power and performance metrics (hangs, launch time, disk writes, memory, battery and more) for an app or one build, summarised: Apple's regression and trend insights, then each metric's percentile and device datasets as version and value points.",
    )
    .argument("[app-id]", "numeric app ID from the apps command")
    .option(
      "--build <build-id>",
      "read one build's metrics instead (id from the builds command)",
    )
    .option(
      "--type <types>",
      "only these metric types, comma-separated: DISK, HANG, BATTERY, LAUNCH, MEMORY, ANIMATION, TERMINATION, STORAGE",
    )
    .option(
      "--device <types>",
      "only this device type, as Apple names it, such as iPhone15,2",
    )
    .action(async (appId: string | undefined, options, command: Command) => {
      await run(
        command,
        metricsInput,
        { appId, buildId: options.build, ...options },
        getMetrics,
      );
    });

  const diagnostics = program
    .command("diagnostics")
    .description(
      "A build's top diagnostic signatures (hangs, disk writes, launches), heaviest first. Read one signature's logs with diagnostics logs.",
    )
    .argument("<build-id>", "build id from the builds command")
    .addOption(
      new Option("--type <type>", "only this diagnostic type").choices([
        ...DIAGNOSTIC_TYPES,
      ]),
    )
    .option(...(LIMIT as [string, string, string]))
    .action(async (buildId: string, options, command: Command) => {
      await run(
        command,
        diagnosticsInput,
        { buildId, ...options },
        listDiagnostics,
      );
    });

  diagnostics
    .command("logs")
    .description(
      "A diagnostic signature's logs, summarised: each log's device, OS and app version, and per call stack the heaviest path of frames, marking the one Apple blames. --limit caps the number of logs.",
    )
    .argument("<signature-id>", "signature id from the diagnostics command")
    .action(async (signatureId: string, _options, command: Command) => {
      await run(
        command,
        diagnosticLogsInput,
        // `diagnostics` defines --limit, so Commander hands it to the parent.
        { signatureId, limit: command.parent?.opts().limit },
        getDiagnosticLogs,
      );
    });

  const xcodeCloud = program
    .command("xcode-cloud")
    .description(
      "Xcode Cloud: products, workflows, build runs and, for one run, its actions, issues, failed tests and artifacts. Needs a key whose role can access Xcode Cloud.",
    );

  xcodeCloud
    .command("products")
    .description(
      "Xcode Cloud products (apps and frameworks set up for Xcode Cloud) with their app. Use the id with xcode-cloud workflows.",
    )
    .option("--app <app-id>", "only the product of this app")
    .addOption(
      new Option("--type <type>", "only apps or frameworks").choices([
        "APP",
        "FRAMEWORK",
      ]),
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(
        command,
        productsInput,
        { appId: options.app, ...options },
        listProducts,
      );
    });

  xcodeCloud
    .command("workflows")
    .description(
      "A product's workflows: enabled or not, repository, last change and actions (build, test, analyze, archive).",
    )
    .argument("<product-id>", "product id from xcode-cloud products")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (productId: string, options, command: Command) => {
      await run(
        command,
        workflowsInput,
        { productId, ...options },
        listWorkflows,
      );
    });

  xcodeCloud
    .command("runs")
    .description(
      "A workflow's build runs, newest first: number, progress and result, start reason, branch or tag, pull request, commit and issue counts.",
    )
    .argument("<workflow-id>", "workflow id from xcode-cloud workflows")
    .option(
      "--branch <name>",
      "only runs on this source or destination branch or tag; Apple has no such filter, so it applies to the page read",
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (workflowId: string, options, command: Command) => {
      await run(command, runsInput, { workflowId, ...options }, listRuns);
    });

  xcodeCloud
    .command("run")
    .description(
      "One build run: its status, then each action with its issues (errors, warnings, analyzer warnings, test failures) and, for a test action, its failed tests.",
    )
    .argument("<run-id>", "run id from xcode-cloud runs")
    .action(async (runId: string, _options, command: Command) => {
      await run(command, runInput, { runId }, getRun);
    });

  xcodeCloud
    .command("artifacts")
    .description(
      "A build run's artifacts per action (logs, archives, result bundles): type, file name, size and a download link. Nothing is downloaded.",
    )
    .argument("<run-id>", "run id from xcode-cloud runs")
    .action(async (runId: string, _options, command: Command) => {
      await run(command, artifactsInput, { runId }, listArtifacts);
    });

  const ELIGIBILITY =
    "Only for accounts with Apple's EU alternative distribution entitlement; otherwise Apple refuses with a [permission] error.";

  const altDistribution = program
    .command("alt-distribution")
    .description(
      `EU alternative distribution: keys, the packages Apple builds for a version, and an alternative marketplace's search details and webhooks. ${ELIGIBILITY}`,
    );

  const altKeys = altDistribution
    .command("keys")
    .description(
      "Alternative distribution keys: the account's, or one app's with --app. Prints ids and a fingerprint, never the public key; use keys export to write it to a file.",
    )
    .option("--app <app-id>", "only this app's key")
    .addOption(
      new Option("--scope <scope>", "only app keys or account keys").choices([
        "app",
        "account",
      ]),
    )
    .option(...(LIMIT as [string, string, string]))
    .action(async (options, command: Command) => {
      await run(
        command,
        keysInput,
        { appId: options.app, ...options },
        listKeys,
      );
    });

  altKeys
    .command("export")
    .description("Write a key's public key to a new file; it is never printed.")
    .argument("<key-id>", "key id from alt-distribution keys")
    .option("--out <path>", "new file for the public key; never overwritten")
    .action(async (keyId: string, options, command: Command) => {
      await run(command, exportKeyInput, { keyId, ...options }, exportKey);
    });

  altKeys
    .command("create")
    .description(
      "Add an alternative distribution key from a public key file, for the account or, with --app, for one app. Without --yes, prints the key's fingerprint and the existing keys.",
    )
    .option(
      "--public-key-file <path>",
      "file holding the public key (required)",
    )
    .option("--app <app-id>", "add the key to this app")
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `keys` also has --app, so Commander gives it the value.
      const options = command.optsWithGlobals();
      await runWrite(
        command,
        createKeyInput,
        { appId: options.app, ...options },
        createKey,
      );
    });

  altKeys
    .command("delete")
    .description(
      "Delete an alternative distribution key. Without --yes, prints the key's id and fingerprint.",
    )
    .argument("<key-id>", "key id from alt-distribution keys")
    .option(...YES)
    .action(async (keyId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteKeyInput,
        { keyId, yes: options.yes },
        deleteKey,
      );
    });

  const altPackage = altDistribution
    .command("package")
    .description(
      "The alternative distribution package of an App Store version and its versions: state, checksums and when their download expires. Download URLs are never printed.",
    )
    .argument("<version-id>", "version id from the versions command")
    .action(async (versionId: string, _options, command: Command) => {
      await run(command, packageInput, { versionId }, getPackage);
    });

  altPackage
    .command("request")
    .description(
      "Ask Apple to build the alternative distribution package for an App Store version. Without --yes, checks the version has none yet.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        requestPackageInput,
        { versionId, yes: options.yes },
        requestPackage,
      );
    });

  altDistribution
    .command("package-versions")
    .description(
      "A package's versions with their variants and deltas: version, state, checksum and download expiry. Download URLs and key blobs are never printed; use alt-distribution download.",
    )
    .argument("<package-id>", "package id from alt-distribution package")
    .addOption(
      new Option("--state <state>", "only this state").choices([
        "COMPLETED",
        "REPLACED",
      ]),
    )
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (packageId: string, options, command: Command) => {
      await run(
        command,
        packageVersionsInput,
        { packageId, ...options },
        listPackageVersions,
      );
    });

  altDistribution
    .command("download")
    .description(
      "Download a package version, or one of its variants or deltas, to a new file through Apple's signed URL, which is never printed. A variant's or delta's key blob goes to --key-blob-out.",
    )
    .argument(
      "<package-version-id>",
      "package version id from alt-distribution package-versions",
    )
    .option("--variant <id>", "download this variant of the version")
    .option("--delta <id>", "download this delta of the version")
    .option("--out <path>", "new file for the package; never overwritten")
    .option(
      "--key-blob-out <path>",
      "new file for the variant's or delta's key blob",
    )
    .action(async (packageVersionId: string, options, command: Command) => {
      await run(
        command,
        downloadInput,
        { packageVersionId, ...options },
        downloadPackage,
      );
    });

  const marketplace = altDistribution
    .command("marketplace")
    .description(
      "An app's alternative marketplace search details: its catalog URL.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, marketplaceInput, { appId }, getMarketplace);
    });

  marketplace
    .command("set")
    .description(
      "Set an app's marketplace catalog URL, creating its search details if there are none. Without --yes, prints the change.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--catalog-url <url>", "the catalog's https:// URL (required)")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setMarketplaceInput,
        { appId, ...options },
        setMarketplace,
      );
    });

  marketplace
    .command("delete")
    .description(
      "Remove an app's marketplace search details. Without --yes, prints them.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteMarketplaceInput,
        { appId, yes: options.yes },
        deleteMarketplace,
      );
    });

  const webhooks = altDistribution
    .command("webhooks")
    .description("The marketplace's webhooks: id and endpoint URL.")
    .option(...(LIMIT as [string, string, string]))
    .action(async (options, command: Command) => {
      await run(command, webhooksInput, options, listWebhooks);
    });

  webhooks
    .command("create")
    .description(
      "Add a marketplace webhook. The secret is read from --secret-file and never printed. Without --yes, prints the endpoint.",
    )
    .option("--endpoint-url <url>", "the webhook's https:// URL (required)")
    .option("--secret-file <path>", "file holding the secret (required)")
    .option(...YES)
    .action(async (options, command: Command) => {
      await runWrite(command, createWebhookInput, options, createWebhook);
    });

  webhooks
    .command("set")
    .description(
      "Change a marketplace webhook's endpoint URL or secret. Without --yes, prints the change.",
    )
    .argument("<webhook-id>", "webhook id from alt-distribution webhooks")
    .option("--endpoint-url <url>", "the new https:// URL")
    .option("--secret-file <path>", "file holding the new secret")
    .option(...YES)
    .action(async (webhookId: string, options, command: Command) => {
      await runWrite(
        command,
        setWebhookInput,
        { webhookId, ...options },
        setWebhook,
      );
    });

  webhooks
    .command("delete")
    .description("Delete a marketplace webhook. Without --yes, prints it.")
    .argument("<webhook-id>", "webhook id from alt-distribution webhooks")
    .option(...YES)
    .action(async (webhookId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteWebhookInput,
        { webhookId, yes: options.yes },
        deleteWebhook,
      );
    });

  return program;
}
