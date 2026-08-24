// Regression coverage for the root cause of the first two real B4B
// failures (both HTTP 500): Invoice4U's WCF backend rejects ISO 8601
// DateTime values and requires the legacy ASP.NET AJAX JSON date format
// instead — /Date(<milliseconds-since-epoch>)/. Confirmed via the actual
// provider error captured by invoice4uClient.js's diagnostic logging:
// "DateTime content '...' does not start with '/Date(' and end with ')/'
// as required for JSON."
//
// This test captures the real outgoing request body (via a stubbed
// global.fetch) and asserts Payments[0].Date is in the required format —
// and explicitly asserts it is NOT ISO 8601, so a regression back to
// `.toISOString()` fails loudly rather than silently.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INVOICE4U_API_TOKEN_PRODUCTION = 'test-token-not-real';
delete process.env.INVOICE4U_MOCK_MODE;

const { createReceipt } = require('../functions/src/invoice4uClient');

const baseReq = {
  environment: 'production',
  documentType: 2,
  apiIdentifier: 'appt-date-format-test',
  clientId: 12345,
  itemDescription: 'Manicure',
  amount: 140,
  paymentType: 9,
};

function withCapturedRequest(responseBody, fn) {
  let capturedBody;
  const originalFetch = global.fetch;
  global.fetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(responseBody),
      json: async () => responseBody,
    };
  };
  return fn(() => capturedBody).finally(() => {
    global.fetch = originalFetch;
  });
}

test('Payments[0].Date is sent as /Date(ms)/, not ISO 8601', async () => {
  const successBody = {
    d: {
      ID: 'doc-1', DocumentNumber: 1001, DocumentType: 2,
      PrintOriginalPDFLink: null, Errors: [],
    },
  };

  await withCapturedRequest(successBody, async (getCapturedBody) => {
    await createReceipt({ ...baseReq });
    const body = getCapturedBody();
    const date = body.doc.Payments[0].Date;

    // Must match /Date(<digits>)/ exactly.
    assert.match(date, /^\/Date\(\d+\)\/$/, `expected WCF JSON date format, got: ${date}`);

    // Must NOT be ISO 8601 (the exact bug that caused the real failures).
    assert.doesNotMatch(date, /^\d{4}-\d{2}-\d{2}T/, 'regressed back to ISO 8601 — this is the exact bug that broke real Invoice4U calls');

    // The embedded milliseconds must be a sane, recent timestamp (not 0,
    // not NaN, not something from a broken Date object).
    const ms = Number(date.match(/^\/Date\((\d+)\)\/$/)[1]);
    assert.ok(Number.isFinite(ms) && ms > 1_700_000_000_000, `embedded ms-since-epoch looks wrong: ${ms}`);
  });
});

test('other request fields are unaffected by the date-format fix', async () => {
  const successBody = { d: { ID: 'doc-2', DocumentNumber: 1002, DocumentType: 2, PrintOriginalPDFLink: null, Errors: [] } };

  await withCapturedRequest(successBody, async (getCapturedBody) => {
    await createReceipt({ ...baseReq });
    const body = getCapturedBody();

    assert.equal(body.doc.DocumentType, 2);
    assert.equal(body.doc.ApiIdentifier, 'appt-date-format-test');
    assert.equal(body.doc.ClientID, 12345);
    assert.equal(body.doc.GeneralCustomer, undefined, 'GeneralCustomer must never be sent for DocumentType=2 (Error 38)');
    assert.deepEqual(body.doc.Items, [{ Name: 'Manicure', Quantity: 1, Price: 140 }]);
    assert.equal(body.doc.Payments[0].PaymentType, 9);
    assert.equal(body.doc.Payments[0].Amount, 140);
    assert.equal(body.doc.Currency, 'ILS');
  });
});
