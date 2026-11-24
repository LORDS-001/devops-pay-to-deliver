'use client';

import { channelFundingGuidance } from '../lib/channel-funding';
import { useEffect, useRef, useState } from 'react';
import { scriptToAddress, type Channel, type FiberBrowserNode, type GetPaymentResult } from '@fiber-pay/sdk/browser';
import { decryptBytes, decryptResult, fromHex, sha256Hex, toHex } from '../lib/crypto';
import { buildReceipt, decodeText, downloadBlob, formatBytes, isTextLike, maxDeliveryBytes } from '../lib/delivery';
import { bottle, channelFundingCkb, connectAndOpenChannel, readChannel, ready, startRole } from '../lib/fiber';
import { createOffer, parseOffer, type Deliverable, type EncryptedOffer } from '../lib/offer';
import { payForOffer, validateOffer } from '../lib/payment';
import { createBrowserNodeSession } from '../lib/node-session';
import { encryptedSessionKey, encryptedBuyerProfile, encryptedSellerProfile, savedNodeIdentifier, readEncryptedProgress, type EncryptedLessonProgress } from '../lib/progress';

type Role = 'buyer' | 'seller';
const ckb = (value: string) => `${Number(BigInt(value)) / 100_000_000}`;

// Sample deliverable. No real secrets or hostnames: the registry is example.com.
const sampleTitle = 'Zero-downtime deploy script for client-api';
const sampleFileName = 'deploy.sh';
const sampleScript = [
  '#!/usr/bin/env bash',
  '# Zero-downtime blue/green deploy for client-api.',
  'set -euo pipefail',
  'IMAGE="registry.example.com/client-api:${1:?usage: deploy.sh <tag>}"',
  'LIVE=$(cat /srv/client-api/live 2>/dev/null || echo blue)',
  'NEXT=$([ "$LIVE" = blue ] && echo green || echo blue)',
  'docker pull "$IMAGE"',
  'docker rm -f "client-api-$NEXT" 2>/dev/null || true',
  'docker run -d --name "client-api-$NEXT" --env-file /srv/client-api/env "$IMAGE"',
  'for i in $(seq 1 30); do',
  '  docker exec "client-api-$NEXT" curl -fsS http://localhost:8080/healthz && break',
  '  [ "$i" -eq 30 ] && { docker rm -f "client-api-$NEXT"; echo "Health check failed"; exit 1; }',
  '  sleep 2',
  'done',
  'ln -sfn "/etc/nginx/upstreams/$NEXT.conf" /etc/nginx/upstreams/live.conf && nginx -s reload',
  'echo "$NEXT" > /srv/client-api/live && docker rm -f "client-api-$LIVE" || true',
  'echo "Traffic switched from $LIVE to $NEXT"',
  '',
].join('\n');

type Upload = { name: string; type: string; bytes: Uint8Array };
/** Decrypted delivery, kept in memory only (never written to browser storage). */
type Delivery = { bytes: Uint8Array; text: string | null; keyOk: boolean; contentOk: boolean };

export default function Page() {
  const nodes = useRef<Partial<Record<Role, FiberBrowserNode>>>({});
  const sessions = useRef<Partial<Record<Role, ReturnType<typeof createBrowserNodeSession>>>>({});
  const progress = useRef<EncryptedLessonProgress | null>(null);
  const locked = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Partial<Record<Role, string>>>({});
  const [connected, setConnected] = useState<Partial<Record<Role, boolean>>>({});
  const [channels, setChannels] = useState<Partial<Record<Role, Channel>>>({});
  const [title, setTitle] = useState(sampleTitle);
  const [source, setSource] = useState<'paste' | 'upload'>('paste');
  const [fileName, setFileName] = useState(sampleFileName);
  const [plaintext, setPlaintext] = useState(sampleScript);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [generated, setGenerated] = useState('');
  const [received, setReceived] = useState('');
  const [offer, setOffer] = useState<EncryptedOffer | null>(null);
  const [attempt, setAttempt] = useState('');
  const [tested, setTested] = useState(false);
  const [payment, setPayment] = useState<GetPaymentResult | null>(null);
  const [key, setKey] = useState('');
  const [delivery, setDelivery] = useState<Delivery | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const saved = readEncryptedProgress(sessionStorage, localStorage);
    progress.current = saved;
    if (saved) { setGenerated(saved.generatedOffer); setReceived(saved.buyerOfferText); setAttempt(saved.attemptedPaymentHash); setTested(saved.triedWithoutKey); }
    setLoaded(true);
    const owned = sessions.current;
    const stop = () => { for (const session of Object.values(owned)) void session.stop().catch(() => {}); };
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); nodes.current = {}; sessions.current = {}; };
  }, []);

  function save(update: Partial<EncryptedLessonProgress>) {
    const buyerId = savedNodeIdentifier(localStorage, encryptedBuyerProfile);
    const sellerId = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    if (!buyerId || !sellerId) throw new Error('Start both saved nodes before continuing.');
    const next = { version: 1 as const, buyerId, sellerId, generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, ...progress.current, ...update };
    sessionStorage.setItem(encryptedSessionKey, JSON.stringify(next));
    progress.current = next;
  }

  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Action failed. Check status before retrying a transfer.'); }
    finally { locked.current = false; setBusy(false); }
  }

  async function refresh(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await readChannel(node);
    const { peers } = await node.listPeers();
    setConnected((previous) => ({ ...previous, [role]: peers.some(peer => peer.pubkey.replace(/^0x/i, '').toLowerCase() === bottle.pubkey.slice(2)) }));
    setChannels((previous) => ({ ...previous, [role]: channel }));
  }

  async function start(role: Role) {
    if (nodes.current[role]) return;
    const session = sessions.current[role] ??= createBrowserNodeSession();
    let started: FiberBrowserNode | undefined;
    await session.start(role === 'buyer' ? encryptedBuyerProfile : encryptedSellerProfile, async (track) => {
      started = await startRole(role, track);
    });
    if (!started) return;
    nodes.current[role] = started;
    const info = await started.nodeInfo();
    setAddresses((previous) => ({ ...previous, [role]: scriptToAddress(info.default_funding_lock_script, 'testnet') }));
    if (await readChannel(started)) await started.connectPeer(bottle);
    await refresh(role);
  }

  async function open(role: Role) {
    const node = nodes.current[role];
    if (!node) return;
    const channel = await connectAndOpenChannel(node);
    setChannels((previous) => ({ ...previous, [role]: channel }));
    await refresh(role);
    setStatus(channel && ready(channel) ? 'Channel ready.' : 'Opening submitted. Check channel status after confirmation.');
  }

  async function moveLiquidity() {
    const node = nodes.current.seller;
    if (!node) return;
    const id = savedNodeIdentifier(localStorage, encryptedSellerProfile);
    const storageKey = `fiber-docs:encrypted-inbound:${id}`;
    const existing = sessionStorage.getItem(storageKey);
    if (existing === 'submitting') throw new Error('Transfer outcome unknown. Review payment history before sending again.');
    let result: GetPaymentResult;
    if (existing) result = await node.getPayment({ payment_hash: existing as `0x${string}` });
    else {
      sessionStorage.setItem(storageKey, 'submitting');
      result = await node.sendPayment({ target_pubkey: bottle.pubkey, amount: '0x1dcd65000', keysend: true });
      sessionStorage.setItem(storageKey, result.payment_hash);
    }
    if (!['Success', 'Failed'].includes(result.status)) result = await node.waitForPayment(result.payment_hash, { timeout: 60_000, interval: 1_000 });
    if (result.status === 'Failed') sessionStorage.removeItem(storageKey);
    setStatus(`Liquidity transfer: ${result.status}`);
    await refresh('seller');
  }

  /** The file the freelancer is about to list: an upload, or pasted text with a file name. */
  function deliverable(): Deliverable | null {
    if (source === 'upload') {
      return upload && { title, fileName: upload.name, fileType: upload.type || 'application/octet-stream', bytes: upload.bytes };
    }
    if (!plaintext.trim() || !fileName.trim()) return null;
    return { title, fileName, fileType: 'text/plain', bytes: new TextEncoder().encode(plaintext) };
  }

  async function chooseFile(file: File | undefined) {
    setUpload(null);
    if (!file) return;
    if (file.size > maxDeliveryBytes) {
      throw new Error(`${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(maxDeliveryBytes)} because the encrypted file travels inside the offer JSON.`);
    }
    if (file.size === 0) throw new Error(`${file.name} is empty.`);
    setUpload({ name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
    setStatus(`${file.name} ready to list.`);
  }

  async function makeOffer() {
    const item = deliverable();
    if (!nodes.current.seller || !channels.seller || !routeReady || generated || attempt || !item) return;
    const value = await createOffer(nodes.current.seller, channels.seller, item);
    save({ generatedOffer: value }); setGenerated(value); setStatus('Listing committed and invoice created.');
  }

  async function validate() {
    if (!nodes.current.buyer) return;
    const parsed = parseOffer(received);
    await validateOffer(nodes.current.buyer, parsed);
    if (attempt && parsed.paymentHash.toLowerCase() !== attempt.toLowerCase()) throw new Error('Restore the offer for the previous payment.');
    save({ buyerOfferText: received }); setOffer(parsed); setStatus('Offer validated.');
  }

  async function testLock() {
    if (!offer) return;
    try { await decryptResult(offer, toHex(crypto.getRandomValues(new Uint8Array(32)))); }
    catch { save({ triedWithoutKey: true }); setTested(true); setStatus('Decryption rejected: key unavailable.'); }
  }

  async function pay() {
    if (!nodes.current.buyer || !offer || !tested || !routeReady) return;
    const result = await payForOffer(nodes.current.buyer, offer, attempt, (hash) => {
      save({ attemptedPaymentHash: hash }); setAttempt(hash);
    }, payment?.status === 'Failed');
    acceptPayment(result);
    await Promise.all([refresh('buyer'), refresh('seller')]);
  }

  function acceptPayment(result: GetPaymentResult) {
    setPayment(result); setStatus(`Payment: ${result.status}`);
    if (result.status === 'Failed') setError(result.failed_error ?? 'Payment failed. Check channel liquidity before retrying.');
    if (result.status === 'Success' && result.payment_preimage) setKey(result.payment_preimage);
  }

  /**
   * Decrypts with the key revealed by the settled payment, then proves delivery:
   * 1. key check: SHA-256(revealed preimage) equals the invoice payment hash;
   * 2. content check: SHA-256(decrypted bytes) equals the listing's contentHash.
   * Plaintext stays in memory only.
   */
  async function unlock() {
    if (!offer || !key || delivery) return;
    const keyOk = (await sha256Hex(fromHex(key))) === offer.paymentHash.toLowerCase();
    const bytes = await decryptBytes(offer, key);
    const contentOk = (await sha256Hex(bytes)) === offer.listing.contentHash.toLowerCase();
    const text = isTextLike(offer.listing.fileName, offer.listing.fileType) ? decodeText(bytes) : null;
    setDelivery({ bytes, text, keyOk, contentOk });
    setStatus(keyOk && contentOk ? `${offer.listing.fileName} delivered and verified.` : `${offer.listing.fileName} decrypted, but a check failed.`);
  }

  /** Proof-of-purchase receipt. It contains the preimage, so it is only downloaded, never stored. */
  function downloadReceipt() {
    if (!offer || !delivery || !key || payment?.status !== 'Success') return;
    const receipt = buildReceipt({
      listing: offer.listing, invoice: offer.invoice, paymentHash: offer.paymentHash,
      preimage: key as `0x${string}`, feeShannons: payment.fee,
      keyMatchesPaymentHash: delivery.keyOk, contentMatchesListing: delivery.contentOk,
    });
    downloadBlob(JSON.stringify(receipt, null, 2), `receipt-${offer.paymentHash.slice(2, 10)}.json`, 'application/json');
  }

  async function checkPayment() {
    if (!nodes.current.buyer || !offer || !attempt) return;
    await validateOffer(nodes.current.buyer, offer);
    acceptPayment(await nodes.current.buyer.getPayment({ payment_hash: attempt as `0x${string}` }));
  }

  function startAnotherOffer() {
    // A pending or unchecked payment still blocks a restart; a settled one (Failed or Success) does not.
    if (busy || (attempt && !settled)) return;
    save({ generatedOffer: '', buyerOfferText: '', attemptedPaymentHash: '', triedWithoutKey: false, completedSteps: [] });
    setGenerated(''); setReceived(''); setOffer(null); setAttempt(''); setTested(false);
    setPayment(null); setKey(''); setDelivery(null); setError('');
    // The freelancer form returns to the sample deliverable too.
    setTitle(sampleTitle); setSource('paste'); setFileName(sampleFileName); setPlaintext(sampleScript); setUpload(null);
    setStatus('Create a fresh listing and encrypted offer.');
  }

  const settled = payment?.status === 'Failed' || payment?.status === 'Success';

  const routeReady = Boolean(connected.buyer && connected.seller && channels.buyer && ready(channels.buyer) && BigInt(channels.buyer.local_balance) >= 100_000_000n && channels.seller && ready(channels.seller) && BigInt(channels.seller.remote_balance) >= 100_000_000n);
  const canSubmit = Boolean(offer && tested && routeReady && !key && (!attempt || payment?.status === 'Failed'));

  /** Why "Encrypt & create" is disabled, in the order routeReady checks it, so the user knows what to do next. */
  function offerBlocker() {
    if (!addresses.buyer || !addresses.seller) return 'Start both nodes first.';
    if (!channels.buyer || !ready(channels.buyer) || !channels.seller || !ready(channels.seller)) {
      return 'Both channels must be CHANNEL_READY. Click Refresh channel status on each node.';
    }
    if (!connected.seller) return 'The Freelancer node is not connected to Bottle B. Click Reconnect / check channel on it.';
    if (!connected.buyer) return 'The Client node is not connected to Bottle B. Click Reconnect / check channel on it.';
    if (BigInt(channels.buyer.local_balance) < 100_000_000n) return 'The Client needs at least 1 CKB on its side of its channel.';
    if (BigInt(channels.seller.remote_balance) < 100_000_000n) {
      return 'Bottle B needs at least 1 CKB on its side of the Freelancer channel to route the payment in. Click Send / check 5 CKB transfer.';
    }
    if (!title.trim()) return 'Enter a listing title.';
    if (!deliverable()) return source === 'upload' ? 'Choose a file to upload.' : 'Enter a file name and the file contents.';
    return '';
  }
  const blocker = generated || attempt ? '' : offerBlocker();

  return <main>
    <p className="eyebrow">Fiber Testnet · DevOps Pay-to-Deliver</p><h1>Get paid. Prove delivery.</h1>
    <p className="lede">A freelancer lists a DevOps deliverable, commits to its SHA-256 hash, shows a free preview and encrypts the file. The client reviews the listing and pays a 1 CKB Fiber Testnet invoice routed through Bottle B. Settling the payment reveals the decryption key, and the app proves delivery: the key matches the invoice payment hash, and the file matches the listing commitment.</p>
    {status && <p className="status" role="status">{status}</p>}{error && <p role="alert">{error}</p>}
    <div className="grid">{(['buyer', 'seller'] as const).map((role) => <section className="card" key={role}>
      <h2>{role === 'buyer' ? 'Client (Buyer A)' : 'Freelancer (Seller C)'}</h2>
      {!addresses[role] && <button disabled={!loaded || busy} onClick={() => void run(() => start(role))}>Start node</button>}
      {addresses[role] && <><code>{addresses[role]}</code><a href="https://faucet.nervos.org" target="_blank" rel="noreferrer">Get Testnet CKB ↗</a>
        {!channels[role] && <p>{channelFundingGuidance}</p>}
        <button disabled={busy} onClick={() => void run(() => open(role))}>{channels[role] ? 'Reconnect / check channel' : `Open ${channelFundingCkb} CKB channel`}</button>
        <button disabled={busy} onClick={() => void run(() => refresh(role))}>Refresh channel status</button>
      </>}
      {channels[role] && <><code>{channels[role].state.state_name}</code><p>{role === 'buyer' ? 'Client' : 'Freelancer'}: {ckb(channels[role].local_balance)} CKB · Bottle: {ckb(channels[role].remote_balance)} CKB</p></>}
    </section>)}</div>
    <section className="card"><h2>Liquidity</h2><button disabled={busy || !channels.seller || !ready(channels.seller) || BigInt(channels.seller.local_balance) < 500_000_000n} onClick={() => void run(moveLiquidity)}>Send / check 5 CKB transfer</button></section>
    <div className="grid exchange"><section className="card"><h2>Freelancer (Seller C): list & encrypt</h2>
      <label className="field"><span>Listing title</span>
        <input maxLength={120} disabled={busy || Boolean(generated)} value={title} onChange={e => setTitle(e.target.value)} /></label>
      <fieldset className="choice" disabled={busy || Boolean(generated)}><legend>Deliverable</legend>
        <label><input type="radio" name="source" checked={source === 'paste'} onChange={() => setSource('paste')} /> Paste text</label>
        <label><input type="radio" name="source" checked={source === 'upload'} onChange={() => setSource('upload')} /> Upload file</label>
      </fieldset>
      {source === 'paste' ? <>
        <label className="field"><span>File name</span>
          <input maxLength={200} disabled={busy || Boolean(generated)} value={fileName} onChange={e => setFileName(e.target.value)} /></label>
        <textarea aria-label="Deliverable contents" disabled={busy || Boolean(generated)} value={plaintext} onChange={e => setPlaintext(e.target.value)} />
      </> : <label className="field"><span>File (max {formatBytes(maxDeliveryBytes)})</span>
        <input type="file" disabled={busy || Boolean(generated)} onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; void run(() => chooseFile(file)); }} />
</label>}
      {source === 'upload' && <small className="hint">{upload ? `Ready: ${upload.name} · ${formatBytes(upload.bytes.length)}` : 'No file chosen.'}</small>}
      <button disabled={busy || !routeReady || !title.trim() || !deliverable() || Boolean(generated || attempt)} onClick={() => void run(makeOffer)}>Encrypt & create 1 CKB Invoice</button>
      {blocker && loaded && <small className="hint" role="note">{blocker}</small>}
      <textarea aria-label="Generated offer" readOnly value={generated} />
      <button disabled={!generated || busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(generated); setStatus('Offer copied.'); })}>Copy offer</button>
    </section><section className="card"><h2>Client (Buyer A): review, pay & unlock</h2>
      <textarea aria-label="Received offer" disabled={busy || Boolean(offer || attempt)} value={received} onChange={e => { setReceived(e.target.value); setTested(false); }} />
      <button disabled={busy || !received || !addresses.buyer || Boolean(offer)} onClick={() => void run(validate)}>Validate offer</button>
      {/* Listing fields come from untrusted JSON: rendered as React text only. */}
      {offer && <div className="listing">
        <span>Listing · review before paying</span>
        <h3>{offer.listing.title}</h3>
        <dl>
          <dt>File</dt><dd>{offer.listing.fileName}</dd>
          <dt>Size</dt><dd>{formatBytes(offer.listing.size)}</dd>
          <dt>Content hash (SHA-256)</dt><dd><code>{offer.listing.contentHash}</code></dd>
        </dl>
        <span>Free preview</span>
        <pre>{offer.listing.preview}</pre>
      </div>}
      {!tested && <button disabled={busy || !offer} onClick={() => void run(testLock)}>Decrypt without key</button>}
      {canSubmit && <button disabled={busy} onClick={() => void run(pay)}>{attempt ? 'Retry failed payment' : 'Pay 1 CKB'}</button>}
      {attempt && !key && <button disabled={busy || !offer || !addresses.buyer} onClick={() => void run(checkPayment)}>Check payment status</button>}
      <button disabled={busy || !offer || !key || Boolean(delivery)} onClick={() => void run(unlock)}>Decrypt & verify delivery</button>
    </section></div>
    {payment?.status === 'Success' && <section className="card"><h2>Payment</h2><p>Amount: 1 CKB · Fee: {ckb(payment.fee)} CKB · Total: {ckb(`0x${(100_000_000n + BigInt(payment.fee)).toString(16)}`)} CKB</p><code>{payment.payment_hash}</code></section>}
    {delivery && offer && <section className="result"><h2>Delivered: {offer.listing.fileName}</h2>
      <p className={`check ${delivery.keyOk ? 'ok' : 'bad'}`}>{delivery.keyOk
        ? '✓ Key verified: SHA-256 of the revealed key matches the invoice payment hash'
        : '✗ Key mismatch: SHA-256 of the revealed key does NOT match the invoice payment hash'}</p>
      <p className={`check ${delivery.contentOk ? 'ok' : 'bad'}`}>{delivery.contentOk
        ? '✓ Content verified: this is exactly the file the freelancer committed to in the listing'
        : '✗ Content mismatch: this file does NOT match the listing commitment'}</p>
      {delivery.text !== null ? <pre>{delivery.text}</pre> : <p>Binary file ({formatBytes(delivery.bytes.length)}). Download it to open.</p>}
      <div className="actions">
        <button disabled={busy} onClick={() => void run(async () => downloadBlob(delivery.bytes, offer.listing.fileName, offer.listing.fileType))}>Download {offer.listing.fileName}</button>
        {payment?.status === 'Success' && <button disabled={busy} onClick={() => void run(async () => downloadReceipt())}>Download proof-of-purchase receipt</button>}
      </div>
    </section>}
    {(generated || received) && (!attempt || settled) && <button disabled={busy} onClick={() => void run(async () => startAnotherOffer())}>Start another offer</button>}
  </main>;
}
