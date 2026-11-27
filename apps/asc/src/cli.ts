import { readFile } from "node:fs/promises";
import { Argument, Command, Option } from "commander";
import * as z from "zod";
import pkg from "../package.json" with { type: "json" };
import type { AscClient } from "./asc/client.ts";
import type { CredentialOptions } from "./asc/credentials.ts";
import { createS3Uploader, type S3Uploader } from "./asc/s3.ts";
import {
  ageRatingInput,
  getAgeRating,
  setAgeRating,
  setAgeRatingInput,
} from "./commands/age-rating.ts";
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
import { API_METHODS, apiGet, apiInput, apiWrite } from "./commands/api.ts";
import {
  appInfoInput,
  categoriesInput,
  getAppInfo,
  setAppInfo,
  setAppInfoInput,
  setCategories,
} from "./commands/app-info.ts";
import {
  appsInput,
  contentRightsInput,
  listApps,
  setContentRights,
} from "./commands/apps.ts";
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
  downloadDsyms,
  dsymsInput,
  expireBuild,
  expireBuilds,
  expireBuildsInput,
  expireInput,
  latestBuild,
  latestInput,
  listBuilds,
  setBuildCompliance,
  type WaitDependencies,
  waitForBuild,
  waitInput,
} from "./commands/builds.ts";
import { completionScript, SHELLS, type Shell } from "./commands/completion.ts";
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
  createIap,
  createIapInput,
  createSubscription,
  createSubscriptionGroup,
  createSubscriptionGroupInput,
  createSubscriptionInput,
  getIap,
  getSubscription,
  IAP_TYPES,
  iapAvailabilityInput,
  iapInput,
  iapListInput,
  listIaps,
  listSubscriptions,
  localizeIap,
  localizeIapInput,
  localizeSubscription,
  localizeSubscriptionGroup,
  localizeSubscriptionGroupInput,
  localizeSubscriptionInput,
  PLAN_TYPES,
  PRODUCT_STATES,
  priceIap,
  priceIapInput,
  priceSubscription,
  priceSubscriptionInput,
  reviewScreenshotInput,
  SUBSCRIPTION_PERIODS,
  setIap,
  setIapAvailability,
  setIapInput,
  setSubscription,
  setSubscriptionAvailability,
  setSubscriptionInput,
  submitIap,
  submitIapInput,
  submitSubscription,
  submitSubscriptionInput,
  subscriptionAvailabilityInput,
  subscriptionInput,
  subscriptionsInput,
  uploadIapReviewScreenshot,
  uploadSubscriptionReviewScreenshot,
} from "./commands/iap.ts";
import {
  installSigning,
  installSigningInput,
  uninstallSigning,
  uninstallSigningInput,
} from "./commands/keychain.ts";
import {
  getMetadata,
  metadataInput,
  setMetadata,
  setMetadataInput,
} from "./commands/metadata.ts";

import {
  lintInput,
  lintMetadata,
  pullInput,
  pullMetadata,
  pushInput,
  pushMetadata,
} from "./commands/metadata-sync.ts";
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
  getSubmission,
  getSubmissionLog,
  listSubmissions,
  notarizeHistoryInput,
  notarizeSubmissionInput,
  notarizeSubmitInput,
  submitNotarization,
} from "./commands/notarize.ts";
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
import {
  getPricing,
  pricingInput,
  setPricing,
  setPricingInput,
} from "./commands/pricing.ts";
import {
  listPromoted,
  promotedInput,
  setPromoted,
  setPromotedInput,
} from "./commands/promoted-purchases.ts";
import {
  BUNDLE_ID_PLATFORMS,
  bundleIdCapabilitiesInput,
  bundleIdsInput,
  CAPABILITY_TYPES,
  CERTIFICATE_TYPES,
  certificatesInput,
  createBundleId,
  createBundleIdInput,
  createCertificate,
  createCertificateInput,
  createProfile,
  createProfileInput,
  deleteProfile,
  deleteProfileInput,
  devicesInput,
  disableCapability,
  disableCapabilityInput,
  enableCapability,
  enableCapabilityInput,
  listBundleIdCapabilities,
  listBundleIds,
  listCertificates,
  listDevices,
  listProfiles,
  PROFILE_TYPES,
  profilesInput,
  registerDevices,
  registerDevicesInput,
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
  attachInput,
  attachReviewFile,
  detachInput,
  detachReviewFile,
  getReviewDetails,
  reviewDetailsInput,
  setReviewDetails,
  setReviewDetailsInput,
} from "./commands/review-details.ts";
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
  clearHistoryInput,
  clearSandboxHistory,
  listSandboxTesters,
  RENEWAL_RATES,
  sandboxTestersInput,
  setSandboxTester,
  setSandboxTesterInput,
} from "./commands/sandbox.ts";
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
import {
  nukeSigning,
  nukeSigningInput,
  syncSigning,
  syncSigningInput,
} from "./commands/signing.ts";
import { getStatus, statusInput } from "./commands/status.ts";
import {
  CUSTOMER_ELIGIBILITIES,
  createCustomCode,
  createIntroOffer,
  createIntroOfferInput,
  createOfferCode,
  createOfferCodeInput,
  createPromoOffer,
  createPromoOfferInput,
  createWinBack,
  createWinBackInput,
  customCodeInput,
  deactivateCodeInput,
  deactivateOfferCode,
  deleteOfferInput,
  deletePromoOffer,
  deleteWinBack,
  endIntroOfferInput,
  endIntroOffers,
  generateCodes,
  generateCodesInput,
  listOffers,
  OFFER_DURATIONS,
  OFFER_ELIGIBILITIES,
  OFFER_MODES,
  offersInput,
  saveCodeBatch,
  saveCodesInput,
  setPromoOffer,
  setPromoOfferInput,
  setWinBack,
  setWinBackInput,
} from "./commands/subscription-offers.ts";
import {
  addBuildInput,
  addBuildToGroup,
  addTesters,
  addTestersInput,
  betaFeedbackInput,
  betaGroupsInput,
  betaInfoInput,
  betaReviewInput,
  betaTestersInput,
  createGroup,
  createGroupInput,
  deleteGroup,
  deleteGroupInput,
  exportTesters,
  exportTestersInput,
  FEEDBACK_TYPES,
  getBetaInfo,
  getBetaReview,
  importTesters,
  importTestersInput,
  listBetaFeedback,
  listBetaGroups,
  listBetaTesters,
  notesInput,
  notifyInput,
  notifyTesters,
  removeTesters,
  removeTestersInput,
  setBetaInfo,
  setBetaInfoInput,
  setBetaReviewDetails,
  setBetaReviewDetailsInput,
  setBuildNotes,
  setGroup,
  setGroupInput,
  submitBetaReview,
  submitBetaReviewInput,
} from "./commands/testflight.ts";
import {
  cancelInvitation,
  cancelInvitationInput,
  invitationsInput,
  inviteInput,
  inviteUser,
  listInvitations,
  listUsers,
  removeUser,
  removeUserInput,
  setUser,
  setUserInput,
  USER_ROLES,
  usersInput,
} from "./commands/users.ts";
import { checkInput, checkVersion } from "./commands/version-check.ts";
import {
  createVersion,
  createVersionInput,
  listVersions,
  RELEASE_TYPES,
  setVersion,
  setVersionInput,
  versionsInput,
} from "./commands/versions.ts";
import {
  artifactsInput,
  getRun,
  listArtifacts,
  listProducts,
  listRuns,
  listWorkflows,
  productsInput,
  rerunInput,
  rerunRun,
  runInput,
  runsInput,
  startInput,
  startRun,
  waitForRun,
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

/** Clock and sleep for `builds wait`, fetch for `metadata lint`'s URL checks, and the S3 upload for `notarize submit`; tests pass fakes. */
export type ProgramOptions = Partial<
  Pick<WaitDependencies, "sleep" | "now"> & { fetch: typeof fetch }
> & {
  notaryUpload?: S3Uploader;
};

/** The one group a --group option names; the option collects, so more than one is an error. */
function oneGroup(command: Command, groups: string[] | undefined) {
  if (groups && groups.length > 1) {
    return command.error("[invalid_input] Give one --group.");
  }
  return groups?.[0];
}

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
    fetch: fetchUrl = fetch,
    notaryUpload = createS3Uploader(),
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
    local = false,
  ): Promise<void> {
    const result = await run(command, schema, input, execute, local);
    if (result.dryRun) {
      stderr(command)(
        "Dry run: nothing was changed. Run the same command with --yes to do it.\n",
      );
    }
  }

  /** Like runWrite, for local commands that need no App Store Connect key. */
  async function runLocalWrite<Schema extends z.ZodType>(
    command: Command,
    schema: Schema,
    input: unknown,
    execute: (input: z.output<Schema>) => Promise<{ dryRun: boolean }>,
  ): Promise<void> {
    await runWrite(
      command,
      schema,
      input,
      (_client, parsed) => execute(parsed),
      true,
    );
  }

  /** Validates the input, runs the query, prints its result and returns it. */
  async function run<Schema extends z.ZodType, Result>(
    command: Command,
    schema: Schema,
    input: unknown,
    execute: (client: AscClient, input: z.output<Schema>) => Promise<Result>,
    local = false,
  ): Promise<Result> {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return command.error(`[invalid_input] ${z.prettifyError(parsed.error)}`);
    }
    let result: Result;
    try {
      // Local commands (signing install) never ask for the key.
      const client = local
        ? ({} as AscClient)
        : await getClient(program.opts<CredentialOptions>());
      result = await execute(client, parsed.data);
    } catch (error) {
      // Classified messages never carry the token or the private key.
      const { kind, message } = classifyError(error);
      return command.error(`[${kind}] ${message}`);
    }
    console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const apps = program
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

  apps
    .command("content-rights")
    .description(
      "Declare whether an app shows, accesses or includes third-party content. Without --yes, prints the current and new declaration. Needs a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--uses-third-party-content", "the app uses third-party content")
    .option("--no-third-party-content", "the app uses none")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      if (
        options.usesThirdPartyContent &&
        options.thirdPartyContent === false
      ) {
        return command.error(
          "[invalid_input] Give --uses-third-party-content or --no-third-party-content, not both.",
        );
      }
      const declaration = options.usesThirdPartyContent
        ? "USES_THIRD_PARTY_CONTENT"
        : options.thirdPartyContent === false
          ? "DOES_NOT_USE_THIRD_PARTY_CONTENT"
          : undefined;
      await runWrite(
        command,
        contentRightsInput,
        { appId, declaration, yes: options.yes },
        setContentRights,
      );
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

  versions
    .command("check")
    .description(
      "Report whether a version is ready to submit for App Review, changing nothing: its state, build and export compliance, open review submission, required metadata and app info per locale, screenshots per locale, age rating, accessibility declarations, App Review details, pricing and availability. Lists under blocking what to fix and exits 1 when anything blocks submission. Categories, content rights and metadata lint are marked not_available.",
    )
    .argument("<version-id>", "version id from the versions command")
    .action(async (versionId: string, _options, command: Command) => {
      const report = await run(
        command,
        checkInput,
        { versionId },
        checkVersion,
      );
      if (!report.ready) {
        command.error(
          `[invalid_input] Version ${report.version.version} is not ready to submit: ${report.blocking.length} problem(s), listed under "blocking".`,
        );
      }
    });

  versions
    .command("create")
    .description(
      "Create the next App Store version of an app. Refuses a version string the app already has on that platform. --copy-from copies another version's localized description, keywords, promotional text and URLs (not What's New) into the new one, one request per locale. Without --yes, prints the version and what would be copied. Needs a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--app-version <version>",
      "the version string, such as 2.5.0 (required)",
    )
    .addOption(
      new Option(
        "--platform <platform>",
        "the platform (default: IOS)",
      ).choices(PLATFORMS),
    )
    .option(
      "--copy-from <version-id>",
      "copy the localized metadata of this version, from the versions command",
    )
    .option(
      "--copyright <text>",
      "the copyright line, such as 2026 Example Ltd",
    )
    .addOption(
      new Option("--release-type <type>", "when to release it").choices(
        RELEASE_TYPES,
      ),
    )
    .option(
      "--release-date <date>",
      "earliest release date for SCHEDULED, such as 2026-12-01T09:00:00Z",
    )
    .option(...YES)
    .action(async (appId: string, _options, command: Command) => {
      // The parent versions command also defines --platform.
      const options = command.optsWithGlobals();
      await runWrite(
        command,
        createVersionInput,
        {
          appId,
          version: options.appVersion,
          platform: options.platform,
          copyFrom: options.copyFrom,
          copyright: options.copyright,
          releaseType: options.releaseType,
          releaseDate: options.releaseDate,
          yes: options.yes,
        },
        createVersion,
      );
    });

  versions
    .command("set")
    .description(
      "Change a version's release type (MANUAL, AFTER_APPROVAL or SCHEDULED), scheduled release date or copyright. Only a version being prepared or rejected accepts changes. Without --yes, prints the current and new values. Needs a key with the App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .addOption(
      new Option("--release-type <type>", "when to release it").choices(
        RELEASE_TYPES,
      ),
    )
    .option(
      "--release-date <date>",
      "earliest release date for SCHEDULED, such as 2026-12-01T09:00:00Z",
    )
    .option("--copyright <text>", "the copyright line")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        setVersionInput,
        { versionId, ...options },
        setVersion,
      );
    });

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

  metadata
    .command("pull")
    .description(
      "Write an app's App Store listing into a new folder: version.json with the copyright, and per locale metadata.json (the version's description, keywords, promotional text, What's New and URLs, and the app info's name, subtitle and privacy links) and its screenshots and app previews, named <GROUP>-<NN>-<name>. Uses the version being prepared or rejected, else the live one, unless --version-id is given.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--dir <folder>", "the new or empty folder to write (required)")
    .option("--version-id <id>", "the version to pull")
    .option("--platform <platform>", "IOS, MAC_OS, TV_OS or VISION_OS", "IOS")
    .option("--no-media", "leave out screenshots and app previews")
    .action(async (appId: string, options, command: Command) => {
      const { versionId, ...rest } = options;
      await run(
        command,
        pullInput,
        { appId, versionId, ...rest },
        pullMetadata,
      );
    });

  metadata
    .command("push")
    .description(
      "Compare a folder from metadata pull with App Store Connect and apply only the differences: fields a metadata.json gives (null clears one, a missing key is left alone), the copyright, new locales, and screenshots and app previews not yet placed (matched by file name). --sync-screenshots also removes placements the folder does not have and reorders to the folder's order. The metadata lint runs first and stops the push on errors. Without --yes, prints the plan per locale. Needs a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .argument("<folder>", "the folder from metadata pull")
    .option("--version-id <id>", "the version to push to")
    .option("--platform <platform>", "IOS, MAC_OS, TV_OS or VISION_OS", "IOS")
    .option(
      "--sync-screenshots",
      "also remove and reorder screenshots and previews to match the folder",
    )
    .option("--ignore-lint", "push even when the lint finds errors")
    .option(
      "--rule <name=severity>",
      "set a lint rule to error, warning or off; repeatable",
      collectList,
    )
    .option("--no-url-check", "skip the lint's requests to the listing's URLs")
    .option(...YES)
    .action(async (appId: string, dir: string, options, command: Command) => {
      const { versionId, rule, urlCheck, ...rest } = options;
      await runWrite(
        command,
        pushInput,
        {
          appId,
          dir,
          versionId,
          rules: rule ?? [],
          checkUrls: urlCheck,
          ...rest,
        },
        (client, input) =>
          pushMetadata(client, input, { fetch: fetchUrl, now }),
      );
    });

  metadata
    .command("lint")
    .description(
      'Check a version\'s listing in every locale, or a folder from metadata pull (--dir, no key needed), for what App Review often rejects: field lengths, placeholder text, other platforms or stores, unreachable support, marketing and privacy URLs, a copyright without this year, "free" in in-app purchase names, promises of features to come and negative references to Apple. Prints each finding with its locale, field, rule and severity, and exits 1 when any is an error.',
    )
    .argument("[version-id]", "version id from the versions command")
    .option("--dir <folder>", "lint a folder from metadata pull instead")
    .option(
      "--rule <name=severity>",
      "set a rule (length, placeholder, other-platforms, url-reachable, copyright-year, free-iap, future-features, apple-negative) to error, warning or off; repeatable",
      collectList,
    )
    .option("--no-url-check", "skip requests to the listing's URLs")
    .action(
      async (versionId: string | undefined, options, command: Command) => {
        const input = {
          versionId,
          dir: options.dir,
          rules: options.rule ?? [],
          checkUrls: options.urlCheck,
        };
        const execute = (
          client: AscClient | undefined,
          parsed: z.output<typeof lintInput>,
        ) => lintMetadata(client, parsed, { fetch: fetchUrl, now });
        let result: { errors: number };
        if (options.dir !== undefined && versionId === undefined) {
          // A folder needs no key, so no client is made.
          const parsed = lintInput.safeParse(input);
          if (!parsed.success) {
            return command.error(
              `[invalid_input] ${z.prettifyError(parsed.error)}`,
            );
          }
          try {
            result = await execute(undefined, parsed.data);
          } catch (error) {
            const { kind, message } = classifyError(error);
            return command.error(`[${kind}] ${message}`);
          }
          console.log(JSON.stringify(result, null, 2));
        } else {
          result = await run(command, lintInput, input, execute);
        }
        if (result.errors > 0) {
          command.error(
            `[invalid_input] The metadata lint found ${result.errors} error(s).`,
          );
        }
      },
    );

  const reviewDetails = program
    .command("review-details")
    .description(
      "A version's App Review details: contact name, phone and email, whether a demo account is needed and its user name (the password is never shown, only whether one is set), notes, attachments, and which required fields are missing.",
    )
    .argument("<version-id>", "version id from the versions command")
    .action(async (versionId: string, _options, command: Command) => {
      await run(command, reviewDetailsInput, { versionId }, getReviewDetails);
    });

  reviewDetails
    .command("set")
    .description(
      "Set a version's App Review details, creating them if it has none. Only a version being prepared or rejected accepts changes. The demo account password comes from --demo-account-password or ASC_DEMO_ACCOUNT_PASSWORD, is always sent when given, and is never printed. Without --yes, prints the current and new values. Needs a key with the App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .option("--contact-first-name <name>", "App Review contact's first name")
    .option("--contact-last-name <name>", "App Review contact's last name")
    .option("--contact-phone <phone>", "contact phone, such as +1 408 555 0100")
    .option("--contact-email <email>", "contact email")
    .option("--demo-account-required", "App Review needs a demo account")
    .option("--no-demo-account-required", "App Review needs no demo account")
    .option("--demo-account-name <name>", "the demo account's user name")
    .addOption(
      new Option(
        "--demo-account-password <password>",
        "the demo account's password; prefer the environment variable, which stays out of shell history",
      ).env("ASC_DEMO_ACCOUNT_PASSWORD"),
    )
    .option("--notes <text>", "notes for App Review")
    .option(...YES)
    .action(async (versionId: string, options, command: Command) => {
      await runWrite(
        command,
        setReviewDetailsInput,
        { versionId, ...options },
        setReviewDetails,
      );
    });

  reviewDetails
    .command("attach")
    .description(
      "Upload a file, such as a demo video, as an App Review attachment of a version being prepared or rejected. Without --yes, prints the version and the file. Needs a key with the App Manager role.",
    )
    .argument("<version-id>", "version id from the versions command")
    .argument("<file>", "the file to attach")
    .option(...YES)
    .action(
      async (versionId: string, file: string, options, command: Command) => {
        await runWrite(
          command,
          attachInput,
          { versionId, file, yes: options.yes },
          attachReviewFile,
        );
      },
    );

  reviewDetails
    .command("detach")
    .description(
      "Remove an App Review attachment from a version being prepared or rejected. Without --yes, prints the version and the attachment. Needs a key with the App Manager role.",
    )
    .argument(
      "<attachment-id>",
      "attachment id from the review-details command",
    )
    .option(...YES)
    .action(async (attachmentId: string, options, command: Command) => {
      await runWrite(
        command,
        detachInput,
        { attachmentId, yes: options.yes },
        detachReviewFile,
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

  appInfo
    .command("categories")
    .description(
      "Set an app info's primary and secondary categories and subcategories, checked against Apple's category list; give none to clear one. Only an app info being prepared or rejected accepts changes. Without --yes, prints the current and new categories. Needs a key with the App Manager role.",
    )
    .argument("<app-info-id>", "app info id from the app-info command")
    .option("--primary <id>", "the primary category, such as GAMES")
    .option("--primary-sub <id>", "the primary's first subcategory")
    .option("--primary-sub-two <id>", "the primary's second subcategory")
    .option("--secondary <id>", "the secondary category, or none")
    .option("--secondary-sub <id>", "the secondary's first subcategory")
    .option("--secondary-sub-two <id>", "the secondary's second subcategory")
    .option(...YES)
    .action(async (appInfoId: string, options, command: Command) => {
      await runWrite(
        command,
        categoriesInput,
        {
          appInfoId,
          primaryCategory: options.primary,
          primarySubcategoryOne: options.primarySub,
          primarySubcategoryTwo: options.primarySubTwo,
          secondaryCategory: options.secondary,
          secondarySubcategoryOne: options.secondarySub,
          secondarySubcategoryTwo: options.secondarySubTwo,
          yes: options.yes,
        },
        setCategories,
      );
    });

  const pricing = program
    .command("pricing")
    .description(
      "An app's price schedule: its base territory and currency, the prices set by hand (current and scheduled) and the prices Apple derives for every other territory, each with customer price, proceeds and start and end dates.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--territory <codes>",
      "only these territories, comma-separated alpha-3 codes such as USA,JPN",
    )
    .action(async (appId: string, options, command: Command) => {
      await run(command, pricingInput, { appId, ...options }, getPricing);
    });

  pricing
    .command("set")
    .description(
      "Replace an app's price schedule: the base territory's price, which Apple equalizes to every other territory, and any territories priced by hand, from --start-date or now. Prices are Apple's price points, so each is matched to the nearest. Scheduled changes are kept unless --drop-scheduled. Without --yes, prints the current and new manual prices.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--base-territory <code>",
      "the territory --price is in, such as USA (required)",
    )
    .option(
      "--price <amount>",
      "the customer price there, matched to the nearest price point (required)",
    )
    .option(
      "--override <territory=price>",
      "price a territory by hand instead, such as GBR=2.99; comma-separated or repeated",
      collectList,
    )
    .option("--start-date <date>", "when the new price starts (default: now)")
    .option("--drop-scheduled", "drop price changes scheduled for later")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setPricingInput,
        { appId, ...options },
        setPricing,
      );
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
      "Add an app to territories (--available) or remove it from them (--no-available), and turn pre-orders on or off there (--pre-order, --no-pre-order) with their --release-date. Without --yes, prints each territory's current availability, pre-order and release date. Needs a key with the App Manager role.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--territory <codes>",
      "alpha-3 territory codes, comma-separated or repeated, such as USA,GBR (required)",
      collectList,
    )
    .option("--available", "make the app available in these territories")
    .option("--no-available", "remove the app from these territories")
    .option("--pre-order", "offer the app for pre-order there")
    .option("--no-pre-order", "end the pre-order there")
    .option(
      "--release-date <date>",
      "the release date there, such as 2026-12-01",
    )
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setAvailabilityInput,
        {
          appId,
          territories: options.territory ?? [],
          available: options.available,
          preOrder: options.preOrder,
          releaseDate: options.releaseDate,
          yes: options.yes,
        },
        setAvailability,
      );
    });

  const iap = program
    .command("iap")
    .description(
      "An app's in-app purchases: reference name, product ID, type and review state. A product missing from the app is often one never submitted for review. Commands that change anything need a key with the App Manager role.",
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
      "An app's subscription groups, each with its subscriptions' reference name, product ID, period, level and review state. Commands that change anything need a key with the App Manager role.",
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

  const PRICE_OPTIONS = {
    base: [
      "--base-territory <code>",
      "the territory --price is in, such as USA (required)",
    ],
    price: [
      "--price <amount>",
      "the customer price there, matched to the nearest of Apple's price points (required)",
    ],
    override: [
      "--override <territory=price>",
      "price a territory by hand instead, such as GBR=3.99; comma-separated or repeated",
    ],
  } as const;

  iap
    .command("create")
    .description(
      "Create an in-app purchase; add a localization, price, availability and review screenshot, then submit it. Without --yes, prints what would be created.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .addOption(
      new Option("--type <type>", "the product type (required)").choices([
        ...IAP_TYPES,
      ]),
    )
    .option("--product-id <id>", "the product ID the app uses (required)")
    .option(
      "--reference-name <name>",
      "the name in App Store Connect (required)",
    )
    .option("--family-sharable", "allow Family Sharing (cannot be undone)")
    .option("--review-note <text>", "a note for App Review")
    .option(...YES)
    .action(async (appId: string, _options, command: Command) => {
      // The iap list command also has --type, and Commander gives the value to it.
      await runWrite(
        command,
        createIapInput,
        { appId, ...command.optsWithGlobals() },
        createIap,
      );
    });

  iap
    .command("set")
    .description(
      "Change an in-app purchase's reference name, review note or Family Sharing. Without --yes, prints the current and new values.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option("--reference-name <name>", "the name in App Store Connect")
    .option("--review-note <text>", "a note for App Review")
    .option("--family-sharable", "allow Family Sharing (cannot be undone)")
    .option(...YES)
    .action(async (iapId: string, options, command: Command) => {
      await runWrite(command, setIapInput, { iapId, ...options }, setIap);
    });

  iap
    .command("localize")
    .description(
      "Set one locale's display name and description of an in-app purchase, adding the locale if it is new. Without --yes, prints the current and new values.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option("--locale <locale>", "such as en-US (required)")
    .option("--name <name>", "the display name, up to 35 characters (required)")
    .option("--description <text>", "the description, up to 55 characters")
    .option(...YES)
    .action(async (iapId: string, options, command: Command) => {
      await runWrite(
        command,
        localizeIapInput,
        { iapId, ...options },
        localizeIap,
      );
    });

  iap
    .command("price")
    .description(
      "Replace an in-app purchase's price schedule: the base territory's price, which Apple equalizes to every other territory, and any territories priced by hand. Prices are Apple's price points, so each is matched to the nearest. Scheduled changes are kept unless --drop-scheduled. Without --yes, prints the current and new manual prices.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option(...PRICE_OPTIONS.base)
    .option(...PRICE_OPTIONS.price)
    .option(...PRICE_OPTIONS.override, collectList)
    .option("--start-date <date>", "when the new price starts (default: now)")
    .option("--drop-scheduled", "drop price changes scheduled for later")
    .option(...YES)
    .action(async (iapId: string, options, command: Command) => {
      await runWrite(command, priceIapInput, { iapId, ...options }, priceIap);
    });

  iap
    .command("availability")
    .description(
      "Set the territories an in-app purchase is sold in, replacing the current list. Without --yes, prints the territories added and removed.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option(
      "--territory <codes>",
      "alpha-3 territory codes, comma-separated or repeated",
      collectList,
    )
    .option("--all", "every App Store territory")
    .option(
      "--available-in-new-territories",
      "join territories Apple adds later",
    )
    .option("--no-available-in-new-territories", "do not join them")
    .option(...YES)
    .action(async (iapId: string, options, command: Command) => {
      await runWrite(
        command,
        iapAvailabilityInput,
        { iapId, ...options, territories: options.territory ?? [] },
        setIapAvailability,
      );
    });

  iap
    .command("review-screenshot")
    .description("The screenshot App Review sees for an in-app purchase.")
    .command("upload")
    .description(
      "Upload the review screenshot, replacing the old one. Without --yes, prints the file and the screenshot it replaces.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option("--file <path>", "the PNG or JPEG image (required)")
    .option(...YES)
    .action(async (id: string, options, command: Command) => {
      await runWrite(
        command,
        reviewScreenshotInput,
        { id, ...options },
        uploadIapReviewScreenshot,
      );
    });

  iap
    .command("submit")
    .description(
      "Submit an in-app purchase for review. A product's first submission is reviewed with the next app version submitted. Without --yes, prints the product and its state.",
    )
    .argument("<iap-id>", "in-app purchase id from the iap command")
    .option(...YES)
    .action(async (iapId: string, options, command: Command) => {
      await runWrite(command, submitIapInput, { iapId, ...options }, submitIap);
    });

  const group = subscriptions
    .command("group")
    .description("Subscription groups: create and localize them.");

  group
    .command("create")
    .description(
      "Create a subscription group. Without --yes, prints the group and how many the app has.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--reference-name <name>",
      "the name in App Store Connect (required)",
    )
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        createSubscriptionGroupInput,
        { appId, ...options },
        createSubscriptionGroup,
      );
    });

  group
    .command("localize")
    .description(
      "Set one locale's display name of a subscription group, and the app name shown with it. Without --yes, prints the current and new values.",
    )
    .argument("<group-id>", "group id from the subscriptions command")
    .option("--locale <locale>", "such as en-US (required)")
    .option("--name <name>", "the group's display name (required)")
    .option("--custom-app-name <name>", "the app name shown with the group")
    .option(...YES)
    .action(async (groupId: string, options, command: Command) => {
      await runWrite(
        command,
        localizeSubscriptionGroupInput,
        { groupId, ...options },
        localizeSubscriptionGroup,
      );
    });

  subscriptions
    .command("create")
    .description(
      "Create an auto-renewable subscription in a group; add a localization, price, availability and review screenshot, then submit it. Without --yes, prints it with the group's other subscriptions.",
    )
    .argument("<group-id>", "group id from the subscriptions command")
    .option("--product-id <id>", "the product ID the app uses (required)")
    .option(
      "--reference-name <name>",
      "the name in App Store Connect (required)",
    )
    .addOption(
      new Option("--period <period>", "the billing period (required)").choices([
        ...SUBSCRIPTION_PERIODS,
      ]),
    )
    .option("--group-level <level>", "its level in the group, 1 the highest")
    .option("--family-sharable", "allow Family Sharing (cannot be undone)")
    .option("--review-note <text>", "a note for App Review")
    .option(...YES)
    .action(async (groupId: string, options, command: Command) => {
      await runWrite(
        command,
        createSubscriptionInput,
        { groupId, ...options },
        createSubscription,
      );
    });

  subscriptions
    .command("set")
    .description(
      "Change a subscription's reference name, period, level, Family Sharing or review note. Without --yes, prints the current and new values.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option("--reference-name <name>", "the name in App Store Connect")
    .addOption(
      new Option("--period <period>", "the billing period").choices([
        ...SUBSCRIPTION_PERIODS,
      ]),
    )
    .option("--group-level <level>", "its level in the group, 1 the highest")
    .option("--family-sharable", "allow Family Sharing (cannot be undone)")
    .option("--review-note <text>", "a note for App Review")
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        setSubscriptionInput,
        { subscriptionId, ...options },
        setSubscription,
      );
    });

  subscriptions
    .command("localize")
    .description(
      "Set one locale's display name and description of a subscription, adding the locale if it is new. Without --yes, prints the current and new values.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option("--locale <locale>", "such as en-US (required)")
    .option("--name <name>", "the display name, up to 35 characters (required)")
    .option("--description <text>", "the description, up to 55 characters")
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        localizeSubscriptionInput,
        { subscriptionId, ...options },
        localizeSubscription,
      );
    });

  subscriptions
    .command("price")
    .description(
      "Price a subscription in every territory from the base territory's price, using Apple's equalized price points, with any territories priced by hand. Existing subscribers keep their price unless --no-preserve-current-price; then Apple tells them, and asks for consent to an increase where required. Without --yes, prints the current, scheduled and new prices.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option(...PRICE_OPTIONS.base)
    .option(...PRICE_OPTIONS.price)
    .option(...PRICE_OPTIONS.override, collectList)
    .option("--start-date <date>", "when the new price starts (default: now)")
    .option(
      "--no-preserve-current-price",
      "move existing subscribers to the new price too",
    )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        priceSubscriptionInput,
        { subscriptionId, ...options },
        priceSubscription,
      );
    });

  subscriptions
    .command("availability")
    .description(
      "Set the territories a subscription is sold in, replacing the current list. Without --yes, prints the territories added and removed.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option(
      "--territory <codes>",
      "alpha-3 territory codes, comma-separated or repeated",
      collectList,
    )
    .option("--all", "every App Store territory")
    .option(
      "--available-in-new-territories",
      "join territories Apple adds later",
    )
    .option("--no-available-in-new-territories", "do not join them")
    .addOption(
      new Option("--plan-type <type>", "the payment plan")
        .choices([...PLAN_TYPES])
        .default("UPFRONT"),
    )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        subscriptionAvailabilityInput,
        { subscriptionId, ...options, territories: options.territory ?? [] },
        setSubscriptionAvailability,
      );
    });

  subscriptions
    .command("review-screenshot")
    .description("The screenshot App Review sees for a subscription.")
    .command("upload")
    .description(
      "Upload the review screenshot, replacing the old one. Without --yes, prints the file and the screenshot it replaces.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option("--file <path>", "the PNG or JPEG image (required)")
    .option(...YES)
    .action(async (id: string, options, command: Command) => {
      await runWrite(
        command,
        reviewScreenshotInput,
        { id, ...options },
        uploadSubscriptionReviewScreenshot,
      );
    });

  subscriptions
    .command("submit")
    .description(
      "Submit a subscription for review. A group's first subscription is reviewed with the next app version submitted. Without --yes, prints the subscription and its state.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        submitSubscriptionInput,
        { subscriptionId, ...options },
        submitSubscription,
      );
    });

  const offers = subscriptions
    .command("offers")
    .description(
      "A subscription's offers: introductory offers, promotional offers, offer codes with their one-time code batches and custom codes (never the one-time codes) and win-back offers.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .action(async (subscriptionId: string, _options, command: Command) => {
      await run(command, offersInput, { subscriptionId }, listOffers);
    });

  /** The terms every offer create command takes. */
  function offerTermOptions(target: Command): Command {
    return target
      .addOption(
        new Option("--mode <mode>", "the offer type (required)").choices([
          ...OFFER_MODES,
        ]),
      )
      .addOption(
        new Option(
          "--duration <duration>",
          "each period's length (required)",
        ).choices([...OFFER_DURATIONS]),
      )
      .option("--periods <count>", "how many periods (default: 1)")
      .option(
        "--base-territory <code>",
        "the territory --price is in, such as USA (paid offers)",
      )
      .option(
        "--price <amount>",
        "the offer price there, equalized to the subscription's other territories (paid offers)",
      )
      .option(...PRICE_OPTIONS.override, collectList);
  }

  const intro = offers
    .command("intro")
    .description("Introductory offers, one per territory.");

  offerTermOptions(
    intro
      .command("create")
      .description(
        "Create an introductory offer in every territory the subscription is priced in, or those given. Without --yes, prints the offer and its price in each territory.",
      )
      .argument(
        "<subscription-id>",
        "subscription id from the subscriptions command",
      ),
  )
    .option(
      "--territory <codes>",
      "only these territories, comma-separated or repeated",
      collectList,
    )
    .option("--start-date <date>", "when the offer starts (default: now)")
    .option("--end-date <date>", "when it ends (default: never)")
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        createIntroOfferInput,
        { subscriptionId, ...options, territories: options.territory },
        createIntroOffer,
      );
    });

  intro
    .command("end")
    .description(
      "End a subscription's introductory offers, in every territory or those given: on --end-date, or at once by deleting them. Without --yes, prints the offers.",
    )
    .argument(
      "<subscription-id>",
      "subscription id from the subscriptions command",
    )
    .option(
      "--territory <codes>",
      "only these territories, comma-separated or repeated",
      collectList,
    )
    .option("--end-date <date>", "when they end (default: delete them now)")
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        endIntroOfferInput,
        { subscriptionId, ...options, territories: options.territory },
        endIntroOffers,
      );
    });

  const promo = offers
    .command("promo")
    .description(
      "Promotional offers, which the app presents with a signature.",
    );

  offerTermOptions(
    promo
      .command("create")
      .description(
        "Create a promotional offer priced in every territory the subscription is priced in. Without --yes, prints the offer and its prices.",
      )
      .argument(
        "<subscription-id>",
        "subscription id from the subscriptions command",
      )
      .option("--name <name>", "the reference name (required)")
      .option("--code <id>", "the offer identifier the app uses (required)"),
  )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        createPromoOfferInput,
        { subscriptionId, ...options },
        createPromoOffer,
      );
    });

  promo
    .command("set")
    .description(
      "Replace a paid promotional offer's prices. Without --yes, prints the offer and its new prices.",
    )
    .argument("<offer-id>", "offer id from subscriptions offers")
    .option(...PRICE_OPTIONS.base)
    .option(...PRICE_OPTIONS.price)
    .option(...PRICE_OPTIONS.override, collectList)
    .option(...YES)
    .action(async (offerId: string, options, command: Command) => {
      await runWrite(
        command,
        setPromoOfferInput,
        { offerId, ...options },
        setPromoOffer,
      );
    });

  promo
    .command("delete")
    .description("Delete a promotional offer. Without --yes, prints it.")
    .argument("<offer-id>", "offer id from subscriptions offers")
    .option(...YES)
    .action(async (offerId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteOfferInput,
        { offerId, ...options },
        deletePromoOffer,
      );
    });

  const offerCodes = offers
    .command("offer-codes")
    .description("Offer codes, with one-time and custom codes.");

  offerTermOptions(
    offerCodes
      .command("create")
      .description(
        "Create an offer code priced in every territory the subscription is priced in; then generate one-time codes or add custom codes. Without --yes, prints the offer and its prices.",
      )
      .argument(
        "<subscription-id>",
        "subscription id from the subscriptions command",
      )
      .option("--name <name>", "the reference name (required)")
      .option(
        "--eligibility <customers>",
        `who may redeem it, comma-separated: ${CUSTOMER_ELIGIBILITIES.join(", ")} (required)`,
        collectList,
      )
      .addOption(
        new Option(
          "--offer-eligibility <rule>",
          "how it combines with introductory offers",
        )
          .choices([...OFFER_ELIGIBILITIES])
          .default("STACK_WITH_INTRO_OFFERS"),
      )
      .option("--auto-renew", "renew at the regular price afterwards")
      .option("--no-auto-renew", "end the subscription afterwards"),
  )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        createOfferCodeInput,
        {
          subscriptionId,
          ...options,
          eligibility: options.eligibility ?? [],
        },
        createOfferCode,
      );
    });

  offerCodes
    .command("generate")
    .description(
      "Generate a batch of one-time codes and write them to a new file (mode 600); the codes are never printed. Without --yes, prints the batch it would ask for.",
    )
    .argument("<offer-code-id>", "offer code id from subscriptions offers")
    .option("--count <number>", "how many codes (required)")
    .option("--expires <date>", "when the codes expire (required)")
    .addOption(
      new Option("--environment <environment>", "where the codes work")
        .choices(["PRODUCTION", "SANDBOX"])
        .default("PRODUCTION"),
    )
    .option("--out <file>", "a new file for the codes (required)")
    .option(...YES)
    .action(async (offerCodeId: string, options, command: Command) => {
      await runWrite(
        command,
        generateCodesInput,
        { offerCodeId, ...options },
        generateCodes,
      );
    });

  offerCodes
    .command("codes")
    .description(
      "Write a batch's one-time codes to a new file (mode 600); the codes are never printed.",
    )
    .argument("<batch-id>", "one-time code batch id from subscriptions offers")
    .option("--out <file>", "a new file for the codes (required)")
    .action(async (batchId: string, options, command: Command) => {
      await run(
        command,
        saveCodesInput,
        { batchId, ...options },
        saveCodeBatch,
      );
    });

  offerCodes
    .command("custom")
    .description(
      "Add a custom code, such as SUMMER, that customers can redeem up to --count times. Without --yes, prints it.",
    )
    .argument("<offer-code-id>", "offer code id from subscriptions offers")
    .option("--code <code>", "the code customers type (required)")
    .option("--count <number>", "how many redemptions (required)")
    .option("--expires <date>", "when it expires")
    .option(...YES)
    .action(async (offerCodeId: string, options, command: Command) => {
      await runWrite(
        command,
        customCodeInput,
        { offerCodeId, ...options },
        createCustomCode,
      );
    });

  offerCodes
    .command("deactivate")
    .description(
      "End an offer code: none of its codes can be redeemed any more, and it cannot be turned back on. Without --yes, prints it.",
    )
    .argument("<offer-code-id>", "offer code id from subscriptions offers")
    .option(...YES)
    .action(async (offerCodeId: string, options, command: Command) => {
      await runWrite(
        command,
        deactivateCodeInput,
        { offerCodeId, ...options },
        deactivateOfferCode,
      );
    });

  const winBack = offers
    .command("win-back")
    .description("Win-back offers for lapsed subscribers.");

  /** Who a win-back offer reaches and when. */
  function winBackOptions(target: Command): Command {
    return target
      .option(
        "--paid-months <months>",
        "months the customer paid for before lapsing",
      )
      .option("--since-min <months>", "lapsed at least this many months ago")
      .option("--since-max <months>", "lapsed at most this many months ago")
      .option("--wait-months <months>", "months between offers to one customer")
      .option("--start-date <date>", "when the offer starts")
      .option("--end-date <date>", "when it ends")
      .addOption(
        new Option(
          "--priority <priority>",
          "against other win-back offers",
        ).choices(["HIGH", "NORMAL"]),
      )
      .addOption(
        new Option(
          "--promotion-intent <intent>",
          "whether the App Store promotes it",
        ).choices(["NOT_PROMOTED", "USE_AUTO_GENERATED_ASSETS"]),
      );
  }

  winBackOptions(
    offerTermOptions(
      winBack
        .command("create")
        .description(
          "Create a win-back offer priced in every territory the subscription is priced in; needs --paid-months, --since-min and --start-date. Without --yes, prints the offer and its prices.",
        )
        .argument(
          "<subscription-id>",
          "subscription id from the subscriptions command",
        )
        .option("--reference-name <name>", "the reference name (required)")
        .option("--offer-id <id>", "the offer identifier (required)"),
    ),
  )
    .option(...YES)
    .action(async (subscriptionId: string, options, command: Command) => {
      await runWrite(
        command,
        createWinBackInput,
        { subscriptionId, ...options },
        createWinBack,
      );
    });

  winBackOptions(
    winBack
      .command("set")
      .description(
        "Change a win-back offer's eligibility, dates, priority or promotion. Without --yes, prints the current and new values.",
      )
      .argument("<offer-id>", "offer id from subscriptions offers"),
  )
    .option(...YES)
    .action(async (offerId: string, options, command: Command) => {
      await runWrite(
        command,
        setWinBackInput,
        { offerId, ...options },
        setWinBack,
      );
    });

  winBack
    .command("delete")
    .description("Delete a win-back offer. Without --yes, prints it.")
    .argument("<offer-id>", "offer id from subscriptions offers")
    .option(...YES)
    .action(async (offerId: string, options, command: Command) => {
      await runWrite(
        command,
        deleteOfferInput,
        { offerId, ...options },
        deleteWinBack,
      );
    });

  const promoted = program
    .command("promoted-purchases")
    .description(
      "An app's promoted in-app purchases and subscriptions, in the order its product page shows them, each with whether it is enabled, visible to everyone and its review state.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, promotedInput, { appId }, listPromoted);
    });

  promoted
    .command("set")
    .description(
      "Promote products in the order given, ahead of those already promoted (--only removes the others). New ones are enabled and visible to everyone unless told otherwise. Without --yes, prints the current list and the changes.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--product <ids>",
      "in-app purchase or subscription ids in order, comma-separated or repeated (required)",
      collectList,
    )
    .option("--enabled", "show them on the product page")
    .option("--no-enabled", "hide them")
    .option("--visible-for-all-users", "show them to everyone")
    .option(
      "--no-visible-for-all-users",
      "show them only to people who have the app",
    )
    .option("--only", "remove promoted products not listed")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setPromotedInput,
        { appId, ...options, products: options.product ?? [] },
        setPromoted,
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
      "Expire a build so testers can no longer install it from TestFlight, or with --older-than or --keep, many of an app's builds at once. This cannot be undone. Without --yes, prints every build it would expire. Needs a key with the App Manager role.",
    )
    .argument(
      "<id>",
      "build id from the builds command, or the numeric app ID with --older-than or --keep",
    )
    .option(
      "--older-than <build-id>",
      "expire every unexpired build of the app uploaded before this one, on the same platform",
    )
    .option(
      "--keep <n>",
      "expire every unexpired build of the app except the n most recently uploaded",
    )
    .addOption(
      new Option(
        "--platform <platform>",
        "with --older-than or --keep, only builds for this platform",
      ).choices([...PLATFORMS]),
    )
    .option(...YES)
    .action(async (id: string, options, command: Command) => {
      if (options.olderThan !== undefined || options.keep !== undefined) {
        await runWrite(
          command,
          expireBuildsInput,
          { appId: id, ...options },
          expireBuilds,
        );
        return;
      }
      await runWrite(
        command,
        expireInput,
        { buildId: id, yes: options.yes },
        expireBuild,
      );
    });

  builds
    .command("latest")
    .description(
      "The highest build number among an app's 200 most recent uploads, with its id, version, platform and state; for a build script choosing the next number. Expired and failed builds count, since Apple does not take a build number twice.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--app-version <version>",
      "only builds of this version, such as 2.5.0",
    )
    .addOption(
      new Option(
        "--platform <platform>",
        "only builds for this platform",
      ).choices([...PLATFORMS]),
    )
    .option(
      "--next",
      "also print the next build number (the last part plus one)",
    )
    .action(async (appId: string, options, command: Command) => {
      await run(command, latestInput, { appId, ...options }, latestBuild);
    });

  builds
    .command("dsyms")
    .description(
      "Download a build's dSYMs, one file per app, app clip or watch app bundle, into a directory, for symbolicating crash reports. Prints what it wrote. Existing files are not replaced without --overwrite.",
    )
    .argument("[build-id]", "build id from the builds command")
    .option("--out <dir>", "directory to write the dSYMs to (required)")
    .option("--app <app-id>", "pick the build by app instead of its id")
    .option("--build-number <number>", "with --app, the build number")
    .option("--app-version <version>", "with --app, the build's version")
    .addOption(
      new Option(
        "--platform <platform>",
        "with --app, the build's platform",
      ).choices([...PLATFORMS]),
    )
    .option("--overwrite", "replace files that already exist")
    .action(async (buildId: string | undefined, options, command: Command) => {
      await run(
        command,
        dsymsInput,
        {
          buildId,
          appId: options.app,
          // `builds` also defines --build-number, so Commander hands it to the parent.
          buildNumber: command.parent?.opts().buildNumber,
          ...options,
        },
        downloadDsyms,
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

  groups
    .command("create")
    .description(
      "Create a TestFlight group for an app. Internal groups take App Store Connect users; external groups need beta review and can have a public link. Without --yes, prints the group it would create.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--name <name>", "the group's name (required)")
    .option("--internal", "an internal group")
    .option("--external", "an external group")
    .option(
      "--all-builds",
      "internal groups: get every new build automatically",
    )
    .option("--public-link", "external groups: turn on the public link")
    .option(
      "--public-link-limit <n>",
      "with --public-link, cap testers at n (up to 10000)",
    )
    .option("--no-feedback", "turn off tester feedback")
    .option(...YES)
    .action(async (appId: string, _options, command: Command) => {
      // `groups` also defines --internal, so read options with the parent's.
      const options = command.optsWithGlobals();
      if (options.internal && options.external) {
        return command.error(
          "[invalid_input] Give --internal or --external, not both.",
        );
      }
      await runWrite(
        command,
        createGroupInput,
        {
          appId,
          name: options.name,
          internal: options.external ? false : options.internal,
          allBuilds: options.allBuilds,
          publicLink: options.publicLink,
          publicLinkLimit: options.publicLinkLimit,
          feedback: options.feedback === false ? false : undefined,
          yes: options.yes,
        },
        createGroup,
      );
    });

  groups
    .command("set")
    .description(
      "Rename a group or change its public link, public link limit or feedback setting. Only external groups have a public link. Without --yes, prints the current settings and what would change.",
    )
    .argument("<group-id>", "group id from testflight groups")
    .option("--name <name>", "new name")
    .option("--public-link", "turn the public link on")
    .option("--no-public-link", "turn the public link off")
    .option(
      "--public-link-limit <n>",
      "cap public link testers at n (up to 10000)",
    )
    .option("--no-public-link-limit", "remove the public link's tester limit")
    .option("--feedback", "turn tester feedback on")
    .option("--no-feedback", "turn tester feedback off")
    .option(...YES)
    .action(async (group: string, options, command: Command) => {
      await runWrite(command, setGroupInput, { group, ...options }, setGroup);
    });

  groups
    .command("delete")
    .description(
      "Delete a TestFlight group; its testers lose access to the builds they got through it. This cannot be undone. Without --yes, prints the group.",
    )
    .argument("<group-id>", "group id from testflight groups")
    .option(...YES)
    .action(async (group: string, options, command: Command) => {
      await runWrite(
        command,
        deleteGroupInput,
        { group, yes: options.yes },
        deleteGroup,
      );
    });

  const testers = testflight
    .command("testers")
    .description(
      "An app's TestFlight testers by last name: name, email, how they were invited (EMAIL or PUBLIC_LINK) and their state, such as INVITED, ACCEPTED or INSTALLED.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--group <group-id>",
      "only testers in this group (id from testflight groups)",
      // Collected so `testers import` can take several: Commander gives the parent its subcommands' --group.
      collectList,
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
        { appId, ...options, group: oneGroup(command, options.group) },
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

  testers
    .command("import")
    .description(
      "Add the testers in a CSV file to one or more of an app's groups. The header names an email column and optionally firstName and lastName. Someone already testing the app joins the groups; anyone else is invited. Each row's result names its row number, not the email. Without --yes, prints what would happen to each row.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--file <path>", "the CSV file (required)")
    .option(
      "--group <group-ids>",
      "groups to add them to, comma-separated or repeated (required)",
      collectList,
    )
    .option(...YES)
    .action(async (appId: string, _options, command: Command) => {
      // `testers` also defines --group, so read options with the parent's.
      const options = command.optsWithGlobals();
      let failed = 0;
      await runWrite(
        command,
        importTestersInput,
        {
          appId,
          file: options.file,
          groups: options.group ?? [],
          yes: options.yes,
        },
        async (client, input) => {
          const result = await importTesters(client, input);
          failed = "failed" in result ? (result.failed ?? 0) : 0;
          return result;
        },
      );
      if (failed > 0) {
        command.error(
          `${failed} row(s) failed; see their error in the result.`,
        );
      }
    });

  testers
    .command("export")
    .description(
      "Write an app's testers, or one group's, to a new CSV or JSON file: id, email, name, invite type and state. Names and emails go only to that file (readable only by you), never to stdout.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option(
      "--out <path>",
      "the new file to write (required); .json writes JSON",
    )
    .option(
      "--group <group-id>",
      "only testers in this group (id from testflight groups)",
    )
    .addOption(
      new Option(
        "--format <format>",
        "csv or json (default: by --out's extension)",
      ).choices(["csv", "json"]),
    )
    .action(async (appId: string, _options, command: Command) => {
      // `testers` also defines --group, so read options with the parent's.
      const options = command.optsWithGlobals();
      await run(
        command,
        exportTestersInput,
        {
          appId,
          out: options.out,
          group: oneGroup(command, options.group),
          format: options.format,
        },
        exportTesters,
      );
    });

  const betaInfo = testflight
    .command("info")
    .description(
      "An app's TestFlight test information: the beta description, feedback email, marketing and privacy URLs per language, and the beta app review details (contact, demo account and notes). The demo account password is never printed, only whether it is set.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .action(async (appId: string, _options, command: Command) => {
      await run(command, betaInfoInput, { appId }, getBetaInfo);
    });

  betaInfo
    .command("set")
    .description(
      "Set an app's beta app information for one language, creating the language if the app has none for it. Without --yes, prints the current values and what would change.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--locale <locale>", "the language, such as en-US (required)")
    .option("--description <text>", "what testers should know about the app")
    .option("--feedback-email <email>", "where testers' feedback emails go")
    .option("--marketing-url <url>", "the app's marketing URL")
    .option("--privacy-url <url>", "the app's privacy policy URL")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setBetaInfoInput,
        {
          appId,
          locale: options.locale,
          description: options.description,
          feedbackEmail: options.feedbackEmail,
          marketingUrl: options.marketingUrl,
          privacyPolicyUrl: options.privacyUrl,
          yes: options.yes,
        },
        setBetaInfo,
      );
    });

  const betaReviewDetails = testflight
    .command("review-details")
    .description(
      "An app's beta app review details, which a build needs before testflight review submit. Show them with testflight info.",
    );

  betaReviewDetails
    .command("set")
    .description(
      "Set an app's beta app review details: the contact Apple's reviewers reach, the demo account they sign in with, and notes. The demo account password is sent to Apple but never printed. Without --yes, prints the current details and what would change.",
    )
    .argument("<app-id>", "numeric app ID from the apps command")
    .option("--contact-first-name <name>", "contact's first name")
    .option("--contact-last-name <name>", "contact's last name")
    .option("--contact-phone <phone>", "contact's phone number")
    .option("--contact-email <email>", "contact's email")
    .option(
      "--demo-account-required",
      "reviewers need a demo account to sign in",
    )
    .option("--no-demo-account-required", "reviewers need no demo account")
    .option("--demo-account-name <name>", "the demo account's user name")
    .option(
      "--demo-account-password <password>",
      "the demo account's password (default: ASC_DEMO_ACCOUNT_PASSWORD); never printed",
    )
    .option("--notes <text>", "notes for the reviewer")
    .option(...YES)
    .action(async (appId: string, options, command: Command) => {
      await runWrite(
        command,
        setBetaReviewDetailsInput,
        {
          appId,
          ...options,
          demoAccountPassword:
            options.demoAccountPassword ??
            (process.env.ASC_DEMO_ACCOUNT_PASSWORD || undefined),
        },
        setBetaReviewDetails,
      );
    });

  testflight
    .command("notify")
    .description(
      'Send a build\'s "new build available" notification to the testers who can test it, for an app that does not notify them automatically. Without --yes, prints the build.',
    )
    .argument("<build-id>", "build id from the builds command")
    .option(...YES)
    .action(async (buildId: string, options, command: Command) => {
      await runWrite(
        command,
        notifyInput,
        { buildId, yes: options.yes },
        notifyTesters,
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
  function requireTeamKey(command: Command, needs: string): boolean {
    const issuerId =
      program.opts<CredentialOptions>().issuerId ?? process.env.ASC_ISSUER_ID;
    if (issuerId) return true;
    command.error(
      `[permission] ${needs} a team API key, which has an issuer ID: pass --issuer-id or set ASC_ISSUER_ID. Individual keys cannot use them; an Admin creates a team key in App Store Connect → Users and Access → Integrations → Team Keys.`,
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
      if (!requireTeamKey(command, "Sales reports need")) return;
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
      if (!requireTeamKey(command, "Finance reports need")) return;
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

  const bundleIds = program
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

  bundleIds
    .command("create")
    .description(
      `Register a bundle ID. Without --yes, checks that the identifier is free. ${TEAM_KEY}`,
    )
    .option(
      "--identifier <bundle-id>",
      "reverse-DNS identifier such as com.example.app (required)",
    )
    .option(
      "--name <name>",
      "a description shown on the Developer website (required)",
    )
    .addOption(
      new Option("--platform <platform>", "platform (required)").choices([
        ...BUNDLE_ID_PLATFORMS,
      ]),
    )
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `bundle-ids` also has --identifier and --platform.
      await runWrite(
        command,
        createBundleIdInput,
        command.optsWithGlobals(),
        createBundleId,
      );
    });

  bundleIds
    .command("capabilities")
    .description(
      `A bundle ID's enabled capabilities and their settings. ${TEAM_KEY}`,
    )
    .argument(
      "<bundle-id-id>",
      "bundle ID resource id from the bundle-ids command",
    )
    .action(async (bundleIdId: string, _options, command: Command) => {
      await run(
        command,
        bundleIdCapabilitiesInput,
        { bundleIdId },
        listBundleIdCapabilities,
      );
    });

  const CAPABILITY = new Option(
    "--capability <type>",
    "capability type (required)",
  ).choices([...CAPABILITY_TYPES]);

  bundleIds
    .command("enable")
    .description(
      `Turn on a capability for a bundle ID, with --setting KEY=OPTION where it has settings. Existing profiles do not pick it up until renewed. Without --yes, prints the current capabilities. ${TEAM_KEY}`,
    )
    .argument(
      "<bundle-id-id>",
      "bundle ID resource id from the bundle-ids command",
    )
    .addOption(CAPABILITY)
    .option(
      "--setting <key=option>",
      "a setting such as ICLOUD_VERSION=XCODE_6 or APPLE_ID_AUTH_APP_CONSENT=PRIMARY_APP_CONSENT; repeatable",
      collectList,
    )
    .option(...YES)
    .action(async (bundleIdId: string, options, command: Command) => {
      await runWrite(
        command,
        enableCapabilityInput,
        { bundleIdId, ...options },
        enableCapability,
      );
    });

  bundleIds
    .command("disable")
    .description(
      `Turn off a capability for a bundle ID. Without --yes, prints the capability. ${TEAM_KEY}`,
    )
    .argument(
      "<bundle-id-id>",
      "bundle ID resource id from the bundle-ids command",
    )
    .addOption(CAPABILITY)
    .option(...YES)
    .action(async (bundleIdId: string, options, command: Command) => {
      await runWrite(
        command,
        disableCapabilityInput,
        { bundleIdId, ...options },
        disableCapability,
      );
    });

  const devices = program
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

  devices
    .command("register")
    .description(
      `Register a device (--name and --udid) or every device in --file, skipping UDIDs already registered. Each counts against the yearly device limit and cannot be removed until the membership year renews. Without --yes, prints what it would register. ${TEAM_KEY}`,
    )
    .option("--name <name>", "the device's name")
    .option("--udid <udid>", "the device's UDID")
    .addOption(
      new Option(
        "--platform <platform>",
        "platform, and the default for --file lines without one (default: IOS)",
      ).choices([...BUNDLE_ID_PLATFORMS]),
    )
    .option(
      "--file <path>",
      "a file with one UDID,name[,platform] per line (comma or tab separated, platform ios or mac)",
    )
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `devices` also has --name and --platform.
      await runWrite(
        command,
        registerDevicesInput,
        command.optsWithGlobals(),
        registerDevices,
      );
    });

  const STORE = [
    [
      "--git-url <url>",
      "the private git repository that holds the encrypted signing store (required)",
    ],
    ["--branch <branch>", "the store's branch (default: the repository's)"],
  ] as const;

  const signing = program
    .command("signing")
    .description(
      "Share one team's certificates, private keys and profiles through an encrypted store in a private git repository.",
    );

  signing
    .command("sync")
    .description(
      `Make the store hold a usable certificate of --type and, for each --bundle-id, a --profile-type profile signed by it, creating or renewing what is missing, invalid or expiring, then write the decrypted files to --out-dir (readable only by you). The passphrase comes from ASC_SIGNING_PASSPHRASE or --passphrase-env. --readonly never creates anything and needs no --yes. Without --yes, prints the plan. ${TEAM_KEY}`,
    )
    .option(...STORE[0])
    .option(...STORE[1])
    .addOption(
      new Option("--type <type>", "certificate type (required)").choices([
        ...CERTIFICATE_TYPES,
      ]),
    )
    .addOption(
      new Option("--profile-type <type>", "profile type").choices([
        ...PROFILE_TYPES,
      ]),
    )
    .option(
      "--bundle-id <identifiers>",
      "bundle identifiers such as com.example.app to keep profiles for; repeat or comma-separate",
      collectList,
    )
    .option(
      "--out-dir <path>",
      "directory for the decrypted certificate, private key and profiles",
    )
    .option(
      "--readonly",
      "never create or renew; fail if the store is not usable",
    )
    .option(
      "--renew-within-days <days>",
      "renew a certificate or profile expiring within this many days",
      "30",
    )
    .option(
      "--passphrase-env <name>",
      "environment variable holding the store passphrase",
      "ASC_SIGNING_PASSPHRASE",
    )
    .option(...COMMON_NAME)
    .option(...YES)
    .action(async (options, command: Command) => {
      await runWrite(command, syncSigningInput, options, syncSigning);
    });

  signing
    .command("nuke")
    .description(
      `Revoke every certificate of --type on the team, delete every profile of each --profile-type, and remove them from the store. This cannot be undone; without --yes, lists what it would remove. ${TEAM_KEY}`,
    )
    .option(...STORE[0])
    .option(...STORE[1])
    .addOption(
      new Option("--type <type>", "certificate type (required)").choices([
        ...CERTIFICATE_TYPES,
      ]),
    )
    .option(
      "--profile-type <types>",
      "profile types to delete too; repeat or comma-separate",
      collectList,
    )
    .option(...YES)
    .action(async (options, command: Command) => {
      await runWrite(command, nukeSigningInput, options, nukeSigning);
    });

  const KEYCHAIN = [
    "--keychain <path>",
    "the keychain file, such as ~/Library/Keychains/ci.keychain-db (required)",
  ] as const;

  signing
    .command("install")
    .description(
      "macOS only: import a certificate and its private key (from certificates create or signing sync) into a keychain, created with --create-keychain for CI, unlock it, let codesign use the key without a prompt and add it to the search list; copy profiles to Xcode's profiles directory. The keychain password comes from ASC_KEYCHAIN_PASSWORD or --password-env. Without --yes, checks the files. Needs no App Store Connect key.",
    )
    .option(...KEYCHAIN)
    .option("--create-keychain", "create the keychain; it must not exist")
    .option(
      "--password-env <name>",
      "environment variable holding the keychain password",
      "ASC_KEYCHAIN_PASSWORD",
    )
    .option("--cert <path>", "the certificate (.cer)")
    .option("--key <path>", "its private key (PEM)")
    .option(
      "--profile <paths>",
      "provisioning profiles to install; repeat or comma-separate",
      collectList,
    )
    .option(
      "--profiles-dir <path>",
      "where to install profiles (default: ~/Library/Developer/Xcode/UserData/Provisioning Profiles)",
    )
    .option(...YES)
    .action(async (options, command: Command) => {
      await runLocalWrite(
        command,
        installSigningInput,
        options,
        installSigning,
      );
    });

  signing
    .command("uninstall")
    .description(
      "macOS only: remove a keychain made by signing install from the search list and delete it. Never deletes the login keychain. Without --yes, prints the keychain.",
    )
    .option(...KEYCHAIN)
    .option(...YES)
    .action(async (options, command: Command) => {
      await runLocalWrite(
        command,
        uninstallSigningInput,
        options,
        uninstallSigning,
      );
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
      "Xcode Cloud: products, workflows, build runs and, for one run, its actions, issues, failed tests and artifacts; start or rerun a build. Needs a key whose role can access Xcode Cloud.",
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

  const notarize = program
    .command("notarize")
    .description(
      "Notarize Mac software distributed outside the Mac App Store through Apple's Notary API, with the same key. Needs a team key with the Admin or Developer role. Staple the ticket afterwards with xcrun stapler staple.",
    );

  notarize
    .command("submit")
    .description(
      "Upload a .zip, .pkg or .dmg for notarization and print the submission's id and status. Without --yes, checks the file and prints its name, size and SHA-256. With --wait, waits until Apple finishes and exits 1 unless the status is Accepted; progress goes to stderr.",
    )
    .argument("<file>", "the .zip, .pkg or .dmg to notarize")
    .option("--wait", "after uploading, wait until notarization finishes")
    .option("--timeout <minutes>", "with --wait, give up after this long", "30")
    .option(
      "--interval <seconds>",
      "with --wait, time between checks, 10 to 300",
      "30",
    )
    .option(...YES)
    .action(async (file: string, options, command: Command) => {
      if (!requireTeamKey(command, "Notarization needs")) return;
      const writeErr = stderr(command);
      let status: string | undefined;
      await runWrite(
        command,
        notarizeSubmitInput,
        { file, ...options },
        async (client, input) => {
          const result = await submitNotarization(client, input, {
            upload: notaryUpload,
            sleep,
            now,
            progress: (line) => writeErr(`${line}\n`),
          });
          if ("submission" in result && input.wait) {
            status = result.submission.status;
          }
          return result;
        },
      );
      if (status !== undefined && status !== "Accepted") {
        command.error(
          `Notarization finished as ${status}; run notarize log with the submission id for Apple's issues.`,
        );
      }
    });

  notarize
    .command("status")
    .description(
      "One submission's status (In Progress, Accepted, Invalid or Rejected), name and date.",
    )
    .argument("<submission-id>", "id from notarize submit or notarize history")
    .action(async (submissionId: string, _options, command: Command) => {
      if (!requireTeamKey(command, "Notarization needs")) return;
      await run(
        command,
        notarizeSubmissionInput,
        { submissionId },
        getSubmission,
      );
    });

  notarize
    .command("log")
    .description(
      "A finished submission's log from Apple: the outcome and every issue (severity, path, message, architecture). Read it even when notarization succeeds, for warnings.",
    )
    .argument("<submission-id>", "id from notarize submit or notarize history")
    .action(async (submissionId: string, _options, command: Command) => {
      if (!requireTeamKey(command, "Notarization needs")) return;
      await run(
        command,
        notarizeSubmissionInput,
        { submissionId },
        getSubmissionLog,
      );
    });

  notarize
    .command("history")
    .description(
      "The team's 100 most recent notarization submissions: id, name, status and date.",
    )
    .action(async (options, command: Command) => {
      if (!requireTeamKey(command, "Notarization needs")) return;
      await run(command, notarizeHistoryInput, options, listSubmissions);
    });

  program
    .command("api")
    .description(
      "Send a request to the App Store Connect API with your key and print Apple's JSON response: an escape hatch for endpoints and fields no command covers. Only paths on api.appstoreconnect.apple.com are accepted. GET runs directly; POST, PATCH and DELETE change nothing without --yes.",
    )
    .addArgument(
      new Argument("<method>", "HTTP method").choices([...API_METHODS]),
    )
    .argument(
      "<path>",
      "path such as /v1/apps, or a URL on https://api.appstoreconnect.apple.com",
    )
    .option(
      "--query <key=value>",
      "a query parameter, such as filter[platform]=IOS; repeat for more",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option(
      "--body <file>",
      "the JSON body for POST, PATCH or DELETE, from a file, or - for stdin",
    )
    .option("--paginate", "GET only: follow links.next and join every page")
    .option(...YES)
    .action(async (method: string, path: string, options, command: Command) => {
      let body: string | undefined;
      if (options.body !== undefined) {
        try {
          body =
            options.body === "-"
              ? await readStdin()
              : await readFile(options.body, "utf8");
        } catch {
          return command.error(
            `[invalid_input] Could not read the --body ${options.body}.`,
          );
        }
      }
      const input = { method, path, ...options, body };
      if (method === "GET") {
        await run(command, apiInput, input, apiGet);
      } else {
        await runWrite(command, apiInput, input, apiWrite);
      }
    });

  program
    .command("completion")
    .description(
      "Print a shell completion script for commands, subcommands, options and their fixed choices, generated from this CLI so it never goes out of date. Load it from your shell's startup file, as the README shows.",
    )
    .addArgument(new Argument("<shell>", "the shell").choices([...SHELLS]))
    .action((shell: Shell) => {
      console.log(completionScript(program, shell));
    });

  /** Starts a run with `start` or `rerun`, then with --wait polls it and exits 1 unless it succeeded. */
  async function startAndWait<Schema extends z.ZodType>(
    command: Command,
    schema: Schema,
    input: Record<string, unknown>,
    execute: (
      client: AscClient,
      input: z.output<Schema>,
    ) => Promise<{ dryRun: boolean; run?: { id: string } }>,
  ): Promise<void> {
    const writeErr = stderr(command);
    const wait = z
      .object({
        timeout: z.coerce.number().int().min(1).max(720),
        interval: z.coerce.number().int().min(10).max(300),
      })
      .safeParse(input);
    if (!wait.success) {
      command.error(`[invalid_input] ${z.prettifyError(wait.error)}`);
      return;
    }
    let status: string | undefined;
    await runWrite(command, schema, input, async (client, parsed) => {
      const result = await execute(client, parsed);
      if (result.dryRun || !input.wait || !result.run) return result;
      writeErr(`Started run ${result.run.id}; waiting for it to finish.\n`);
      const finished = await waitForRun(client, result.run.id, wait.data, {
        sleep,
        now,
        progress: (line) => writeErr(`${line}\n`),
      });
      status = finished.completionStatus ?? "unknown";
      return { ...result, run: finished };
    });
    if (status && status !== "SUCCEEDED") {
      command.error(`The run finished as ${status}.`);
    }
  }

  /** --wait, --timeout and --interval for xcode-cloud start and rerun. */
  function waitOptions(command: Command): Command {
    return command
      .option(
        "--wait",
        "after starting, wait until the run finishes; exits 1 unless it succeeded",
      )
      .option(
        "--timeout <minutes>",
        "with --wait, give up after this long, 1 to 720",
        "60",
      )
      .option(
        "--interval <seconds>",
        "with --wait, time between checks, 10 to 300",
        "30",
      );
  }

  const start = xcodeCloud
    .command("start")
    .description(
      "Start a workflow on a branch, tag or open pull request of its repository and print the new run. Without --yes, prints the workflow and the reference it would build. Uses Xcode Cloud compute hours.",
    )
    .argument("<workflow-id>", "workflow id from xcode-cloud workflows")
    .option("--branch <name>", "build this branch")
    .option("--tag <name>", "build this tag")
    .option("--pull-request <number>", "build this open pull request")
    .option("--clean", "start a clean build, without cached derived data");
  waitOptions(start)
    .option(...YES)
    .action(async (workflowId: string, options, command: Command) => {
      await startAndWait(
        command,
        startInput,
        { workflowId, ...options },
        startRun,
      );
    });

  const rerun = xcodeCloud
    .command("rerun")
    .description(
      "Rebuild an earlier run (same workflow and commit) and print the new run. Without --yes, prints the run it would rebuild. Uses Xcode Cloud compute hours.",
    )
    .argument("<run-id>", "run id from xcode-cloud runs")
    .option("--clean", "start a clean build, without cached derived data");
  waitOptions(rerun)
    .option(...YES)
    .action(async (runId: string, options, command: Command) => {
      await startAndWait(command, rerunInput, { runId, ...options }, rerunRun);
    });

  const users = program
    .command("users")
    .description(
      "Team members by last name: roles, provisioning access and the apps they can see. Emails are left out unless --emails is given. The users commands need a team key with the Admin role.",
    )
    .option(
      "--role <roles>",
      `only users with these roles, comma-separated or repeated: ${USER_ROLES.join(", ")}`,
      collectList,
    )
    .option(
      "--app <app-ids>",
      "only users who can see one of these apps, comma-separated or repeated",
      collectList,
    )
    .option("--emails", "include each user's email")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(
        command,
        usersInput,
        { ...options, roles: options.role, apps: options.app },
        listUsers,
      );
    });

  users
    .command("invite")
    .description(
      "Invite someone to the team with roles and, with --app, only those apps (without it they see all apps). Without --yes, prints the invitation.",
    )
    .option("--email <email>", "their email address (required)")
    .option("--first-name <name>", "their first name (required)")
    .option("--last-name <name>", "their last name (required)")
    .option(
      "--role <roles>",
      "roles, comma-separated or repeated, such as APP_MANAGER (required)",
      collectList,
    )
    .option(
      "--app <app-ids>",
      "apps they can see, comma-separated or repeated",
      collectList,
    )
    .option(
      "--provisioning",
      "let them manage certificates, identifiers and profiles",
    )
    .option(...YES)
    .action(async (_options, command: Command) => {
      // `users` also defines --role and --app, so Commander may hand them to the parent.
      const options = command.optsWithGlobals();
      await runWrite(
        command,
        inviteInput,
        {
          ...options,
          roles: options.role ?? [],
          apps: options.app ?? [],
        },
        inviteUser,
      );
    });

  users
    .command("set")
    .description(
      "Change a user's roles, visible apps or provisioning access; --role and --app replace the current lists. Without --yes, prints the user and the change.",
    )
    .argument("<user-id>", "user id from the users command")
    .option(
      "--role <roles>",
      "the new roles, comma-separated or repeated",
      collectList,
    )
    .option(
      "--app <app-ids>",
      "the only apps they can see, comma-separated or repeated",
      collectList,
    )
    .option("--all-apps", "let them see all apps")
    .option("--provisioning", "let them manage certificates and profiles")
    .option("--no-provisioning", "stop them managing certificates and profiles")
    .option(...YES)
    .action(async (userId: string, _options, command: Command) => {
      const options = command.optsWithGlobals();
      await runWrite(
        command,
        setUserInput,
        {
          userId,
          ...options,
          roles: options.role,
          apps: options.app ?? [],
        },
        setUser,
      );
    });

  users
    .command("remove")
    .description(
      "Remove a user from the team. This cannot be undone: they would need a new invitation. Without --yes, prints the user.",
    )
    .argument("<user-id>", "user id from the users command")
    .option(...YES)
    .action(async (userId: string, options, command: Command) => {
      await runWrite(
        command,
        removeUserInput,
        { userId, yes: options.yes },
        removeUser,
      );
    });

  const invitations = users
    .command("invitations")
    .description(
      "Pending invitations by last name: roles, visible apps and when each expires. Emails are left out unless --emails is given.",
    )
    .option("--role <roles>", "only invitations with these roles", collectList)
    .option(
      "--app <app-ids>",
      "only invitations that can see one of these apps",
      collectList,
    )
    .option("--emails", "include each invitation's email")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (_options, command: Command) => {
      const options = command.optsWithGlobals();
      await run(
        command,
        invitationsInput,
        {
          ...options,
          roles: options.role,
          apps: options.app,
        },
        listInvitations,
      );
    });

  invitations
    .command("cancel")
    .description(
      "Cancel a pending invitation so its link stops working. Without --yes, prints the invitation.",
    )
    .argument("<invitation-id>", "invitation id from users invitations")
    .option(...YES)
    .action(async (invitationId: string, options, command: Command) => {
      await runWrite(
        command,
        cancelInvitationInput,
        { invitationId, yes: options.yes },
        cancelInvitation,
      );
    });

  const sandbox = program
    .command("sandbox")
    .description(
      "Sandbox Apple Accounts for testing in-app purchases and subscriptions.",
    );

  const sandboxTesters = sandbox
    .command("testers")
    .description(
      "The team's sandbox testers: name, storefront, subscription renewal rate and whether purchases are interrupted. Emails are left out unless --emails is given.",
    )
    .option("--emails", "include each tester's account email")
    .option(...(LIMIT as [string, string, string]))
    .option(...CURSOR)
    .action(async (options, command: Command) => {
      await run(command, sandboxTestersInput, options, listSandboxTesters);
    });

  sandboxTesters
    .command("set")
    .description(
      "Change a sandbox tester's storefront, subscription renewal rate or interrupted purchases. Without --yes, prints the tester and the change.",
    )
    .argument("<tester-id>", "tester id from sandbox testers")
    .option(
      "--territory <code>",
      "the storefront, a three-letter code such as USA",
    )
    .addOption(
      new Option(
        "--renewal-rate <rate>",
        "how often a monthly subscription renews",
      ).choices([...RENEWAL_RATES]),
    )
    .option("--interrupt-purchases", "interrupt purchases, to test that flow")
    .option("--no-interrupt-purchases", "stop interrupting purchases")
    .option(...YES)
    .action(async (testerId: string, options, command: Command) => {
      await runWrite(
        command,
        setSandboxTesterInput,
        { testerId, ...options },
        setSandboxTester,
      );
    });

  sandboxTesters
    .command("clear-history")
    .description(
      "Clear sandbox testers' purchase history so they can buy non-consumables and introductory offers again. This cannot be undone. Without --yes, prints the testers.",
    )
    .argument("<tester-ids...>", "tester ids from sandbox testers")
    .option(...YES)
    .action(async (testerIds: string[], options, command: Command) => {
      await runWrite(
        command,
        clearHistoryInput,
        { testerIds, yes: options.yes },
        clearSandboxHistory,
      );
    });

  return program;
}

/** Everything on stdin, for --body -. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
