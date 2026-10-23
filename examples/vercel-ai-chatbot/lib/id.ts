/**
 * A conversation/turn id that works outside a secure context.
 *
 * `crypto.randomUUID()` is only defined on HTTPS origins and on `localhost`.
 * Anyone who runs this example on a dev box they reach by hostname (for
 * example `http://my-box:3000`) gets `crypto.randomUUID is not a function`
 * and a blank page, so fall back to `getRandomValues`, then to `Math.random`.
 *
 * The SDK does the same thing internally for the ids it generates; these are
 * the example's own ids, so it carries its own copy rather than widening the
 * package's public surface.
 */
export function newId(): string {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.randomUUID === "function") return webCrypto.randomUUID();

  const bytes = new Uint8Array(16);
  if (typeof webCrypto?.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // Set the version (4) and variant bits so the value is a well-formed UUID.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
