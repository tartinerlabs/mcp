import * as z from "zod";
import type { AscClient } from "../asc/client.ts";
import { idSchema } from "../schemas/common.ts";
import { AscApiError } from "../utils/errors.ts";
import {
  EDITABLE_STATES as APP_INFO_EDITABLE_STATES,
  getAppInfo,
} from "./app-info.ts";
import { getAvailability } from "./availability.ts";
import { EDITABLE_STATES, getMetadata } from "./metadata.ts";
import { getPricing } from "./pricing.ts";
import {
  missingAccessibilityAnswers,
  missingAgeRatingAnswers,
  openSubmission,
  readVersion,
} from "./release.ts";
import { missingReviewDetails, readReviewDetail } from "./review-details.ts";
import { getScreenshots } from "./screenshots.ts";
import { listVersions, versionsInput } from "./versions.ts";

/**
 * Reads everything a submission needs and reports what blocks it, without
 * changing anything. Each check reuses the read command it mirrors.
 */

type Status = "pass" | "fail" | "warn" | "not_available";

/** Version states after which What's New is required: an earlier version reached the App Store. */
const RELEASED_STATES = ["READY_FOR_DISTRIBUTION", "REPLACED_WITH_NEW_VERSION"];

/** Fields every version locale needs; What's New is added for an update. */
const REQUIRED_METADATA = ["description", "keywords", "supportUrl"] as const;

const ASSUMPTIONS = [
  "Required version metadata per locale: description, keywords and support URL, plus What's New once an earlier version of the app has been released on the platform.",
  "Required app info per locale: name and privacy policy URL (or privacy policy text on tvOS).",
  "Screenshots: each version locale needs at least one screenshot; on iOS one of them must be in an iPhone device group (a group whose name starts with IPHONE). iPad screenshots are required only when the app runs on iPad, which the API does not say, so a locale without them is a warning.",
  "Accessibility declarations: an unfinished declaration blocks, as versions submit refuses it; an app without declarations passes.",
  "Pricing and availability: the app needs a price schedule with a manual price and at least one territory where it is available.",
];

const NOT_AVAILABLE = {
  status: "not_available" as Status,
  reason: "This check is not built into the CLI yet.",
};

export const checkInput = z.object({ versionId: idSchema("versions") });

/** Runs a read, turning Apple's 404 into undefined, for resources an app may not have yet. */
async function orMissing<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return undefined;
    throw error;
  }
}

/** Reports whether a version is ready to submit for App Review, and what to fix if not. */
export async function checkVersion(
  client: AscClient,
  input: z.output<typeof checkInput>,
) {
  const version = await readVersion(client, input.versionId);
  const blocking: string[] = [];
  const warnings: string[] = [];
  const result = <T extends object>(
    name: string,
    problems: string[],
    details: T,
    warn: string[] = [],
  ) => {
    blocking.push(...problems.map((problem) => `${name}: ${problem}`));
    warnings.push(...warn.map((problem) => `${name}: ${problem}`));
    const status: Status =
      problems.length > 0 ? "fail" : warn.length > 0 ? "warn" : "pass";
    return { status, ...details, problems: [...problems, ...warn] };
  };

  const state = result(
    "state",
    EDITABLE_STATES.has(version.state ?? "")
      ? []
      : [
          `the version is ${version.state}; only a version that is PREPARE_FOR_SUBMISSION or rejected can be submitted.`,
        ],
    { state: version.state },
  );

  const { build } = version;
  const buildProblems: string[] = [];
  if (!build) {
    buildProblems.push("no build is attached; use versions attach-build.");
  } else {
    if (build.processingState !== "VALID" || build.expired) {
      buildProblems.push(
        `build ${build.version} is ${build.expired ? "expired" : build.processingState}; attach a VALID, unexpired build.`,
      );
    }
    if (build.usesNonExemptEncryption == null) {
      buildProblems.push(
        `build ${build.version} has not answered the export compliance question; use builds compliance ${build.id}.`,
      );
    }
  }
  const buildCheck = result("build", buildProblems, { build });

  const submission = await openSubmission(client, version);
  const reviewSubmission = result(
    "reviewSubmission",
    submission
      ? [
          `the version is already in review submission ${submission.id} (${submission.state}).`,
        ]
      : [],
    { submission: submission ?? null },
  );

  const released = await listVersions(
    client,
    versionsInput.parse({
      appId: version.appId,
      platform: version.platform,
      state: RELEASED_STATES.join(","),
      limit: 1,
    }),
  );
  const isUpdate = released.versions.some((entry) => entry.id !== version.id);
  const required = isUpdate
    ? [...REQUIRED_METADATA, "whatsNew" as const]
    : REQUIRED_METADATA;
  const metadata = await getMetadata(client, { versionId: version.id });
  const metadataLocales = metadata.localizations.map((localization) => ({
    locale: localization.locale,
    missing: required.filter((field) => !localization[field]),
  }));
  const metadataCheck = result(
    "metadata",
    [
      ...(metadataLocales.length === 0 ? ["the version has no locales."] : []),
      ...metadataLocales
        .filter((entry) => entry.missing.length > 0)
        .map(
          (entry) =>
            `${entry.locale} has no ${entry.missing.join(", ")}; use metadata set.`,
        ),
    ],
    { locales: metadataLocales },
  );

  const { appInfos } = await getAppInfo(client, { appId: version.appId });
  const appInfo =
    appInfos.find((info) => APP_INFO_EDITABLE_STATES.has(info.state ?? "")) ??
    appInfos[0];
  const appInfoLocales = (appInfo?.localizations ?? []).map((localization) => ({
    locale: localization.locale,
    missing: [
      ...(localization.name ? [] : ["name"]),
      ...(localization.privacyPolicyUrl ||
      (version.platform === "TV_OS" && localization.privacyPolicyText)
        ? []
        : ["privacyPolicyUrl"]),
    ],
  }));
  const appInfoCheck = result(
    "appInfo",
    [
      ...(appInfo ? [] : ["the app has no app info."]),
      ...appInfoLocales
        .filter((entry) => entry.missing.length > 0)
        .map(
          (entry) =>
            `${entry.locale} has no ${entry.missing.join(", ")}; use app-info set ${appInfo?.id}.`,
        ),
    ],
    { appInfoId: appInfo?.id ?? null, locales: appInfoLocales },
  );

  const screenshots = await getScreenshots(client, { versionId: version.id });
  const screenshotProblems: string[] = [];
  const screenshotWarnings: string[] = [];
  const screenshotLocales = screenshots.localizations.map((localization) => {
    const groups = localization.groups.filter(
      (group) => group.placementType === "APP_SCREENSHOT",
    );
    const names = groups.map((group) => group.placementGroup ?? "");
    const failed = localization.groups.flatMap((group) =>
      group.placements
        .filter(
          (placement) =>
            placement.state === "FAILED" || placement.assetState === "FAILED",
        )
        .map((placement) => placement.fileName ?? placement.id),
    );
    if (groups.length === 0) {
      screenshotProblems.push(
        `${localization.locale} has no screenshots; use screenshots upload.`,
      );
    } else if (
      version.platform === "IOS" &&
      !names.some((name) => name.startsWith("IPHONE"))
    ) {
      screenshotProblems.push(
        `${localization.locale} has no iPhone screenshots.`,
      );
    }
    if (
      version.platform === "IOS" &&
      groups.length > 0 &&
      !names.some((name) => name.startsWith("IPAD"))
    ) {
      screenshotWarnings.push(
        `${localization.locale} has no iPad screenshots, which an app that runs on iPad needs.`,
      );
    }
    if (failed.length > 0) {
      screenshotProblems.push(
        `${localization.locale} has files that failed processing: ${failed.join(", ")}.`,
      );
    }
    return {
      locale: localization.locale,
      groups: groups.map((group) => ({
        placementGroup: group.placementGroup,
        count: group.placements.length,
      })),
    };
  });
  const screenshotsCheck = result(
    "screenshots",
    screenshotProblems,
    { locales: screenshotLocales },
    screenshotWarnings,
  );

  const ageRatingAnswers = await missingAgeRatingAnswers(client, version.appId);
  const ageRating = result(
    "ageRating",
    ageRatingAnswers.map(
      (entry) =>
        `unanswered ${entry.questions.join(", ")} (app info ${entry.appInfoId}); use age-rating set.`,
    ),
    { unanswered: ageRatingAnswers },
  );

  const accessibilityAnswers = await missingAccessibilityAnswers(
    client,
    version.appId,
  );
  const accessibility = result(
    "accessibility",
    accessibilityAnswers.map(
      (entry) =>
        `unanswered ${entry.questions.join(", ")} (${entry.deviceFamily ?? entry.declarationId}); answer them in App Store Connect.`,
    ),
    { unanswered: accessibilityAnswers },
  );

  const detail = await readReviewDetail(client, version.id);
  const missingDetails = missingReviewDetails(detail);
  const reviewDetails = result(
    "reviewDetails",
    missingDetails.length > 0
      ? [`${missingDetails.join(", ")} blank; use review-details set.`]
      : [],
    { reviewDetailId: detail?.id ?? null, missing: missingDetails },
  );

  const pricing = await orMissing(() =>
    getPricing(client, { appId: version.appId, territory: undefined }),
  );
  const pricingCheck = result(
    "pricing",
    !pricing || pricing.manualPrices.length === 0
      ? ["the app has no price set; set one in App Store Connect."]
      : [],
    {
      baseTerritory: pricing?.baseTerritory ?? null,
      manualPrices: pricing?.manualPrices ?? [],
    },
  );

  const availability = await orMissing(() =>
    getAvailability(client, { appId: version.appId }),
  );
  const availabilityCheck = result(
    "availability",
    !availability || availability.availableCount === 0
      ? ["the app is not available in any territory; use availability set."]
      : [],
    { availableCount: availability?.availableCount ?? 0 },
  );

  return {
    version: {
      appId: version.appId,
      versionId: version.id,
      version: version.version,
      platform: version.platform,
      state: version.state,
    },
    ready: blocking.length === 0,
    blocking,
    warnings,
    checks: {
      state,
      build: buildCheck,
      reviewSubmission,
      metadata: metadataCheck,
      appInfo: appInfoCheck,
      screenshots: screenshotsCheck,
      ageRating,
      accessibility,
      reviewDetails,
      pricing: pricingCheck,
      availability: availabilityCheck,
      categories: NOT_AVAILABLE,
      contentRights: NOT_AVAILABLE,
      metadataLint: NOT_AVAILABLE,
    },
    assumptions: ASSUMPTIONS,
  };
}
