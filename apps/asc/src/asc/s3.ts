import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import {
  InvalidInputError,
  NetworkError,
  UnexpectedResponseError,
} from "../utils/errors.ts";

/**
 * Uploads a notarization file to the Amazon S3 bucket and object Apple's
 * Notary API names, with the temporary credentials it returns. The file is
 * sent as a multipart upload, one part read from disk at a time, signed with
 * AWS Signature Version 4. The App Store Connect token is never sent here.
 */

/** The temporary credentials and destination a new notary submission returns. */
export interface S3Destination {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bucket: string;
  object: string;
}

/** Sends a file to S3; the seam tests replace. */
export type S3Uploader = (
  destination: S3Destination,
  file: { path: string; size: number },
) => Promise<void>;

export interface S3UploaderOptions {
  fetch?: typeof fetch;
  /** @default Date.now */
  now?: () => number;
  /** @default 16 MiB; S3 needs at least 5 MiB for every part but the last. */
  partSize?: number;
}

/** Apple's notary bucket is in us-west-2, and Apple's example uploads through S3 Transfer Acceleration. */
const REGION = "us-west-2";
const PART_SIZE = 16 * 1024 * 1024;
const TIMEOUT_MS = 300_000;
/** S3 accepts an unsigned payload over HTTPS, so a part is not hashed twice. */
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** An accelerated bucket name: lowercase letters, digits and hyphens. */
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** RFC 3986 encoding as SigV4 wants it: only unreserved characters stay as they are. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface SignInput {
  method: string;
  url: URL;
  /** Every header to sign besides `host`, which comes from the URL. */
  headers: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ`, also sent as `x-amz-date`. */
  amzDate: string;
  payloadHash: string;
}

/** The SigV4 `Authorization` header for a request whose headers are all signed. */
export function signV4(input: SignInput): string {
  const headers: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(input.headers)) {
    headers[name.toLowerCase()] = value.trim();
  }
  const names = Object.keys(headers).sort();
  const query = [...input.url.searchParams]
    .map(([name, value]) => [uriEncode(name), uriEncode(value)])
    .sort(([a = ""], [b = ""]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonical = [
    input.method,
    input.url.pathname,
    query,
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    names.join(";"),
    input.payloadHash,
  ].join("\n");
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const toSign = [
    "AWS4-HMAC-SHA256",
    input.amzDate,
    scope,
    sha256Hex(canonical),
  ].join("\n");
  const signingKey = hmac(
    hmac(
      hmac(hmac(`AWS4${input.secretAccessKey}`, date), input.region),
      input.service,
    ),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey)
    .update(toSign)
    .digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

/** The text of one XML element in an S3 response, such as `UploadId` or an error `Code`. */
function xmlValue(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}>([^<]*)</${element}>`).exec(xml)?.[1];
}

/** Creates the uploader the notarize command uses. */
export function createS3Uploader({
  fetch: send = fetch,
  now = Date.now,
  partSize = PART_SIZE,
}: S3UploaderOptions = {}): S3Uploader {
  return async (destination, file) => {
    if (!BUCKET_PATTERN.test(destination.bucket) || !destination.object) {
      throw new UnexpectedResponseError(
        "Apple's Notary API returned an upload destination that is not an S3 bucket and object.",
      );
    }
    const base = new URL(
      `https://${destination.bucket}.s3-accelerate.amazonaws.com/${destination.object.split("/").map(uriEncode).join("/")}`,
    );

    /** Signs and sends one request to the bucket; resolves to the response text and headers. */
    async function s3(
      method: string,
      query: Record<string, string>,
      body?: Uint8Array<ArrayBuffer> | string,
    ) {
      const url = new URL(base);
      for (const [name, value] of Object.entries(query)) {
        url.searchParams.set(name, value);
      }
      const amzDate = new Date(now())
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
      const headers = {
        "x-amz-content-sha256": UNSIGNED_PAYLOAD,
        "x-amz-date": amzDate,
        "x-amz-security-token": destination.sessionToken,
      };
      const authorization = signV4({
        method,
        url,
        headers,
        accessKeyId: destination.accessKeyId,
        secretAccessKey: destination.secretAccessKey,
        region: REGION,
        service: "s3",
        amzDate,
        payloadHash: UNSIGNED_PAYLOAD,
      });
      const response = await send(url, {
        method,
        headers: { ...headers, authorization },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch((error: unknown) => {
        if (error instanceof TypeError) {
          throw new NetworkError("fetch failed", { cause: error });
        }
        throw error;
      });
      const text = await response.text().catch(() => "");
      // CompleteMultipartUpload can answer 200 with an error in the body.
      if (!response.ok || text.includes("<Error>")) {
        const code = xmlValue(text, "Code");
        throw new UnexpectedResponseError(
          `Amazon S3 refused the notarization upload with HTTP ${response.status}${code ? ` (${code})` : ""}; the temporary credentials may have expired, so submit again.`,
        );
      }
      return { text, headers: response.headers };
    }

    const started = await s3("POST", { uploads: "" });
    const uploadId = xmlValue(started.text, "UploadId");
    if (!uploadId) {
      throw new UnexpectedResponseError(
        "Amazon S3 did not return an upload ID for the notarization upload.",
      );
    }

    const etags: string[] = [];
    const handle = await open(file.path, "r");
    try {
      for (let offset = 0; offset < file.size; offset += partSize) {
        const length = Math.min(partSize, file.size - offset);
        const part = new Uint8Array(length);
        const { bytesRead } = await handle.read(part, 0, length, offset);
        if (bytesRead !== length) {
          throw new InvalidInputError(
            "The file changed while it was being uploaded.",
          );
        }
        const sent = await s3(
          "PUT",
          { partNumber: String(etags.length + 1), uploadId },
          part,
        );
        const etag = sent.headers.get("etag");
        if (!etag) {
          throw new UnexpectedResponseError(
            "Amazon S3 did not return an ETag for part of the notarization upload.",
          );
        }
        etags.push(etag);
      }
    } finally {
      await handle.close();
    }

    const parts = etags
      .map(
        (etag, index) =>
          `<Part><PartNumber>${index + 1}</PartNumber><ETag>${etag.replace(/[<>&]/g, "")}</ETag></Part>`,
      )
      .join("");
    await s3(
      "POST",
      { uploadId },
      `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
    );
  };
}
