/**
 * Web Crypto helpers. The core path never imports a Node-only module at the
 * top level, so the package loads on edge runtimes. Where `globalThis.crypto`
 * is absent (older or unusual Node builds), the loader falls back to
 * `node:crypto` through a dynamic import that bundlers do not follow.
 */

import { GovernConfigError } from "./errors";

type WebCryptoLike = {
  subtle: SubtleCrypto;
  randomUUID?: () => string;
  getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T;
};

let cached: Promise<WebCryptoLike> | null = null;

export function webCrypto(): Promise<WebCryptoLike> {
  if (cached) return cached;
  cached = (async () => {
    const global = (globalThis as { crypto?: WebCryptoLike }).crypto;
    if (global?.subtle) return global;
    try {
      // A variable specifier keeps bundlers from following the import; the
      // branch only runs where a Node module loader exists.
      const specifier = "node:crypto";
      const mod = (await import(/* @vite-ignore */ specifier)) as {
        webcrypto?: WebCryptoLike;
      };
      if (mod.webcrypto?.subtle) return mod.webcrypto;
    } catch {
      // fall through
    }
    throw new GovernConfigError(
      "Web Crypto (crypto.subtle) is not available in this runtime. Node 20+ and edge runtimes provide it.",
    );
  })();
  return cached;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 0x0f]!;
  return out;
}

/** SHA-256 over the UTF-8 bytes of `text`, lowercase hex. The outcome hash the API expects. */
export async function sha256Hex(text: string): Promise<string> {
  const { subtle } = await webCrypto();
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
}

/** HMAC-SHA256 over `message` (a string's UTF-8 bytes, or bytes as given) with `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  const { subtle } = await webCrypto();
  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
  const signature = await subtle.sign("HMAC", key, bytes as BufferSource);
  return toHex(new Uint8Array(signature));
}

/** Constant-time string comparison; lengths are compared first, then every character. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** A random identifier for turn ids the caller did not supply. */
export function randomId(): string {
  const global = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (global?.randomUUID) return global.randomUUID();
  const bytes = new Uint8Array(16);
  if (global?.getRandomValues) {
    global.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
