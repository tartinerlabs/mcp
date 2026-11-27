/**
 * A minimal PKCS#10 certificate signing request encoder (RFC 2986) for the
 * RSA 2048 keys Apple's signing certificates use. WebCrypto makes the key
 * pair and the signature; this only lays out the DER around them.
 */

/** DER length octets: short form below 128, else long form. */
function length(size: number): number[] {
  if (size < 0x80) return [size];
  const octets: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) {
    octets.unshift(rest % 256);
  }
  return [0x80 | octets.length, ...octets];
}

function tlv(tag: number, ...contents: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...contents);
  return concat(Uint8Array.of(tag, ...length(body.length)), body);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** An OBJECT IDENTIFIER from its dotted form, base-128 encoded after the first two arcs. */
function oid(dotted: string): Uint8Array<ArrayBuffer> {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc % 128];
    for (
      let value = Math.floor(arc / 128);
      value > 0;
      value = Math.floor(value / 128)
    ) {
      groups.unshift(0x80 | (value % 128));
    }
    bytes.push(...groups);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

const sequence = (...contents: Uint8Array[]) => tlv(0x30, ...contents);
const COMMON_NAME = "2.5.4.3";
const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

export const RSA_KEY_ALGORITHM: RsaHashedKeyGenParams = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: Uint8Array.of(1, 0, 1),
  hash: "SHA-256",
};

function pem(label: string, der: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

/** A new RSA 2048 key pair, its private key as a PKCS#8 PEM and a CSR for it as a PEM. */
export async function createSigningRequest(
  commonName: string,
): Promise<{ privateKeyPem: string; csrPem: string }> {
  const pair = (await crypto.subtle.generateKey(RSA_KEY_ALGORITHM, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey),
  );
  const subject = sequence(
    tlv(
      0x31,
      sequence(
        oid(COMMON_NAME),
        tlv(0x0c, new TextEncoder().encode(commonName)),
      ),
    ),
  );
  const info = sequence(
    Uint8Array.of(0x02, 0x01, 0x00), // version 0
    subject,
    spki,
    Uint8Array.of(0xa0, 0x00), // no attributes
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(RSA_KEY_ALGORITHM.name, pair.privateKey, info),
  );
  const csr = sequence(
    info,
    sequence(oid(SHA256_WITH_RSA), Uint8Array.of(0x05, 0x00)),
    tlv(0x03, Uint8Array.of(0x00), signature),
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return {
    privateKeyPem: pem("PRIVATE KEY", pkcs8),
    csrPem: pem("CERTIFICATE REQUEST", csr),
  };
}
