export type EncryptedPayload = {
  ciphertext: `0x${string}`;
  iv: `0x${string}`;
};

export const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;

export const fromHex = (value: string) =>
  Uint8Array.from(value.replace(/^0x/, '').match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16),
  );

/**
 * Encrypts raw bytes with a fresh random AES-256-GCM key.
 * The returned key doubles as the Fiber invoice payment preimage, so paying
 * the invoice is what reveals it to the buyer.
 */
export async function encryptBytes(plaintext: Uint8Array) {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(keyBytes), { name: 'AES-GCM' }, false, ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new Uint8Array(plaintext),
  );
  return {
    key: toHex(keyBytes),
    payload: { ciphertext: toHex(new Uint8Array(ciphertext)), iv: toHex(iv) } satisfies EncryptedPayload,
  };
}

/** Decrypts to raw bytes. AES-GCM authentication makes a wrong key or tampered ciphertext throw. */
export async function decryptBytes(payload: EncryptedPayload, keyHex: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(fromHex(keyHex)), { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(fromHex(payload.iv)) },
    key,
    new Uint8Array(fromHex(payload.ciphertext)),
  );
  return new Uint8Array(plaintext);
}

/** SHA-256 of the given bytes as 0x-prefixed lowercase hex (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))));
}

// Text wrappers kept from the starter so existing callers keep working.
export async function encryptResult(plaintext: string) {
  return encryptBytes(new TextEncoder().encode(plaintext));
}

export async function decryptResult(payload: EncryptedPayload, keyHex: string) {
  return new TextDecoder().decode(await decryptBytes(payload, keyHex));
}
