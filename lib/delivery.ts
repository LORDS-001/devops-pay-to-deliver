/**
 * Pure helpers for delivering a file through an encrypted offer.
 * No runtime imports: Node's strip-types test runner loads this file directly.
 */

/** The ciphertext travels inside the offer JSON (as hex), so deliverables stay small. */
export const maxDeliveryBytes = 64 * 1024;

/** Upper bound on the unencrypted preview carried in the listing. */
export const maxPreviewChars = 4000;

const textExtensions = new Set([
  'sh', 'bash', 'zsh', 'ps1', 'yml', 'yaml', 'json', 'toml', 'ini', 'conf', 'cfg', 'tf', 'tfvars',
  'hcl', 'py', 'js', 'ts', 'rb', 'go', 'sql', 'md', 'txt', 'service', 'example',
]);
const textFileNames = new Set(['dockerfile', 'makefile', 'caddyfile']);

/** True when a file should be previewed and shown inline as text. */
export function isTextLike(fileName: string, fileType = '') {
  const type = fileType.toLowerCase();
  if (type.startsWith('text/') || /(json|yaml|xml|javascript|x-sh)/.test(type)) return true;
  const base = (fileName.split(/[\\/]/).pop() ?? '').toLowerCase();
  if (textFileNames.has(base)) return true;
  const dot = base.lastIndexOf('.');
  return dot >= 0 && textExtensions.has(base.slice(dot + 1));
}

/** Human-readable size, e.g. 512 B, 1.4 KB. */
export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** Decodes UTF-8 strictly; returns null for bytes that are not valid text. */
export function decodeText(bytes: Uint8Array): string | null {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** Splits text into lines, ignoring one trailing newline so "a\nb\n" is two lines. */
export function splitLines(text: string) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Builds the free preview published in the listing.
 * Text-like files reveal at most 6 lines and never more than a third of the file
 * (by lines and by characters); binary files reveal nothing.
 */
export function makePreview(bytes: Uint8Array, fileName: string, fileType = '') {
  const text = isTextLike(fileName, fileType) ? decodeText(bytes) : null;
  if (text === null) return `Binary file (${formatBytes(bytes.length)}). No text preview.`;
  const lines = splitLines(text);
  const shown = Math.min(6, Math.floor(lines.length / 3));
  if (shown === 0) {
    return `Preview hidden: the file is too short (${lines.length} ${lines.length === 1 ? 'line' : 'lines'}) to reveal any of it before payment.`;
  }
  const remaining = lines.length - shown;
  const footer = `… ${remaining} more ${remaining === 1 ? 'line unlocks' : 'lines unlock'} after payment`;
  // Also cap by characters so a few very long lines cannot leak most of the file.
  const budget = Math.min(maxPreviewChars - footer.length - 2, Math.floor(text.length / 3));
  let head = lines.slice(0, shown).join('\n');
  if (head.length > budget) head = `${head.slice(0, Math.max(0, budget - 1))}…`;
  return `${head}\n${footer}`;
}

/** Saves bytes or text as a file in the browser, restoring the original name and type. */
export function downloadBlob(data: Uint8Array | string, fileName: string, type = 'application/octet-stream') {
  const blob = new Blob([typeof data === 'string' ? data : new Uint8Array(data)], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Formats a shannon amount (hex or decimal string) as an exact CKB decimal string. */
export function formatCkb(shannons: string) {
  const value = BigInt(shannons);
  const whole = value / 100_000_000n;
  const fraction = (value % 100_000_000n).toString().padStart(8, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export type ReceiptListing = { title: string; fileName: string; size: number; contentHash: `0x${string}` };

export type PurchaseReceipt = {
  kind: 'pay-to-deliver-receipt';
  version: 1;
  issuedAt: string;
  network: 'CKB Testnet (Fiber)';
  listing: ReceiptListing;
  payment: {
    invoice: string;
    paymentHash: `0x${string}`;
    preimage: `0x${string}`;
    amountCkb: '1';
    feeCkb: string;
    status: 'Success';
  };
  checks: { keyMatchesPaymentHash: boolean; contentMatchesListing: boolean };
  note: string;
};

/** Builds the proof-of-purchase receipt. Contains the preimage, so it is downloaded, never stored. */
export function buildReceipt(input: {
  listing: ReceiptListing;
  invoice: string;
  paymentHash: `0x${string}`;
  preimage: `0x${string}`;
  feeShannons: string;
  keyMatchesPaymentHash: boolean;
  contentMatchesListing: boolean;
  issuedAt?: string;
}): PurchaseReceipt {
  const { title, fileName, size, contentHash } = input.listing;
  return {
    kind: 'pay-to-deliver-receipt',
    version: 1,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    network: 'CKB Testnet (Fiber)',
    listing: { title, fileName, size, contentHash },
    payment: {
      invoice: input.invoice,
      paymentHash: input.paymentHash,
      preimage: input.preimage,
      amountCkb: '1',
      feeCkb: formatCkb(input.feeShannons),
      status: 'Success',
    },
    checks: {
      keyMatchesPaymentHash: input.keyMatchesPaymentHash,
      contentMatchesListing: input.contentMatchesListing,
    },
    note: 'The preimage proves payment for this invoice. Anyone holding it can decrypt the matching ciphertext, so share this receipt only with a trusted dispute resolver.',
  };
}
