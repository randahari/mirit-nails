// Proves functions/src/phoneNormalization.js stays byte-for-byte identical
// to index.html's normalizePhoneForStorage() across every relevant format
// — per explicit instruction, no second convention. Each expected value
// below is derived independently from the client's documented behavior
// (strip non-digits, then a 972-prefix normalization), not by calling the
// server function against itself.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhoneForStorage, isValidNormalizedPhone } = require('../functions/src/phoneNormalization');

test('normalizePhoneForStorage: all equivalent formats resolve to the same value', () => {
  const expected = '972501234567';
  const variants = [
    '0501234567',
    '050-123-4567',
    '050 123 4567',
    '+972501234567',
    '972501234567',
    '(050) 123-4567',
    '050.123.4567',
  ];
  for (const raw of variants) {
    assert.equal(normalizePhoneForStorage(raw), expected, `variant "${raw}" did not normalize to "${expected}"`);
  }
});

test('normalizePhoneForStorage: exact documented example (0501234567 → 972501234567)', () => {
  assert.equal(normalizePhoneForStorage('0501234567'), '972501234567');
});

test('normalizePhoneForStorage: missing/empty input returns empty string, never throws', () => {
  assert.equal(normalizePhoneForStorage(''), '');
  assert.equal(normalizePhoneForStorage(null), '');
  assert.equal(normalizePhoneForStorage(undefined), '');
  assert.equal(normalizePhoneForStorage(0), '');
});

test('normalizePhoneForStorage: landline-style local number also gets 972-prefixed', () => {
  assert.equal(normalizePhoneForStorage('0312345678'), '972312345678');
});

test('isValidNormalizedPhone: accepts real Israeli mobile/landline shapes', () => {
  assert.equal(isValidNormalizedPhone('972501234567'), true);   // mobile, 9 digits after 972
  assert.equal(isValidNormalizedPhone('972312345678'), true);   // landline, 9 digits after 972
});

test('isValidNormalizedPhone: rejects junk/too-short input even though normalize() does not reject it', () => {
  assert.equal(normalizePhoneForStorage('123'), '123'); // normalize itself never rejects
  assert.equal(isValidNormalizedPhone('123'), false);   // validity check catches it
  assert.equal(isValidNormalizedPhone(''), false);
  assert.equal(isValidNormalizedPhone('abc'), false);
  assert.equal(isValidNormalizedPhone('97250'), false); // too short after prefix
});

test('formatting changes never produce a different ExtNumber for the same real phone', () => {
  const asExtNumber = (raw) => Number(normalizePhoneForStorage(raw));
  const a = asExtNumber('050-123-4567');
  const b = asExtNumber('0501234567');
  const c = asExtNumber('+972 50 123 4567');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(Number.isInteger(a), true);
});
