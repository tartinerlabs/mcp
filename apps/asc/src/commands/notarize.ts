import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import * as z from "zod";
import { type AscClient, NOTARY_API } from "../asc/client.ts";
import type { S3Uploader } from "../asc/s3.ts";
import {
  AscApiError,
  InvalidInputError,
  NotFoundError,
  PermissionError,
  UnexpectedResponseError,
  UploadIncompleteError,
  WaitTimeoutError,
} from "../utils/errors.ts";

/**
 * Notarizes Mac software outside the Mac App Store through Apple's Notary API
 * (`https://appstoreconnect.apple.com/notary/v2`), which takes the same
 * token as the App Store Connect API: a submission names the file and its
 * SHA-256, the file goes to the S3 bucket Apple's response names with the
 * temporary credentials it carries, and Apple then checks it. Stapling the
 * ticket stays a local `xcrun stapler staple` step.
 */

const EXTENSIONS = [".zip", ".pkg", ".dmg"];

/** A submission id is a UUID, which keeps it to one path segment. */
const submissionIdSchema = z
  .string()
  .trim()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "Must be a submission id from notarize submit or notarize history.",
  );

export const notarizeSubmitInput = z.object({
  file: z.string().min(1),
  wait: z.boolean().default(false),
  timeout: z.coerce.number().int().min(1).max(180).default(30),
  interval: z.coerce.number().int().min(10).max(300).default(30),
  yes: z.boolean().default(false),
});

export const notarizeSubmissionInput = z.object({
  submissionId: submissionIdSchema,
});

export const notarizeHistoryInput = z.object({});

interface SubmissionAttributes {
  createdDate?: string;
  name?: string;
  status?: string;
}

interface Submission {
  id: string;
  attributes?: SubmissionAttributes;
}

interface NewSubmissionAttributes {
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  bucket?: string;
  object?: string;
}

/** What `notarize submit --wait` needs; tests pass fakes. */
export interface NotarizeDependencies {
  upload: S3Uploader;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  progress: (line: string) => void;
}

/** Apple's status while it is still checking the file. */
const IN_PROGRESS = "In Progress";

function shapeSubmission(submission: Submission) {
  return {
    id: submission.id,
    name: submission.attributes?.name,
    status: submission.attributes?.status,
    createdDate: submission.attributes?.createdDate,
  };
}

/** Notarization needs a team key whose role may use it; Apple answers 403 otherwise. */
async function notary<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof AscApiError && error.status === 403) {
      throw new PermissionError(
        "Apple's Notary API refused this key. Notarization needs a team API key (one with an issuer ID) with the Admin or Developer role; individual keys cannot notarize.",
      );
    }
    throw error;
  }
}

/** The file, checked before anything is sent. */
async function readSoftware(path: string) {
  const extension = extname(path).toLowerCase();
  if (!EXTENSIONS.includes(extension)) {
    throw new InvalidInputError(
      `${basename(path)} is not a .zip, .pkg or .dmg: Apple's notary service takes only those.`,
    );
  }
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw new NotFoundError(`Could not read the file ${path}.`);
  }
  if (size === 0) throw new InvalidInputError(`${basename(path)} is empty.`);
  return { name: basename(path), size };
}

/** The file's SHA-256, read as a stream so a large file is never held in memory. */
async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** One submission's status. */
export async function getSubmission(
  client: AscClient,
  { submissionId }: z.output<typeof notarizeSubmissionInput>,
) {
  const { data } = await notary(() =>
    client.get<{ data: Submission }>(
      `${NOTARY_API}/submissions/${submissionId}`,
    ),
  );
  return shapeSubmission(data);
}

/** The team's 100 most recent submissions, newest first as Apple returns them. */
export async function listSubmissions(client: AscClient) {
  const { data } = await notary(() =>
    client.get<{ data: Submission[] }>(`${NOTARY_API}/submissions`),
  );
  return { submissions: data.map(shapeSubmission) };
}

/**
 * The submission's log, read from the temporary URL Apple's response gives:
 * the outcome and every issue, with the ticket's contents counted rather
 * than listed.
 */
export async function getSubmissionLog(
  client: AscClient,
  { submissionId }: z.output<typeof notarizeSubmissionInput>,
) {
  const { data } = await notary(() =>
    client.get<{ data: { attributes?: { developerLogUrl?: string } } }>(
      `${NOTARY_API}/submissions/${submissionId}/logs`,
    ),
  );
  const url = data.attributes?.developerLogUrl;
  if (!url) {
    throw new UnexpectedResponseError(
      "Apple's Notary API returned no log URL; the submission may still be in progress.",
    );
  }
  let log: Record<string, unknown>;
  try {
    log = JSON.parse(
      new TextDecoder().decode(await client.downloadSigned(url)),
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new UnexpectedResponseError(
        "Apple's notarization log is not JSON.",
      );
    }
    throw error;
  }
  const { ticketContents, ...rest } = log;
  return {
    ...rest,
    issues: Array.isArray(log.issues) ? log.issues : [],
    ticketContents: Array.isArray(ticketContents) ? ticketContents.length : 0,
  };
}

/** Polls until Apple finishes checking the submission or the timeout passes. */
async function waitForSubmission(
  client: AscClient,
  submissionId: string,
  { timeout, interval }: { timeout: number; interval: number },
  { sleep, now, progress }: NotarizeDependencies,
) {
  const deadline = now() + timeout * 60_000;
  for (;;) {
    const submission = await getSubmission(client, { submissionId });
    if (submission.status !== IN_PROGRESS) return submission;
    if (now() + interval * 1000 > deadline) {
      throw new WaitTimeoutError(
        `Notarization of ${submissionId} was still in progress after ${timeout} minutes; check it later with notarize status ${submissionId}.`,
      );
    }
    progress(`${submissionId}: ${IN_PROGRESS}`);
    await sleep(interval * 1000);
  }
}

/**
 * Submits a file for notarization. Without `yes`, checks the file and shows
 * what would be sent. With `wait`, follows the submission until Apple
 * finishes checking it.
 */
export async function submitNotarization(
  client: AscClient,
  input: z.output<typeof notarizeSubmitInput>,
  dependencies: NotarizeDependencies,
) {
  const software = await readSoftware(input.file);
  const hash = await sha256(input.file);
  const planned = {
    action: "notarize",
    file: { name: software.name, size: software.size, sha256: hash },
  };
  if (!input.yes) return { dryRun: true, ...planned };

  const { data: created } = await notary(() =>
    client.post<{ data: { id: string; attributes?: NewSubmissionAttributes } }>(
      `${NOTARY_API}/submissions`,
      { submissionName: software.name, sha256: hash },
    ),
  );
  const attributes = created.attributes ?? {};
  try {
    const {
      awsAccessKeyId,
      awsSecretAccessKey,
      awsSessionToken,
      bucket,
      object,
    } = attributes;
    if (
      !awsAccessKeyId ||
      !awsSecretAccessKey ||
      !awsSessionToken ||
      !bucket ||
      !object
    ) {
      throw new UnexpectedResponseError(
        "Apple's Notary API created the submission but gave no upload credentials.",
      );
    }
    await dependencies.upload(
      {
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
        sessionToken: awsSessionToken,
        bucket,
        object,
      },
      { path: input.file, size: software.size },
    );
  } catch (error) {
    throw new UploadIncompleteError(
      `The notarization submission ${created.id} was created but its file was not uploaded; run the command again to start a new submission.`,
      { cause: error },
    );
  }

  const submission = input.wait
    ? await waitForSubmission(client, created.id, input, dependencies)
    : await getSubmission(client, { submissionId: created.id });
  return { dryRun: false, ...planned, submission };
}
