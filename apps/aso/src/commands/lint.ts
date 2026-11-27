import * as z from "zod";

// Limits and rules from Apple's App Store search and product page guidance
// (developer.apple.com/app-store/search, /app-store/product-page) and the
// App Store Connect field reference. The keyword field is "100 characters"
// on the marketing pages and "100 bytes" in parts of App Store Connect's
// documentation, but App Store Connect saves up to 100 characters even when
// that is more than 100 UTF-8 bytes (Japanese, Chinese and Korean keywords
// take two to three bytes a character). So characters are the error, and a
// field over 100 bytes is a warning in case Apple ever counts bytes.
const MAX_KEYWORDS = 100;
const MAX_NAME = 30;
const MIN_NAME = 2;
const MAX_SUBTITLE = 30;
// App Store Connect: each keyword is "greater than two characters".
const MIN_KEYWORD = 3;
// Chinese, Japanese and Korean words are often two characters (旅行, 地図),
// and App Store Connect saves them, so those terms need two.
const MIN_CJK_KEYWORD = 2;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Apple names "app" as too broad and "the" and "to" as filler; "a", "an",
// "and" and "of" are the same kind of word.
const GENERIC_WORDS = new Set(["app", "apps"]);
const FILLER_WORDS = new Set(["a", "an", "and", "of", "the", "to"]);
const SPECIAL_CHARACTERS = /[#@]/;

export const lintSchema = z.object({
  keywords: z.string(),
  name: z.string().optional(),
  subtitle: z.string().optional(),
  developer: z.string().optional(),
});

export type LintInput = z.infer<typeof lintSchema>;

export interface LintIssue {
  /** An error breaks an App Store Connect limit; a warning wastes keyword space. */
  severity: "error" | "warning";
  rule: string;
  message: string;
  terms?: string[];
}

function normalise(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().trim();
}

function words(text: string): string[] {
  return normalise(text)
    .split(/[\s,]+/)
    .filter((word) => word.length > 0);
}

/** The singular a simple English plural reduces to, or the word itself. */
function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && /(s|x|z|ch|sh)es$/.test(word)) {
    return word.slice(0, -2);
  }
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
    return word.slice(0, -1);
  }
  return word;
}

function lengthIssue(
  field: string,
  value: string | undefined,
  min: number,
  max: number,
): LintIssue[] {
  if (value === undefined) return [];
  const length = [...value].length;
  if (length > max) {
    return [
      {
        severity: "error",
        rule: `${field}-length`,
        message: `The ${field} is ${length} characters; App Store Connect allows ${max}.`,
      },
    ];
  }
  if (length < min) {
    return [
      {
        severity: "error",
        rule: `${field}-length`,
        message: `The ${field} is ${length} characters; App Store Connect needs at least ${min}.`,
      },
    ];
  }
  return [];
}

/**
 * Checks a keyword field, and optionally the name and subtitle, against
 * Apple's limits and the keyword-space rules in Apple's guidance. Competitor,
 * trademark and category names need judgment and are not checked.
 */
export function lintKeywords(input: LintInput) {
  const issues: LintIssue[] = [
    ...lengthIssue("name", input.name, MIN_NAME, MAX_NAME),
    ...lengthIssue("subtitle", input.subtitle, 0, MAX_SUBTITLE),
  ];
  const field = input.keywords;
  const bytes = new TextEncoder().encode(field).length;
  const characters = [...field].length;
  const terms = field.split(",");
  const cleanTerms = terms.map(normalise).filter((term) => term.length > 0);

  if (characters > MAX_KEYWORDS) {
    issues.push({
      severity: "error",
      rule: "keywords-length",
      message: `The keyword field is ${characters} characters; App Store Connect allows ${MAX_KEYWORDS}.`,
    });
  } else if (bytes > MAX_KEYWORDS) {
    issues.push({
      severity: "warning",
      rule: "keywords-length",
      message: `The keyword field is ${characters} characters but ${bytes} bytes; App Store Connect accepts this, though some of Apple's documentation gives the limit as ${MAX_KEYWORDS} bytes.`,
    });
  }
  if (cleanTerms.length < terms.length) {
    issues.push({
      severity: "warning",
      rule: "empty-term",
      message: "Remove the empty terms left by extra commas.",
    });
  }
  if (terms.some((term, index) => index > 0 && /^\s/.test(term))) {
    issues.push({
      severity: "warning",
      rule: "space-after-comma",
      message:
        "Separate terms with commas and no spaces; each space after a comma uses a character.",
    });
  }
  const short = cleanTerms.filter(
    (term) =>
      [...term].length < (CJK.test(term) ? MIN_CJK_KEYWORD : MIN_KEYWORD),
  );
  if (short.length > 0) {
    issues.push({
      severity: "error",
      rule: "short-term",
      message: `App Store Connect needs each keyword to be at least ${MIN_KEYWORD} characters (${MIN_CJK_KEYWORD} in Chinese, Japanese or Korean).`,
      terms: short,
    });
  }

  const listed = new Map<string, string>();
  for (const word of [
    ...words(input.name ?? ""),
    ...words(input.subtitle ?? ""),
    ...words(input.developer ?? ""),
  ]) {
    listed.set(singular(word), word);
  }
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  const plurals: string[] = [];
  const alreadyListed: string[] = [];
  const generic: string[] = [];
  const filler: string[] = [];
  const special: string[] = [];
  for (const word of words(field)) {
    if (SPECIAL_CHARACTERS.test(word)) special.push(word);
    if (GENERIC_WORDS.has(word)) generic.push(word);
    if (FILLER_WORDS.has(word)) filler.push(word);
    const stem = singular(word);
    const earlier = seen.get(stem);
    if (earlier === word) duplicates.push(word);
    else if (earlier !== undefined) plurals.push(`${earlier}/${word}`);
    else seen.set(stem, word);
    if (listed.has(stem)) alreadyListed.push(word);
  }

  const warn = (rule: string, message: string, found: string[]) => {
    if (found.length > 0) {
      issues.push({
        severity: "warning",
        rule,
        message,
        terms: [...new Set(found)],
      });
    }
  };
  warn(
    "duplicate-word",
    "These words appear more than once; Apple indexes each word once.",
    duplicates,
  );
  warn(
    "plural",
    "Apple treats singular and plural forms as duplicates; keep one.",
    plurals,
  );
  warn(
    "already-in-metadata",
    "These words are already in the name, subtitle or developer name, which Apple indexes too.",
    alreadyListed,
  );
  warn(
    "generic-word",
    'Apple calls words like "app" too broad to be worth the space.',
    generic,
  );
  warn("filler-word", "Filler words add no search value.", filler);
  warn(
    "special-character",
    "Special characters such as # and @ carry no search weight unless part of your brand.",
    special,
  );

  return {
    bytes,
    characters,
    remainingCharacters: MAX_KEYWORDS - characters,
    remainingBytes: MAX_KEYWORDS - bytes,
    terms: cleanTerms,
    valid: issues.every((issue) => issue.severity !== "error"),
    issues,
  };
}
