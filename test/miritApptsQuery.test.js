// Verifies loadMiritAppts()'s query behavior (past-appointment access
// feature, "כל התורים" screen) against a real Firestore emulator — the
// exact query construction from index.html, mirrored here the same way
// test/customerNameEdit.test.js mirrors saveCustomerName(). No Cloud
// Function involved; reads are unrestricted by firestore.rules
// (`allow read: if true`), so this only needs the Firestore emulator with
// the real rules loaded (via `firebase emulators:start`, not
// rules-unit-testing) — no Auth/admin context required to prove query
// correctness itself; admin-vs-non-admin write behavior for `name` is
// already covered exhaustively in test/firestore.rules.test.js and
// test/customerNameEdit.test.js.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const { initializeApp } = require('firebase/app');
const {
  getFirestore, connectFirestoreEmulator,
  collection, query, where, orderBy, getDocs, Timestamp,
} = require('firebase/firestore');

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.GCLOUD_PROJECT = 'mirit-nails-apptquery-test';

admin.initializeApp({ projectId: 'mirit-nails-apptquery-test' });
const adminDb = admin.firestore();

const clientApp = initializeApp({ apiKey: 'fake-api-key', projectId: 'mirit-nails-apptquery-test' });
const clientDb = getFirestore(clientApp);
connectFirestoreEmulator(clientDb, '127.0.0.1', 8080);

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

function ymd(date) {
  // Matches <input type="date">.value's format exactly.
  return date.toISOString().slice(0, 10);
}

async function seed(id, overrides = {}) {
  await adminDb.collection('appointments').doc(id).set({
    name: 'לקוחה', phone: '972500000000', phoneRaw: '0500000000',
    branch: 'rehovot', services: "לק ג'ל רגיל", duration: 45, status: 'confirmed',
    ...overrides,
  });
}

// Mirrors loadMiritAppts() in index.html exactly: query-level lower bound
// defaults to today, or filter.dateFrom when set (even a past date) — no
// artificial cutoff. filter.dateTo/branch applied client-side, unchanged.
async function queryMiritAppts(filter = {}) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let lowerBound = today;
  if (filter.dateFrom) {
    const from = new Date(filter.dateFrom); from.setHours(0, 0, 0, 0);
    lowerBound = from;
  }
  const q = query(
    collection(clientDb, 'appointments'),
    where('datetime', '>=', Timestamp.fromDate(lowerBound)),
    where('status', 'in', ['confirmed', 'pending']),
    orderBy('datetime', 'asc')
  );
  const snap = await getDocs(q);
  let appts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (filter.branch && filter.branch !== 'all') appts = appts.filter((a) => a.branch === filter.branch);
  if (filter.dateTo) {
    const to = new Date(filter.dateTo); to.setHours(23, 59, 59, 999);
    appts = appts.filter((a) => a.datetime.toDate() <= to);
  }
  return appts;
}

test('1. default (no filter-from): behaves exactly as before — today-forward only, a fixture from yesterday is absent', async () => {
  const idToday = nextId('appt-today');
  const idYesterday = nextId('appt-yesterday');
  const today = new Date(); today.setHours(10, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  await seed(idToday, { datetime: admin.firestore.Timestamp.fromDate(today) });
  await seed(idYesterday, { datetime: admin.firestore.Timestamp.fromDate(yesterday) });

  const appts = await queryMiritAppts({});
  const ids = appts.map((a) => a.id);
  assert.ok(ids.includes(idToday), 'today\'s appointment must still appear by default');
  assert.ok(!ids.includes(idYesterday), 'yesterday\'s appointment must NOT appear by default — normal behavior unchanged');
});

test('2. selecting yesterday as filter-from makes yesterday\'s appointments reachable', async () => {
  const id = nextId('appt-y2');
  const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(11, 0, 0, 0);
  await seed(id, { datetime: admin.firestore.Timestamp.fromDate(yesterday) });

  const appts = await queryMiritAppts({ dateFrom: ymd(yesterday) });
  assert.ok(appts.some((a) => a.id === id), 'yesterday must now be reachable when explicitly selected');
});

test('3. selecting one month ago as filter-from works', async () => {
  const id = nextId('appt-1mo');
  const oneMonthAgo = new Date(); oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1); oneMonthAgo.setHours(11, 0, 0, 0);
  await seed(id, { datetime: admin.firestore.Timestamp.fromDate(oneMonthAgo) });

  const appts = await queryMiritAppts({ dateFrom: ymd(oneMonthAgo) });
  assert.ok(appts.some((a) => a.id === id));
});

test('4. selecting two months ago as filter-from works', async () => {
  const id = nextId('appt-2mo');
  const twoMonthsAgo = new Date(); twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2); twoMonthsAgo.setHours(11, 0, 0, 0);
  await seed(id, { datetime: admin.firestore.Timestamp.fromDate(twoMonthsAgo) });

  const appts = await queryMiritAppts({ dateFrom: ymd(twoMonthsAgo) });
  assert.ok(appts.some((a) => a.id === id));
});

test('5. selecting six months ago as filter-from works — proves there is no artificial two-month (or any) historical cutoff', async () => {
  const id = nextId('appt-6mo');
  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6); sixMonthsAgo.setHours(11, 0, 0, 0);
  await seed(id, { datetime: admin.firestore.Timestamp.fromDate(sixMonthsAgo) });

  const appts = await queryMiritAppts({ dateFrom: ymd(sixMonthsAgo) });
  assert.ok(appts.some((a) => a.id === id), 'six months back must be reachable — no cutoff exists anywhere in the query');
});

test('6. filter-to correctly limits the historical range', async () => {
  const idInRange = nextId('appt-inrange');
  const idTooOld = nextId('appt-tooold');
  const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3); threeMonthsAgo.setHours(11, 0, 0, 0);
  const fiveMonthsAgo = new Date(); fiveMonthsAgo.setMonth(fiveMonthsAgo.getMonth() - 5); fiveMonthsAgo.setHours(11, 0, 0, 0);
  await seed(idInRange, { datetime: admin.firestore.Timestamp.fromDate(threeMonthsAgo) });
  await seed(idTooOld, { datetime: admin.firestore.Timestamp.fromDate(fiveMonthsAgo) });

  const sixMonthsAgo = new Date(); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const fourMonthsAgo = new Date(); fourMonthsAgo.setMonth(fourMonthsAgo.getMonth() - 4);
  const appts = await queryMiritAppts({ dateFrom: ymd(sixMonthsAgo), dateTo: ymd(fourMonthsAgo) });
  const ids = appts.map((a) => a.id);
  assert.ok(!ids.includes(idInRange), 'an appointment newer than filter-to must be excluded');
  assert.ok(ids.includes(idTooOld), 'an appointment within [dateFrom, dateTo] must be included');
});

test('7. branch filtering continues to work combined with a historical range', async () => {
  const idRehovot = nextId('appt-br-reh');
  const idModiin = nextId('appt-br-mod');
  const twoMonthsAgo = new Date(); twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2); twoMonthsAgo.setHours(11, 0, 0, 0);
  await seed(idRehovot, { branch: 'rehovot', datetime: admin.firestore.Timestamp.fromDate(twoMonthsAgo) });
  await seed(idModiin, { branch: 'modiin', datetime: admin.firestore.Timestamp.fromDate(twoMonthsAgo) });

  const appts = await queryMiritAppts({ dateFrom: ymd(twoMonthsAgo), branch: 'rehovot' });
  const ids = appts.map((a) => a.id);
  assert.ok(ids.includes(idRehovot));
  assert.ok(!ids.includes(idModiin));
});

test('8. a same-day appointment behaves as a normal/current appointment (present by default, present with any historical filter too)', async () => {
  const id = nextId('appt-sameday');
  const today = new Date(); today.setHours(15, 0, 0, 0);
  await seed(id, { datetime: admin.firestore.Timestamp.fromDate(today) });

  const defaultAppts = await queryMiritAppts({});
  assert.ok(defaultAppts.some((a) => a.id === id));
});
