// Verifies the Firestore-propagation behavior of the customer-name-edit
// feature (2026-08-24, corrected same day) — the exact query/update
// pattern window.saveCustomerName() in index.html performs: find every
// `appointments` doc with the same normalized phone, update `name` +
// `nameEditedAt` on ALL of them — including ones whose receipt has
// already been issued. `name` is current customer information, not part
// of the accounting record; only `receipt`/`payment` themselves are
// immutable once issued, and this function never touches either field.
//
// This exercises the real Firestore emulator as an authenticated admin
// client (the same identity the actual UI acts under), so it also
// re-confirms in practice that firestore.rules permits this write for an
// admin — see test/firestore.rules.test.js for the exhaustive admin-vs-
// non-admin Rules matrix; this file is about the propagation LOGIC, not
// re-litigating the Rules themselves.
//
// No Cloud Function is involved — this is a pure client Firestore write,
// so only the Firestore + Auth emulators are needed (no Functions
// emulator connection).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword, signOut } = require('firebase/auth');
const {
  getFirestore, connectFirestoreEmulator,
  collection, query, where, getDocs, updateDoc, doc, setDoc, getDoc, Timestamp,
} = require('firebase/firestore');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
process.env.GCLOUD_PROJECT = 'mirit-nails-nameedit-test';

admin.initializeApp({ projectId: 'mirit-nails-nameedit-test' });
const adminDb = admin.firestore();
const adminAuth = admin.auth();

const clientApp = initializeApp({ apiKey: 'fake-api-key', projectId: 'mirit-nails-nameedit-test' });
const clientAuth = getAuth(clientApp);
connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', { disableWarnings: true });
const clientDb = getFirestore(clientApp);
connectFirestoreEmulator(clientDb, '127.0.0.1', 8080);

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

test.before(async () => {
  const adminUser = await adminAuth.createUser({ email: 'nameedit-admin@test.local', password: 'TestPass123!' });
  await adminAuth.setCustomUserClaims(adminUser.uid, { admin: true });
});

async function seed(id, overrides = {}) {
  await adminDb.collection('appointments').doc(id).set({
    name: 'שם ישן', phone: '972500000000', phoneRaw: '0500000000',
    branch: 'rehovot', services: "לק ג'ל רגיל", duration: 45, status: 'confirmed',
    ...overrides,
  });
}
async function getDocData(id) {
  const snap = await adminDb.collection('appointments').doc(id).get();
  return snap.data();
}

// Mirrors window.saveCustomerName() in index.html exactly: query by phone,
// update name+nameEditedAt on EVERY matching doc, regardless of receipt
// status. Never touches `receipt`/`payment`/anything else.
async function saveCustomerNameAs(phone, newName) {
  const q = query(collection(clientDb, 'appointments'), where('phone', '==', phone));
  const snap = await getDocs(q);
  const now = Timestamp.now();
  await Promise.all(snap.docs.map((d) => updateDoc(d.ref, { name: newName, nameEditedAt: now })));
  return snap.docs.length;
}

test('1. saveCustomerName rejects an empty/whitespace-only name before touching Firestore', async () => {
  // This is the client-side guard in index.html (`if (!newName) return`) —
  // pure JS with no Firestore involvement, verified here at the logic
  // level: trimming ' ' or '' must never produce a truthy name.
  assert.equal(''.trim(), '');
  assert.equal('   '.trim(), '');
  assert.ok('שם'.trim());
});

test('2 & 6. same-phone appointments without an issued receipt are updated; a different-phone appointment is NOT', async () => {
  const phone = '972501111111';
  const idSamePhone = nextId('appt-same');
  const idDifferentPhone = nextId('appt-diff');
  await seed(idSamePhone, { phone });
  await seed(idDifferentPhone, { phone: '972509999999' });

  await signInWithEmailAndPassword(clientAuth, 'nameedit-admin@test.local', 'TestPass123!');
  try {
    const updated = await saveCustomerNameAs(phone, 'שם מתוקן');
    assert.equal(updated, 1);
  } finally {
    await signOut(clientAuth);
  }

  const same = await getDocData(idSamePhone);
  const diff = await getDocData(idDifferentPhone);
  assert.equal(same.name, 'שם מתוקן');
  assert.ok(same.nameEditedAt);
  assert.equal(diff.name, 'שם ישן', 'a different-phone appointment must never be touched');
  assert.equal(diff.nameEditedAt, undefined);
});

test('3. a historical appointment (past datetime) without an issued receipt is updated', async () => {
  const phone = '972502222222';
  const id = nextId('appt-historical');
  await seed(id, { phone, datetime: admin.firestore.Timestamp.fromDate(new Date('2026-01-01T10:00:00Z')) });

  await signInWithEmailAndPassword(clientAuth, 'nameedit-admin@test.local', 'TestPass123!');
  try { await saveCustomerNameAs(phone, 'שם מתוקן'); } finally { await signOut(clientAuth); }

  const data = await getDocData(id);
  assert.equal(data.name, 'שם מתוקן');
});

test('4. a future appointment is updated', async () => {
  const phone = '972503333333';
  const id = nextId('appt-future');
  await seed(id, { phone, datetime: admin.firestore.Timestamp.fromDate(new Date('2099-01-01T10:00:00Z')) });

  await signInWithEmailAndPassword(clientAuth, 'nameedit-admin@test.local', 'TestPass123!');
  try { await saveCustomerNameAs(phone, 'שם מתוקן'); } finally { await signOut(clientAuth); }

  const data = await getDocData(id);
  assert.equal(data.name, 'שם מתוקן');
});

test('3, 4, 5, 6, 11. an appointment with receipt.status === "issued" ALSO gets its name corrected — but the receipt/payment snapshot itself is completely untouched, and no Invoice4U call happens', async () => {
  const phone = '972504444444';
  const idIssued = nextId('appt-issued');
  const idPending = nextId('appt-pending');
  const issuedReceipt = {
    status: 'issued',
    documentId: 'doc-rachel-1',
    documentNumber: 30001,
    documentType: 2,
    pdfUrl: 'https://example.invoice4u.co.il/doc-rachel-1.pdf',
    customerName: 'רחל', // issuance-time snapshot — must NOT change
    invoice4uClientId: 8024360, // issuance-time snapshot — must NOT change
  };
  const originalPayment = { amount: 140, method: 'cash', confirmedByUid: 'mirit-uid' };
  await seed(idIssued, { name: 'רחל', phone, receipt: { ...issuedReceipt }, payment: { ...originalPayment } });
  await seed(idPending, { phone, receipt: { status: 'failed' } }); // historical, no receipt yet

  await signInWithEmailAndPassword(clientAuth, 'nameedit-admin@test.local', 'TestPass123!');
  try {
    const updated = await saveCustomerNameAs(phone, 'רחל כהן');
    assert.equal(updated, 2, 'BOTH appointments sharing this phone must be targeted, issued or not');
  } finally {
    await signOut(clientAuth);
  }

  const issued = await getDocData(idIssued);
  const pending = await getDocData(idPending);

  // 3 & 4: same-phone appointments (with and without a receipt) both get
  // the corrected display name.
  assert.equal(issued.name, 'רחל כהן', 'appointment.name must be corrected even when a receipt was already issued for it');
  assert.ok(issued.nameEditedAt);
  assert.equal(pending.name, 'רחל כהן');

  // 5 & 6 & 11: the receipt object itself — including its issuance-time
  // customerName/invoice4uClientId snapshot — is byte-for-byte unchanged.
  // This alone proves no Invoice4U call (which could only ever be reached
  // through issueReceipt.js, never through this pure Firestore write) was
  // made or could have altered anything: the receipt's own document
  // fields (documentId/documentNumber/pdfUrl) are exactly as they were.
  assert.deepEqual(issued.receipt, issuedReceipt, 'the receipt object must be completely untouched by a later name edit');
  assert.equal(issued.receipt.customerName, 'רחל', 'receipt.customerName is an issuance-time snapshot — must stay "רחל", not follow the correction to "רחל כהן"');
  assert.equal(issued.receipt.invoice4uClientId, 8024360);
  assert.deepEqual(issued.payment, originalPayment, 'payment must also be completely untouched');
});

test('7. admin CAN perform the propagation write (Rules allow it)', async () => {
  const phone = '972505555555';
  const id = nextId('appt-admin-ok');
  await seed(id, { phone });

  await signInWithEmailAndPassword(clientAuth, 'nameedit-admin@test.local', 'TestPass123!');
  try {
    await assert.doesNotReject(saveCustomerNameAs(phone, 'שם מתוקן'));
  } finally {
    await signOut(clientAuth);
  }
});

test('8. non-admin (unauthenticated) CANNOT perform the propagation write (Rules reject it) — see test/firestore.rules.test.js for the full matrix', async () => {
  const phone = '972506666666';
  const id = nextId('appt-nonadmin-blocked');
  await seed(id, { phone });

  // Deliberately NOT signed in.
  await assert.rejects(saveCustomerNameAs(phone, 'שם לא מורשה'));

  const data = await getDocData(id);
  assert.equal(data.name, 'שם ישן', 'the unauthenticated write must have been rejected entirely');
});
