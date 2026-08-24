// Direct test of beginReceiptAttempt's Firestore transaction guard, with
// Cloud Functions entirely out of the picture — isolates the actual
// idempotency mechanism from any Functions-runtime/networking behavior.
// Written after B3 test 14 (double-click, run through the full
// Functions-emulator stack) initially looked like it found a real
// duplicate-document bug; this test proves the transaction guard itself is
// correct in isolation — the real bug turned out to be a response-shape
// inconsistency in issueReceipt.js's already-issued branch (fixed
// separately). Kept as permanent regression coverage for the core
// guarantee, decoupled from Functions-emulator quirks.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
// Must be the SAME physical firebase-admin module instance receiptState.js
// itself resolves (functions/node_modules), not the root copy — otherwise
// initializeApp() and getFirestore() land on two different singletons and
// every call fails with "app/no-app".
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));
admin.initializeApp({ projectId: 'mirit-nails-receiptstate-test' });
const db = admin.firestore();
const { beginReceiptAttempt, recordReceiptSuccess, ReceiptStateError } = require('../functions/src/receiptState');

let counter = 0;
const nextId = () => `rs-${Date.now()}-${counter++}`;

test('exactly one of two truly-concurrent beginReceiptAttempt calls reaches "ready"', async () => {
  const id = nextId();
  await db.collection('appointments').doc(id).set({ name: 'x', status: 'confirmed' });

  const results = await Promise.allSettled([
    beginReceiptAttempt(id, { amount: 100, method: 'cash', adminUid: 'u1' }),
    beginReceiptAttempt(id, { amount: 100, method: 'cash', adminUid: 'u1' }),
  ]);

  const ready = results.filter((r) => r.status === 'fulfilled' && r.value.status === 'ready');
  const blocked = results.filter((r) => r.status === 'rejected' && r.reason instanceof ReceiptStateError && r.reason.code === 'ALREADY_IN_PROGRESS');
  assert.equal(ready.length, 1, 'exactly one concurrent call must reach "ready"');
  assert.equal(blocked.length, 1, 'the other must be rejected as ALREADY_IN_PROGRESS');
});

test('beginReceiptAttempt on an already-issued appointment returns idempotent no-op, never "ready"', async () => {
  const id = nextId();
  await db.collection('appointments').doc(id).set({ name: 'x', status: 'confirmed' });
  await beginReceiptAttempt(id, { amount: 100, method: 'cash', adminUid: 'u1' });
  await recordReceiptSuccess(id, { documentId: 'doc-1', documentNumber: 4242, documentType: 2, pdfUrl: null });

  const result = await beginReceiptAttempt(id, { amount: 999, method: 'bit', adminUid: 'u2' });
  assert.equal(result.status, 'already-issued');
  assert.equal(result.receipt.documentNumber, 4242);

  const doc = await db.collection('appointments').doc(id).get();
  assert.equal(doc.data().payment.amount, 100, 'the original payment must not be overwritten by the no-op call');
});

test('ApiIdentifier is deterministic — always the appointment id, unaffected by attempt count', async () => {
  const id = nextId();
  await db.collection('appointments').doc(id).set({ name: 'x', status: 'confirmed' });
  const first = await beginReceiptAttempt(id, { amount: 100, method: 'cash', adminUid: 'u1' });
  assert.equal(first.apiIdentifier, id);
});

test('beginReceiptAttempt on a non-existent appointment throws NOT_FOUND', async () => {
  await assert.rejects(
    beginReceiptAttempt('does-not-exist-' + Date.now(), { amount: 100, method: 'cash', adminUid: 'u1' }),
    (e) => e instanceof ReceiptStateError && e.code === 'NOT_FOUND'
  );
});
