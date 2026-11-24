import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptBytes, decryptResult, encryptBytes, encryptResult, sha256Hex, toHex } from './lib/crypto.ts';
import { buildReceipt, formatBytes, formatCkb, isTextLike, makePreview, splitLines } from './lib/delivery.ts';

const encode = (text) => new TextEncoder().encode(text);
const lines = (count, width = 8) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`.padEnd(width, '.')).join('\n') + '\n';

/** The revealed part of a preview: everything before the "… N more lines" footer. */
function previewHead(preview) {
  return preview.slice(0, preview.lastIndexOf('\n… '));
}

test('encryptBytes/decryptBytes round-trips arbitrary bytes', async () => {
  const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
  const { key, payload } = await encryptBytes(bytes);
  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.match(payload.iv, /^0x[0-9a-f]{24}$/);
  // AES-GCM adds a 16-byte tag; offer validation relies on this.
  assert.equal((payload.ciphertext.length - 2) / 2, bytes.length + 16);
  assert.deepEqual(await decryptBytes(payload, key), bytes);
});

test('the text wrappers still round-trip', async () => {
  const { key, payload } = await encryptResult('Payment settled ✓');
  assert.equal(await decryptResult(payload, key), 'Payment settled ✓');
});

test('a wrong key or tampered ciphertext is rejected', async () => {
  const { key, payload } = await encryptBytes(encode('secret deploy script'));
  const wrongKey = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(decryptBytes(payload, wrongKey));
  const flipped = `${payload.ciphertext.slice(0, -1)}${payload.ciphertext.endsWith('0') ? '1' : '0'}`;
  await assert.rejects(decryptBytes({ ...payload, ciphertext: flipped }, key));
});

test('sha256Hex matches known vectors', async () => {
  assert.equal(await sha256Hex(encode('abc')),
    '0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new Uint8Array()),
    '0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('preview never exceeds six lines or a third of the file', () => {
  for (let count = 3; count <= 60; count += 1) {
    const text = lines(count);
    const preview = makePreview(encode(text), 'deploy.sh');
    const head = previewHead(preview);
    const shown = splitLines(head).length;
    assert.equal(shown, Math.min(6, Math.floor(count / 3)), `${count} lines`);
    assert.ok(head.length <= Math.floor(text.length / 3), `${count} lines: ${head.length} chars`);
    assert.match(preview, new RegExp(`… ${count - shown} more lines? unlocks? after payment$`));
  }
});

test('preview of a few very long lines is capped at a third of the characters', () => {
  const text = `${'a'.repeat(3000)}\n${'b'.repeat(3000)}\n${'c'.repeat(3000)}\n`;
  const preview = makePreview(encode(text), 'notes.txt');
  assert.ok(previewHead(preview).length <= Math.floor(text.length / 3));
  assert.ok(preview.length <= 4000);
  assert.match(preview, /… 2 more lines unlock after payment$/);
});

test('preview is hidden for very short files', () => {
  for (const text of ['echo hi', 'echo hi\n', 'set -e\necho hi\n']) {
    const preview = makePreview(encode(text), 'tiny.sh');
    assert.match(preview, /^Preview hidden: the file is too short/);
    assert.ok(!preview.includes('echo hi'));
  }
});

test('binary files get no text preview', () => {
  assert.equal(makePreview(Uint8Array.from([0, 1, 2, 255]), 'image.png', 'image/png'),
    'Binary file (4 B). No text preview.');
  // Invalid UTF-8 is treated as binary even with a text-like name.
  assert.equal(makePreview(Uint8Array.from([0xff, 0xfe, 0xfd]), 'broken.txt'),
    'Binary file (3 B). No text preview.');
});

test('text-like detection uses MIME type, extension and well-known names', () => {
  for (const [name, type] of [['deploy.sh', ''], ['values.yaml', ''], ['main.tf', ''], ['Dockerfile', ''],
    ['Caddyfile', ''], ['.env.example', ''], ['notes', 'text/plain'], ['data', 'application/json']]) {
    assert.ok(isTextLike(name, type), name);
  }
  for (const [name, type] of [['logo.png', 'image/png'], ['archive.tar.gz', ''], ['binary', '']]) {
    assert.ok(!isTextLike(name, type), name);
  }
});

test('sizes and CKB amounts are formatted exactly', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(64 * 1024), '64.0 KB');
  assert.equal(formatCkb('0x5f5e100'), '1');
  assert.equal(formatCkb('0x186a0'), '0.001');
  assert.equal(formatCkb('0x0'), '0');
});

test('receipt follows the documented schema', () => {
  const hash = `0x${'ab'.repeat(32)}`;
  const receipt = buildReceipt({
    listing: { title: 'Deploy script', fileName: 'deploy.sh', size: 640, contentHash: hash, preview: 'not copied' },
    invoice: 'fibt1example', paymentHash: hash, preimage: `0x${'cd'.repeat(32)}`, feeShannons: '0x186a0',
    keyMatchesPaymentHash: true, contentMatchesListing: false, issuedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(receipt), ['kind', 'version', 'issuedAt', 'network', 'listing', 'payment', 'checks', 'note']);
  assert.equal(receipt.kind, 'pay-to-deliver-receipt');
  assert.deepEqual(receipt.listing, { title: 'Deploy script', fileName: 'deploy.sh', size: 640, contentHash: hash });
  assert.deepEqual(receipt.payment, {
    invoice: 'fibt1example', paymentHash: hash, preimage: `0x${'cd'.repeat(32)}`,
    amountCkb: '1', feeCkb: '0.001', status: 'Success',
  });
  assert.deepEqual(receipt.checks, { keyMatchesPaymentHash: true, contentMatchesListing: false });
  assert.match(receipt.note, /trusted dispute resolver/);
});
