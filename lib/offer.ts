import { bottle } from './fiber';
import type { Channel, FiberBrowserNode } from '@fiber-pay/sdk/browser';
import { encryptBytes, sha256Hex, type EncryptedPayload } from './crypto';
import { makePreview, maxDeliveryBytes, maxPreviewChars } from './delivery';

/**
 * Public description of the deliverable, shown to the client before paying.
 * contentHash commits the freelancer to the exact plaintext bytes.
 */
export type Listing = {
  title: string;
  fileName: string;
  fileType: string;
  size: number;
  preview: string;
  contentHash: `0x${string}`;
};

/** What the freelancer hands to createOffer. */
export type Deliverable = {
  title: string;
  fileName: string;
  fileType: string;
  bytes: Uint8Array;
};

export type EncryptedOffer = EncryptedPayload & {
  version: 3;
  cipher: 'AES-256-GCM';
  invoice: string;
  paymentHash: `0x${string}`;
  lastHop: {
    pubkey: `0x${string}`;
    channel_outpoint: `0x${string}`;
    fee_rate: `0x${string}`;
    tlc_expiry_delta: `0x${string}`;
  };
  listing: Listing;
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeHexBytes(value: unknown, label: string, bytes?: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const body = value.trim().replace(/^0x/i, '');
  if (!body || body.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(body)) {
    throw new Error(`${label} must be hexadecimal bytes.`);
  }
  if (bytes !== undefined && body.length !== bytes * 2) {
    throw new Error(`${label} must be ${bytes} bytes.`);
  }
  return `0x${body.toLowerCase()}` as `0x${string}`;
}

function normalizeHexQuantity(value: unknown, label: string) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return `0x${value.toString(16)}` as `0x${string}`;
  }
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const normalized = value.trim();
  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  if (/^\d+$/.test(normalized)) {
    return `0x${BigInt(normalized).toString(16)}` as `0x${string}`;
  }
  throw new Error(`${label} must be a non-negative integer.`);
}

function packOutpoint(txHash: `0x${string}`, index: `0x${string}`) {
  const indexValue = BigInt(index);
  if (indexValue > 0xffff_ffffn) throw new Error('Last-hop output index exceeds u32.');
  const indexBytes = indexValue
    .toString(16)
    .padStart(8, '0')
    .match(/../g)
    ?.reverse()
    .join('');
  return `0x${txHash.slice(2)}${indexBytes}` as `0x${string}`;
}

function normalizeOutpoint(value: unknown): EncryptedOffer['lastHop']['channel_outpoint'] {
  if (isJsonObject(value)) {
    return packOutpoint(
      normalizeHexBytes(value.tx_hash ?? value.txHash, 'Last-hop transaction hash', 32),
      normalizeHexQuantity(value.index, 'Last-hop output index'),
    );
  }
  if (typeof value === 'string' && /^0x[0-9a-f]{72}$/i.test(value.trim())) {
    return value.trim().toLowerCase() as `0x${string}`;
  }
  throw new Error('Last-hop channel outpoint is missing or malformed.');
}

function normalizeLastHop(value: unknown): EncryptedOffer['lastHop'] {
  if (!isJsonObject(value)) throw new Error('Last-hop hint is missing.');
  if (normalizeHexBytes(value.pubkey, 'Last-hop public key', 33) !== bottle.pubkey) throw new Error('Last-hop hint must identify Bottle.');
  return {
    pubkey: normalizeHexBytes(value.pubkey, 'Last-hop public key', 33),
    channel_outpoint: normalizeOutpoint(value.channel_outpoint ?? value.channelOutpoint),
    fee_rate: normalizeHexQuantity(value.fee_rate ?? value.feeRate, 'Last-hop fee rate'),
    tlc_expiry_delta: normalizeHexQuantity(
      value.tlc_expiry_delta ?? value.tlcExpiryDelta,
      'Last-hop expiry delta',
    ),
  };
}

// AES-GCM appends a 16-byte authentication tag to the ciphertext.
const gcmTagBytes = 16;

function normalizeText(value: unknown, label: string, max: number) {
  if (typeof value !== 'string') throw new Error(`${label} is missing.`);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${label} must be 1–${max} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error(`${label} must not contain control characters.`);
  return text;
}

function normalizeFileName(value: unknown) {
  const name = normalizeText(value, 'Listing file name', 200);
  if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Listing file name must not contain a path.');
  return name;
}

function normalizeFileType(value: unknown) {
  if (value === undefined || value === '') return 'application/octet-stream';
  if (typeof value !== 'string' || value.length > 200
    || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(\s*;.*)?$/i.test(value.trim())) {
    throw new Error('Listing file type must be a MIME type.');
  }
  return value.trim().toLowerCase();
}

/** Strictly validates the untrusted listing from offer JSON. */
function normalizeListing(value: unknown, ciphertext: `0x${string}`): Listing {
  if (!isJsonObject(value)) throw new Error('Offer listing is missing.');
  const size = value.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > maxDeliveryBytes) {
    throw new Error(`Listing size must be a whole number of bytes between 1 and ${maxDeliveryBytes}.`);
  }
  if ((ciphertext.length - 2) / 2 !== size + gcmTagBytes) {
    throw new Error('Listing size does not match the ciphertext length.');
  }
  if (typeof value.preview !== 'string' || value.preview.length > maxPreviewChars) {
    throw new Error(`Listing preview must be text of at most ${maxPreviewChars} characters.`);
  }
  return {
    title: normalizeText(value.title, 'Listing title', 120),
    fileName: normalizeFileName(value.fileName),
    fileType: normalizeFileType(value.fileType),
    size,
    preview: value.preview,
    contentHash: normalizeHexBytes(value.contentHash, 'Listing content hash', 32),
  };
}

export async function createOffer(seller: FiberBrowserNode, sellerChannel: Channel, deliverable: Deliverable) {
  if (!sellerChannel.channel_outpoint) {
    throw new Error('Seller channel does not have a confirmed outpoint.');
  }
  const { bytes } = deliverable;
  if (bytes.length === 0) throw new Error('The deliverable is empty.');
  if (bytes.length > maxDeliveryBytes) throw new Error(`The deliverable exceeds ${maxDeliveryBytes / 1024} KB.`);
  const fileType = normalizeFileType(deliverable.fileType);
  // Commit to the exact plaintext bytes before encrypting them.
  const listing: Listing = {
    title: normalizeText(deliverable.title, 'Listing title', 120),
    fileName: normalizeFileName(deliverable.fileName),
    fileType,
    size: bytes.length,
    preview: makePreview(bytes, deliverable.fileName, fileType),
    contentHash: await sha256Hex(bytes),
  };
  const encrypted = await encryptBytes(bytes);
  const invoice = await seller.newInvoice({
    amount: '0x5f5e100', // 1 CKB
    currency: 'Fibt',
    payment_preimage: encrypted.key,
    hash_algorithm: 'sha256',
    allow_trampoline_routing: true,
    description: 'DevOps Pay-to-Deliver',
    expiry: '0xe10',
  });
  const offer: EncryptedOffer = {
    version: 3,
    cipher: 'AES-256-GCM',
    ...encrypted.payload,
    invoice: invoice.invoice_address,
    paymentHash: invoice.invoice.data.payment_hash,
    lastHop: {
      pubkey: sellerChannel.pubkey,
      channel_outpoint: normalizeOutpoint(sellerChannel.channel_outpoint),
      fee_rate: normalizeHexQuantity(
        sellerChannel.tlc_fee_proportional_millionths,
        'Last-hop fee rate',
      ),
      tlc_expiry_delta: normalizeHexQuantity(
        sellerChannel.tlc_expiry_delta,
        'Last-hop expiry delta',
      ),
    },
    listing,
  };
  return JSON.stringify(offer, null, 2);
}

export function parseOffer(value: string) {
  const offer: unknown = JSON.parse(value);
  if (!isJsonObject(offer) || offer.version !== 3 || offer.cipher !== 'AES-256-GCM') {
    throw new Error('Create a fresh version 3 AES-256-GCM encrypted offer.');
  }
  if (typeof offer.invoice !== 'string' || !offer.invoice.toLowerCase().startsWith('fibt')) {
    throw new Error('Encrypted offer is missing a Fiber testnet Invoice.');
  }
  const ciphertext = normalizeHexBytes(offer.ciphertext, 'Ciphertext');
  return {
    version: 3,
    cipher: 'AES-256-GCM',
    ciphertext,
    iv: normalizeHexBytes(offer.iv, 'AES-GCM IV', 12),
    invoice: offer.invoice,
    paymentHash: normalizeHexBytes(offer.paymentHash, 'Invoice payment hash', 32),
    lastHop: normalizeLastHop(offer.lastHop),
    listing: normalizeListing(offer.listing, ciphertext),
  } satisfies EncryptedOffer;
}
