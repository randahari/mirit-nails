// Pure-unit coverage for buildHistoricalExternalComments() — the
// backend-authoritative historical/forgotten-receipt detection added to
// issueReceipt.js (past-appointment receipt-recovery feature). No
// Firestore/Auth/Functions emulator needed: the function is a pure
// calculation over an injected `now` and a fake Firestore-Timestamp-shaped
// `apptData.datetime` ({ toDate() }), exactly like phoneNormalization.js's
// own exported helpers are tested.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INVOICE4U_API_TOKEN_PRODUCTION = 'test-token-not-real';
delete process.env.INVOICE4U_MOCK_MODE;

const { buildHistoricalExternalComments } = require('../functions/src/issueReceipt');

// Fakes a Firestore Timestamp closely enough for this function's own use
// (`apptData.datetime.toDate()`), without needing firebase-admin at all.
function fakeTimestamp(isoString) {
  return { toDate: () => new Date(isoString) };
}

test('same-day appointment → null (normal flow, no note)', () => {
  const now = new Date('2026-09-02T10:00:00Z'); // 13:00 Israel time (IDT, UTC+3)
  const apptData = { datetime: fakeTimestamp('2026-09-02T06:00:00Z') }; // 09:00 Israel time, same day
  assert.equal(buildHistoricalExternalComments(apptData, now), null);
});

test('future appointment → null', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-09-10T06:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), null);
});

test('yesterday → exact wording with correct DD/MM/YYYY', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-09-01T09:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 01/09/2026');
});

test('one month ago → note produced, no cutoff', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-08-02T09:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 02/08/2026');
});

test('two months ago → note produced, no cutoff', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-07-02T09:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 02/07/2026');
});

test('six months ago (well past any conceivable cutoff) → still produces the note — proves there is no artificial historical limit', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-03-02T09:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 02/03/2026');
});

test('over a year ago → still produces the note (no cutoff whatsoever)', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2024-01-15T09:00:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 15/01/2024');
});

test('missing/invalid datetime → null, never guesses', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  assert.equal(buildHistoricalExternalComments({}, now), null);
  assert.equal(buildHistoricalExternalComments({ datetime: null }, now), null);
  assert.equal(buildHistoricalExternalComments({ datetime: {} }, now), null); // no .toDate()
  assert.equal(buildHistoricalExternalComments(null, now), null);
});

test('deterministic: same inputs always produce the exact same text — required for retry to reproduce an identical note', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = { datetime: fakeTimestamp('2026-08-15T09:00:00Z') };
  const first = buildHistoricalExternalComments(apptData, now);
  const second = buildHistoricalExternalComments(apptData, now);
  assert.equal(first, second);
  assert.equal(first, 'עבור טיפול שבוצע בתאריך 15/08/2026');
});

// ---- Israel-timezone correctness (the actual bug a naive UTC comparison
// would introduce) ----
test('Israel-timezone boundary: an appointment at 01:30 Israel time (IDT, UTC+3) is NOT wrongly classified as the previous UTC calendar day', () => {
  // 2026-09-01T22:30:00Z is 2026-09-02 01:30 in Israel (IDT). A naive UTC
  // comparison would see "2026-09-01" and misclassify this as historical
  // relative to a "now" also on 2026-09-02 Israel time — it must not.
  const now = new Date('2026-09-02T05:00:00Z'); // 08:00 Israel time, same Israel calendar day
  const apptData = { datetime: fakeTimestamp('2026-09-01T22:30:00Z') };
  assert.equal(buildHistoricalExternalComments(apptData, now), null, 'same Israel calendar day must not be treated as historical');
});

test('Israel-timezone boundary: an appointment genuinely on the previous Israel calendar day IS classified as historical', () => {
  const now = new Date('2026-09-02T05:00:00Z'); // 08:00 Israel time
  const apptData = { datetime: fakeTimestamp('2026-09-01T05:00:00Z') }; // 08:00 Israel time, previous day
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 01/09/2026');
});

// ---- payment.confirmedAt is never consulted ----
test('payment.confirmedAt is never read or used — only apptData.datetime matters', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  const apptData = {
    datetime: fakeTimestamp('2026-08-01T09:00:00Z'), // historical
    payment: { confirmedAt: fakeTimestamp('2026-09-02T09:59:00Z') }, // "today" — must NOT override the result
  };
  assert.equal(buildHistoricalExternalComments(apptData, now), 'עבור טיפול שבוצע בתאריך 01/08/2026');
});
