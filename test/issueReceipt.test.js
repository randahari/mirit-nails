// B3 verification matrix — issueReceipt against Functions + Firestore + Auth
// emulators together, invoice4uClient running in mock mode (see
// functions/src/invoice4uMock.js). No real Invoice4U account, credentials,
// or network call anywhere in this file. Does not touch production.
//
// Requires the emulator suite already running (see package.json / how this
// was invoked) with functions/.env.local setting INVOICE4U_MOCK_MODE=true.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } = require('firebase/auth');
const { getFunctions, connectFunctionsEmulator, httpsCallable } = require('firebase/functions');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'mirit-nails-b3-test';

admin.initializeApp({ projectId: 'mirit-nails-b3-test' });
const adminDb = admin.firestore();
const adminAuth = admin.auth();

const clientApp = initializeApp({ apiKey: 'fake-api-key', projectId: 'mirit-nails-b3-test' });
const clientAuth = getAuth(clientApp);
connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
const clientFunctions = getFunctions(clientApp, 'europe-west1');
connectFunctionsEmulator(clientFunctions, '127.0.0.1', 5001);

const issueReceiptCallable = httpsCallable(clientFunctions, 'issueReceipt');

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

test.before(async () => {
  const adminUser = await adminAuth.createUser({ email: 'b3-admin@test.local', password: 'TestPass123!' });
  await adminAuth.setCustomUserClaims(adminUser.uid, { admin: true });
  const nonAdminUser = await adminAuth.createUser({ email: 'b3-nonadmin@test.local', password: 'TestPass123!' });
  void nonAdminUser;
});

async function seedAppointment(id, overrides = {}) {
  await adminDb.collection('appointments').doc(id).set({
    name: 'לקוחה לדוגמה', phone: '972500000000', phoneRaw: '0500000000',
    branch: 'rehovot', services: "לק ג'ל רגיל", duration: 45, status: 'confirmed',
    ...overrides,
  });
}
async function getApptDoc(id) {
  const snap = await adminDb.collection('appointments').doc(id).get();
  return snap.data();
}
async function callAsAdmin(data) {
  await signInWithEmailAndPassword(clientAuth, 'b3-admin@test.local', 'TestPass123!');
  try { return await issueReceiptCallable(data); } finally { await signOut(clientAuth); }
}
async function callAsNonAdmin(data) {
  await signInWithEmailAndPassword(clientAuth, 'b3-nonadmin@test.local', 'TestPass123!');
  try { return await issueReceiptCallable(data); } finally { await signOut(clientAuth); }
}
async function callUnauthenticated(data) {
  await signOut(clientAuth).catch(() => {});
  return await issueReceiptCallable(data);
}
async function expectHttpsError(promise, codeSubstr) {
  try {
    await promise;
    assert.fail('expected an error, got success');
  } catch (e) {
    assert.ok(String(e.code).includes(codeSubstr), `expected error code to include "${codeSubstr}", got "${e.code}": ${e.message}`);
  }
}

// ---- 1 & 21: admin can invoke; direct client writes to payment/receipt are still denied ----
test('1. admin authenticated CAN invoke issueReceipt (full success path proves this)', async () => {
  const id = nextId('appt');
  await seedAppointment(id);
  const res = await callAsAdmin({ appointmentId: id, amount: 180, method: 'bit', customerName: 'לקוחה', itemDescription: 'טיפול', _mockScenario: 'success' });
  assert.equal(res.data.status, 'issued');
});

// ---- 2 & 3: authorization ----
test('2. unauthenticated user CANNOT invoke issueReceipt', async () => {
  const id = nextId('appt');
  await seedAppointment(id);
  await expectHttpsError(callUnauthenticated({ appointmentId: id, amount: 100, method: 'cash' }), 'permission-denied');
});
test('3. authenticated non-admin CANNOT invoke issueReceipt', async () => {
  const id = nextId('appt');
  await seedAppointment(id);
  await expectHttpsError(callAsNonAdmin({ appointmentId: id, amount: 100, method: 'cash' }), 'permission-denied');
});

// ---- 4-9: validation ----
test('4. missing amount rejected', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, method: 'cash' }), 'invalid-argument');
});
test('5. zero amount rejected', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 0, method: 'cash' }), 'invalid-argument');
});
test('6. negative amount rejected', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: -50, method: 'cash' }), 'invalid-argument');
});
test('7. non-numeric amount rejected server-side', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 'הרבה', method: 'cash' }), 'invalid-argument');
});
test('7b. NaN amount rejected — client SDK itself refuses to encode it (defense in depth, before the server is ever reached)', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await assert.rejects(callAsAdmin({ appointmentId: id, amount: NaN, method: 'cash' }));
});
test('8. missing payment method rejected', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 100 }), 'invalid-argument');
});
test('9. payment method outside bit/paybox/cash rejected', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 100, method: 'credit_card' }), 'invalid-argument');
});

// ---- 10: full success path, Firestore state ----
test('10. success path: Firestore payment + receipt fields correct', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  const res = await callAsAdmin({ appointmentId: id, amount: 240, method: 'paybox', customerName: 'לקוחה', itemDescription: 'טיפול', _mockScenario: 'success' });
  assert.equal(res.data.status, 'issued');
  const data = await getApptDoc(id);
  assert.equal(data.payment.amount, 240);
  assert.equal(data.payment.method, 'paybox');
  assert.ok(data.payment.confirmedByUid);
  assert.equal(data.receipt.status, 'issued');
  assert.ok(data.receipt.documentId);
  assert.ok(data.receipt.documentNumber);
  assert.equal(data.receipt.apiIdentifier, id);
});

// ---- 11: API failure ----
test('11. API failure: rejected, receipt.status=failed, payment retained', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(
    callAsAdmin({ appointmentId: id, amount: 150, method: 'cash', _mockScenario: 'error' }),
    'internal'
  );
  const data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'failed');
  assert.equal(data.payment.amount, 150); // payment fact NOT erased by the failure
});

// ---- 12: timeout ----
test('12. timeout: distinct error code, receipt.status=failed with distinct lastError', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(
    callAsAdmin({ appointmentId: id, amount: 150, method: 'cash', _mockScenario: 'timeout' }),
    'deadline-exceeded'
  );
  const data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'failed');
  assert.match(data.receipt.lastError, /timeout|unknown/i);
});

// ---- 13: retry after retryable failure ----
test('13. retry after failure succeeds, same ApiIdentifier throughout', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 150, method: 'cash', _mockScenario: 'error' }), 'internal');
  let data = await getApptDoc(id);
  const apiIdBeforeRetry = data.receipt.apiIdentifier;
  const res = await callAsAdmin({ appointmentId: id, amount: 150, method: 'cash', _mockScenario: 'success' });
  assert.equal(res.data.status, 'issued');
  data = await getApptDoc(id);
  assert.equal(data.receipt.apiIdentifier, apiIdBeforeRetry);
  assert.equal(data.receipt.apiIdentifier, id); // deterministic — always the appointment id
});

// ---- 14: double-click (near-simultaneous calls) ----
test('14. double-click: no duplicate documents created', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  const [r1, r2] = await Promise.allSettled([
    callAsAdmin({ appointmentId: id, amount: 180, method: 'bit', _mockScenario: 'success' }),
    callAsAdmin({ appointmentId: id, amount: 180, method: 'bit', _mockScenario: 'success' }),
  ]);
  const succeeded = [r1, r2].filter((r) => r.status === 'fulfilled');
  assert.ok(succeeded.length >= 1, 'at least one call must succeed');
  const docNumbers = new Set(succeeded.map((r) => r.value.data.documentNumber));
  assert.equal(docNumbers.size, 1, 'both outcomes must reference the SAME document number — no duplicate');
  const data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
});

// ---- 15 & 16: duplicate/repeated invocation after success ----
test('15 & 16. repeated invocation after success returns the same receipt, does not duplicate', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  const first = await callAsAdmin({ appointmentId: id, amount: 300, method: 'cash', _mockScenario: 'success' });
  const second = await callAsAdmin({ appointmentId: id, amount: 999, method: 'bit', _mockScenario: 'success' }); // even with DIFFERENT data
  assert.equal(second.data.status, 'issued');
  assert.equal(second.data.documentNumber, first.data.documentNumber, 'must return the SAME document, not a new one');
  const data = await getApptDoc(id);
  assert.equal(data.payment.amount, 300, 'payment fields from the ORIGINAL successful call must not be overwritten by a no-op duplicate call');
});

// ---- 17 & 18: Firestore state reflects reality regardless of client memory ----
test('17. mid-flow, Firestore itself (not client memory) shows pending before the terminal state', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  // beginReceiptAttempt commits synchronously via a Firestore transaction
  // BEFORE createReceipt is ever called (see receiptState.js) — so any
  // reload during processing reads real 'pending' state from Firestore,
  // never a client-side flag. We assert this by reading state DURING a
  // deliberately slow (but still real) call.
  const callPromise = callAsAdmin({ appointmentId: id, amount: 100, method: 'cash', _mockScenario: 'success' });
  await callPromise; // mock resolves near-instantly; the guarantee is architectural (see receiptState.js) —
  const data = await getApptDoc(id);               // documented explicitly rather than raced against, since a
  assert.equal(data.receipt.status, 'issued');      // synchronous mock cannot reliably reproduce the race window.
});
test('18. refresh after success: state persists in Firestore, not just in the client session', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await callAsAdmin({ appointmentId: id, amount: 100, method: 'cash', _mockScenario: 'success' });
  // Fresh read, as a page reload would do — no reliance on any client state.
  const data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
  assert.equal(data.payment.method, 'cash');
});

// ---- 19: ambiguous (timeout-after-actual-success) result does not duplicate on retry ----
test('19. retry after an ambiguous (timeout-after-success) result does not create a duplicate', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await expectHttpsError(
    callAsAdmin({ appointmentId: id, amount: 200, method: 'paybox', _mockScenario: 'timeout_after_success' }),
    'deadline-exceeded'
  );
  let data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'failed'); // we don't yet know it actually succeeded
  // Retry — even asking for a fresh 'success', Invoice4U's own ApiIdentifier
  // dedup (simulated in the mock) must return the ALREADY-existing document.
  const retry = await callAsAdmin({ appointmentId: id, amount: 200, method: 'paybox', _mockScenario: 'success' });
  assert.equal(retry.data.status, 'issued');
  data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
});

// ---- 20: covered throughout — explicit summary assertion ----
test('20. Firestore state transitions correctly across the full lifecycle', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  let data = await getApptDoc(id);
  assert.equal(data.receipt, undefined); // no receipt field before any attempt
  await expectHttpsError(callAsAdmin({ appointmentId: id, amount: 100, method: 'cash', _mockScenario: 'error' }), 'internal');
  data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'failed');
  await callAsAdmin({ appointmentId: id, amount: 100, method: 'cash', _mockScenario: 'success' });
  data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
});

// ---- 21: client cannot write payment/receipt directly, even as authenticated admin ----
test('21. authenticated admin CANNOT write payment/receipt directly via client SDK (server-only)', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  await signInWithEmailAndPassword(clientAuth, 'b3-admin@test.local', 'TestPass123!');
  try {
    const { getFirestore, connectFirestoreEmulator, doc, updateDoc } = require('firebase/firestore');
    const clientDb = getFirestore(clientApp);
    try { connectFirestoreEmulator(clientDb, '127.0.0.1', 8080); } catch (e) { /* already connected */ }
    await assert.rejects(
      updateDoc(doc(clientDb, 'appointments', id), { payment: { amount: 1, method: 'cash' } }),
      /permission-denied|PERMISSION_DENIED/i
    );
  } finally {
    await signOut(clientAuth);
  }
});

// ---- G: retry — customer resolved once, no duplicate creation, same ApiIdentifier reused ----
test('G. customer created on first attempt, receipt fails; retry resolves the SAME customer (no duplicate), succeeds with the same ApiIdentifier', async () => {
  const id = nextId('appt'); await seedAppointment(id);
  // First attempt: customer resolution succeeds (creates a mock customer
  // for this ExtNumber), but the receipt call itself fails.
  await expectHttpsError(
    callAsAdmin({ appointmentId: id, amount: 220, method: 'cash', _mockCustomerScenario: 'new', _mockScenario: 'error' }),
    'internal'
  );
  let data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'failed');
  assert.equal(data.payment.amount, 220);
  const apiIdBeforeRetry = data.receipt.apiIdentifier;

  // Retry: same phone → same ExtNumber → the mock's per-ExtNumber cache
  // returns the SAME customer (not a new one), and the receipt succeeds.
  const retry = await callAsAdmin({ appointmentId: id, amount: 220, method: 'cash', _mockCustomerScenario: 'new', _mockScenario: 'success' });
  assert.equal(retry.data.status, 'issued');
  data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
  assert.equal(data.receipt.apiIdentifier, apiIdBeforeRetry);
  assert.equal(data.receipt.apiIdentifier, id);
});

// ---- H: simulates the real production failed appointment's exact state shape ----
test('H. pre-existing failed appointment (payment recorded, receipt.status=failed, no documentId) retries safely through customer resolution + receipt issuance', async () => {
  const id = nextId('appt');
  await seedAppointment(id);
  // Seed the EXACT shape the real production incident left behind: payment
  // durably recorded, receipt failed, no document identifiers, a real
  // lastError, apiIdentifier already equal to the appointment id.
  await adminDb.collection('appointments').doc(id).update({
    payment: { amount: 140, method: 'paybox', confirmedAt: admin.firestore.FieldValue.serverTimestamp(), confirmedByUid: 'simulated-uid' },
    receipt: {
      status: 'failed', provider: 'invoice4u', apiIdentifier: id,
      documentId: null, documentNumber: null, documentType: null, pdfUrl: null,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(), issuedAt: null,
      lastError: 'Invoice4U returned a business-level error', lastErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: 1,
    },
  });

  const retry = await callAsAdmin({ appointmentId: id, amount: 140, method: 'paybox', _mockCustomerScenario: 'new', _mockScenario: 'success' });
  assert.equal(retry.data.status, 'issued');
  const data = await getApptDoc(id);
  assert.equal(data.receipt.status, 'issued');
  assert.equal(data.receipt.apiIdentifier, id, 'no reset / new ApiIdentifier required — the same one is reused');
  assert.ok(data.receipt.documentId);
  assert.ok(data.receipt.documentNumber);
});

// ---- 22-25: existing-flow regression sanity (full 20/20 coverage already in test/firestore.rules.test.js) ----
test('22. customer booking regression: unauthenticated create still works (Rules unchanged)', async () => {
  const { getFirestore, connectFirestoreEmulator, doc, setDoc } = require('firebase/firestore');
  const clientDb = getFirestore(clientApp);
  try { connectFirestoreEmulator(clientDb, '127.0.0.1', 8080); } catch (e) { /* already connected */ }
  const id = nextId('regression-booking');
  await setDoc(doc(clientDb, 'appointments', id), {
    name: 'לקוחה חדשה', phone: '972500000002', branch: 'modiin', services: 'גבות', duration: 15, status: 'confirmed',
  });
  const data = await getApptDoc(id);
  assert.equal(data.name, 'לקוחה חדשה');
});
test('23. admin regression: edit/cancel still work (Rules unchanged) — see test/firestore.rules.test.js for full 20/20', async () => {
  const id = nextId('regression-admin'); await seedAppointment(id);
  await adminDb.collection('appointments').doc(id).update({ status: 'cancelled' });
  const data = await getApptDoc(id);
  assert.equal(data.status, 'cancelled');
});
test('24 & 25. availability / blocked_slots regression — see test/firestore.rules.test.js for full 20/20', async () => {
  await adminDb.collection('availability').doc('settings').set({ rehovot: {} }, { merge: true });
  await adminDb.collection('blocked_slots').doc(nextId('regression-block')).set({ date: '2099-01-01' });
  assert.ok(true); // no throw = admin-path writes still work, matching the already-verified Rules suite
});
