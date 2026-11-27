import * as z from "zod";

/**
 * Checks App Store listing text for what App Review commonly rejects:
 * placeholder text, other platforms, broken URLs, an old copyright year,
 * "free" in in-app purchase names, promises of features to come and negative
 * references to Apple. The word lists live here, never fetched at runtime.
 */

export const SEVERITIES = ["error", "warning", "off"] as const;
type Severity = (typeof SEVERITIES)[number];

/** Apple's character limits per field (App Store Connect's field reference). */
const LIMITS: Record<string, number> = {
  name: 30,
  subtitle: 30,
  promotionalText: 170,
  description: 4000,
  whatsNew: 4000,
};
/**
 * The keyword field's limit. App Store Connect saves up to 100 characters,
 * even when that is more than 100 UTF-8 bytes (Japanese, Chinese and Korean
 * keywords take two to three bytes a character), so characters block and a
 * field over 100 bytes is only a warning, in case Apple ever counts bytes.
 */
const MAX_KEYWORDS = 100;

const PLACEHOLDER = [
  /\blorem ipsum\b/i,
  // Upper case only, so a to-do list app is not flagged.
  /\b(TODO|TBD|FIXME)\b/,
  /\bplaceholder\b/i,
  /^\s*(test|testing|asdf|xxx+)\s*$/i,
  /\btest (text|copy|description|app|data)\b/i,
];

const OTHER_PLATFORMS =
  /\b(android|google play|play store|windows phone|blackberry|appgallery|galaxy store|amazon appstore)\b/i;

const FUTURE_FEATURES =
  /\b(coming soon|coming later|in a future (update|version|release)|stay tuned|available soon|will soon (be )?(add|support)\w*)\b/i;

const APPLE = String.raw`\b(apple|app store|iphone|ipad|ios|mac|siri)\b`;
const NEGATIVE = String.raw`\b(sucks?|terrible|awful|horrible|worst|hate|stupid|garbage|crap|useless)\b`;
const APPLE_NEGATIVE = new RegExp(
  `${APPLE}[^.!?\\n]{0,40}${NEGATIVE}|${NEGATIVE}[^.!?\\n]{0,40}${APPLE}`,
  "i",
);

const URL_FIELDS = [
  "supportUrl",
  "marketingUrl",
  "privacyPolicyUrl",
  "privacyChoicesUrl",
] as const;
const TEXT_FIELDS = [
  "name",
  "subtitle",
  "description",
  "keywords",
  "promotionalText",
  "whatsNew",
] as const;

export const RULES = {
  length: "error",
  placeholder: "error",
  "other-platforms": "error",
  "url-reachable": "error",
  "copyright-year": "warning",
  "free-iap": "error",
  "future-features": "warning",
  "apple-negative": "warning",
} as const satisfies Record<string, Severity>;

type Rule = keyof typeof RULES;
const RULE_NAMES = Object.keys(RULES) as Rule[];

const URL_TIMEOUT_MS = 5000;

export interface Finding {
  /** Left out for app-level fields, such as copyright or an in-app purchase. */
  locale?: string;
  field: string;
  rule: Rule;
  severity: Exclude<Severity, "off">;
  message: string;
}

/** What the lint reads: each locale's fields, the copyright and in-app purchase names. */
export interface Listing {
  copyright?: string | null;
  locales: { locale: string; fields: Record<string, unknown> }[];
  inAppPurchases?: { id: string; name?: string }[];
}

export interface LintDependencies {
  fetch: typeof fetch;
  now: () => number;
}

const ruleSetting = z
  .string()
  .regex(
    /^[a-z-]+=(error|warning|off)$/,
    "Write a rule as name=error|warning|off.",
  )
  .refine((value) => RULE_NAMES.includes(value.split("=")[0] as Rule), {
    message: `Rules are ${RULE_NAMES.join(", ")}.`,
  });

export const lintOptions = {
  rules: z.array(ruleSetting).default([]),
  checkUrls: z.boolean().default(true),
};

/** The severity of each rule after the user's name=severity settings. */
function severities(settings: string[]): Record<Rule, Severity> {
  const result: Record<Rule, Severity> = { ...RULES };
  for (const setting of settings) {
    const [name, severity] = setting.split("=") as [Rule, Severity];
    result[name] = severity;
  }
  return result;
}

const asText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

/** Fetches a listing URL, HEAD first and GET when HEAD is refused. */
async function checkUrl(
  fetcher: typeof fetch,
  url: string,
): Promise<{ status?: number; error?: string }> {
  for (const method of ["HEAD", "GET"]) {
    try {
      const response = await fetcher(url, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(URL_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (
        method === "HEAD" &&
        (response.status === 405 || response.status === 403)
      ) {
        continue;
      }
      return { status: response.status };
    } catch (error) {
      return {
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "timed out"
            : "could not connect",
      };
    }
  }
  return {};
}

/** Runs every rule that is not off over the listing. */
export async function lintListing(
  listing: Listing,
  settings: { rules: string[]; checkUrls: boolean },
  { fetch: fetcher, now }: LintDependencies,
) {
  const levels = severities(settings.rules);
  const findings: Finding[] = [];
  const add = (
    rule: Rule,
    field: string,
    message: string,
    locale?: string,
    severity: Exclude<Severity, "off"> | undefined = undefined,
  ) => {
    const level = levels[rule];
    if (level === "off") return;
    // A network failure is reported, never failed on.
    findings.push({
      ...(locale === undefined ? {} : { locale }),
      field,
      rule,
      severity: severity === "warning" ? "warning" : level,
      message,
    });
  };

  const urls = new Map<string, { locale: string; field: string }[]>();
  for (const { locale, fields } of listing.locales) {
    for (const [field, max] of Object.entries(LIMITS)) {
      const value = asText(fields[field]);
      if (value && [...value].length > max) {
        add(
          "length",
          field,
          `${[...value].length} characters, past Apple's limit of ${max}.`,
          locale,
        );
      }
    }
    const keywords = asText(fields.keywords);
    if (keywords) {
      const characters = [...keywords].length;
      const bytes = new TextEncoder().encode(keywords).length;
      if (characters > MAX_KEYWORDS) {
        add(
          "length",
          "keywords",
          `${characters} characters, past Apple's limit of ${MAX_KEYWORDS}.`,
          locale,
        );
      } else if (bytes > MAX_KEYWORDS) {
        add(
          "length",
          "keywords",
          `${characters} characters but ${bytes} bytes; App Store Connect accepts this, though some of Apple's documentation gives the limit as ${MAX_KEYWORDS} bytes.`,
          locale,
          "warning",
        );
      }
    }
    for (const field of TEXT_FIELDS) {
      const value = asText(fields[field]);
      if (!value) continue;
      const placeholder = PLACEHOLDER.map(
        (pattern) => value.match(pattern)?.[0],
      ).find(Boolean);
      if (placeholder) {
        add(
          "placeholder",
          field,
          `Looks like placeholder text: "${placeholder.trim()}".`,
          locale,
        );
      }
      const platform = value.match(OTHER_PLATFORMS)?.[0];
      if (platform) {
        add(
          "other-platforms",
          field,
          `Mentions another platform or store: "${platform}".`,
          locale,
        );
      }
      const future = value.match(FUTURE_FEATURES)?.[0];
      if (future) {
        add(
          "future-features",
          field,
          `Promises something not in the app yet: "${future}".`,
          locale,
        );
      }
      if (APPLE_NEGATIVE.test(value)) {
        add(
          "apple-negative",
          field,
          "Seems to speak badly of Apple or its products.",
          locale,
        );
      }
    }
    for (const field of URL_FIELDS) {
      const value = asText(fields[field]);
      if (!value) continue;
      urls.set(value, [...(urls.get(value) ?? []), { locale, field }]);
    }
  }

  // Only the listing's own URLs are requested, each once.
  if (settings.checkUrls && levels["url-reachable"] !== "off") {
    for (const [url, uses] of urls) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(url);
      } catch {
        parsed = undefined;
      }
      const result =
        parsed && (parsed.protocol === "https:" || parsed.protocol === "http:")
          ? await checkUrl(fetcher, url)
          : { status: 0 };
      for (const { locale, field } of uses) {
        if (result.error) {
          add(
            "url-reachable",
            field,
            `${url} ${result.error}; check it by hand.`,
            locale,
            "warning",
          );
        } else if (result.status === 0) {
          add(
            "url-reachable",
            field,
            `${url} is not an http or https URL.`,
            locale,
          );
        } else if (result.status !== undefined && result.status >= 400) {
          add(
            "url-reachable",
            field,
            `${url} answered with HTTP ${result.status}.`,
            locale,
          );
        }
      }
    }
  }

  const year = new Date(now()).getUTCFullYear();
  if (listing.copyright !== undefined) {
    const copyright = asText(listing.copyright);
    const years = copyright?.match(/\b(19|20)\d{2}\b/g)?.map(Number) ?? [];
    if (!copyright) {
      add("copyright-year", "copyright", "The copyright is empty.");
    } else if (!years.includes(year)) {
      add(
        "copyright-year",
        "copyright",
        `The copyright does not name ${year}: "${copyright}".`,
      );
    }
  }

  for (const { id, name } of listing.inAppPurchases ?? []) {
    if (name && /\bfree\b/i.test(name)) {
      add(
        "free-iap",
        `inAppPurchases.${id}`,
        `In-app purchase "${name}" has "free" in its name.`,
      );
    }
  }

  const errors = findings.filter(({ severity }) => severity === "error").length;
  return { findings, errors, warnings: findings.length - errors };
}
