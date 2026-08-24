// B4A critical safety requirement: proves that even a fully authorized,
// fully valid request CANNOT reach beginReceiptAttempt/Invoice4U while
// RECEIPT_ISSUANCE_ENABLED is not 'true' — the exact condition B4A deploys
// under. Run with functions/.env.local temporarily set to
// RECEIPT_ISSUANCE_ENABLED=false (see how this suite is invoked) to
// reproduce the B4A deployed condition locally before ever touching
// production.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'mirit-nails-gate-test';

admin.initializeApp({ projectId: 'mirit-nails-gate-test' });
const adminDb = admin.firestore();
const adminAuth = admin.auth();

const clientApp = initializeApp({ apiKey: 'fake-api-key', projectId: 'mirit-nails-gate-test' });
const clientAuth = getAuth(clientApp);
connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
const clientFunctions = getFunctions(clientApp, 'europe-west1');
connectFunctionsEmulator(clientFunctions, '127.0.0.1', 5001);
const issueReceiptCallable = httpsCallable(clientFunctions, 'issueReceipt');

test.before(async () => {
  const adminUser = await adminAuth.createUser({ email: 'gate-admin@test.local', password: 'TestPass123!' });
  await adminAuth.setCustomUserClaims(adminUser.uid, { admin: true });
});

test('a FULLY VALID, fully authorized request is blocked before touching Invoice4U or Firestore payment/receipt fields', async () => {
  const id = 'gate-appt-' + Date.now();
  await adminDb.collection('appointments').doc(id).set({
    name: 'לקוחה', phone: '972500000000', branch: 'rehovot', services: 'טיפול', duration: 30, status: 'confirmed',
  });

  await signInWithEmailAndPassword(clientAuth, 'gate-admin@test.local', 'TestPass123!');
  try {
    await assert.rejects(
      issueReceiptCallable({ appointmentId: id, amount: 200, method: 'bit', customerName: 'לקוחה', itemDescription: 'טיפול' }),
      (e) => {
        assert.equal(e.code, 'functions/failed-precondition');
        assert.match(e.message, /not yet enabled/);
        return true;
      }
    );
  } finally {
    await signOut(clientAuth);
  }

  // Zero side effects — not even the payment fact was written. This gate
  // sits BEFORE beginReceiptAttempt specifically so a readiness/health
  // check never touches a real appointment's data at all.
  const doc = await adminDb.collection('appointments').doc(id).get();
  assert.equal(doc.data().payment, undefined, 'no payment field must be written while the gate is closed');
  assert.equal(doc.data().receipt, undefined, 'no receipt field must be written while the gate is closed');
});

test('authorization checks still run BEFORE the gate — unauthenticated still rejected on auth grounds, not the gate', async () => {
  const id = 'gate-appt-unauth-' + Date.now();
  await adminDb.collection('appointments').doc(id).set({ name: 'x', status: 'confirmed' });
  await signOut(clientAuth).catch(() => {});
  await assert.rejects(
    issueReceiptCallable({ appointmentId: id, amount: 100, method: 'cash' }),
    (e) => { assert.equal(e.code, 'functions/permission-denied'); return true; }
  );
});

test('validation still runs BEFORE the gate — invalid payload rejected on validation grounds, not the gate', async () => {
  const id = 'gate-appt-invalid-' + Date.now();
  await adminDb.collection('appointments').doc(id).set({ name: 'x', status: 'confirmed' });
  await signInWithEmailAndPassword(clientAuth, 'gate-admin@test.local', 'TestPass123!');
  try {
    await assert.rejects(
      issueReceiptCallable({ appointmentId: id, amount: -5, method: 'cash' }),
      (e) => { assert.equal(e.code, 'functions/invalid-argument'); return true; }
    );
  } finally {
    await signOut(clientAuth);
  }
});
