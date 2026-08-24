// Focused regression test for the diagnostic logging added to the
// INVOICE4U_ERROR branch (HTTP 200 + Errors[] with at least one ID != 134).
// This is the branch the third real B4B attempt hit after the date-format
// fix resolved the earlier HTTP 500 — previously unlogged.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FAKE_TOKEN = 'super-secret-invoice4u-token-do-not-leak';
process.env.INVOICE4U_API_TOKEN_PRODUCTION = FAKE_TOKEN;
delete process.env.INVOICE4U_MOCK_MODE;

const { createReceipt } = require('../functions/src/invoice4uClient');

const baseReq = {
  environment: 'production',
  documentType: 2,
  apiIdentifier: 'appt-business-error-test',
  clientId: 12345,
  itemDescription: 'Manicure',
  amount: 140,
  paymentType: 9,
};

function withStubbedFetch(responseBody, fn) {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responseBody),
    json: async () => responseBody,
  });
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  return fn(() => loggedCalls).finally(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });
}

test('HTTP 200 + Errors[{ID != 134}]: the business error is logged, existing throw/return behavior unchanged', async () => {
  const responseBody = {
    d: {
      Errors: [{ ID: 56, Error: 'PaymentAmountDoesntMatchItemsAmount', Message: 'Amounts do not reconcile', Description: 'see docs' }],
    },
  };

  await withStubbedFetch(responseBody, async (getLoggedCalls) => {
    // 1 & 4: existing throw behavior (code, message, invoice4uErrors) is unchanged.
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVOICE4U_ERROR');
        assert.equal(err.message, 'PaymentAmountDoesntMatchItemsAmount');
        assert.deepEqual(err.invoice4uErrors, responseBody.d.Errors);
        return true;
      }
    );

    // 2: the ID and error message are captured in the new log line.
    const logged = getLoggedCalls();
    const businessErrorLog = logged.find((args) => args[0] === '[invoice4uClient] Invoice4U returned a business-level error');
    assert.ok(businessErrorLog, 'expected the new business-error diagnostic log line');
    const payload = businessErrorLog[1];
    assert.equal(payload.apiIdentifier, 'appt-business-error-test');
    assert.equal(payload.errors[0].ID, 56);
    assert.equal(payload.errors[0].Error, 'PaymentAmountDoesntMatchItemsAmount');
    assert.equal(payload.errors[0].Message, 'Amounts do not reconcile');
    assert.equal(payload.errors[0].Description, 'see docs');

    // 3: no token/secret anywhere in what was logged.
    const loggedText = JSON.stringify(logged);
    assert.doesNotMatch(loggedText, new RegExp(FAKE_TOKEN));
  });
});

test('error 134 (DocumentAlreadyCreated) still treated as idempotent success — no log, no throw', async () => {
  const responseBody = {
    d: {
      ID: 'doc-existing', DocumentNumber: 2002, DocumentType: 2,
      PrintOriginalPDFLink: null, Errors: [{ ID: 134, Error: 'DocumentAlreadyCreated' }],
    },
  };

  await withStubbedFetch(responseBody, async (getLoggedCalls) => {
    const result = await createReceipt({ ...baseReq });
    assert.equal(result.documentId, 'doc-existing');
    assert.equal(result.wasIdempotentDuplicate, true);

    const logged = getLoggedCalls();
    const businessErrorLog = logged.find((args) => args[0] === '[invoice4uClient] Invoice4U returned a business-level error');
    assert.equal(businessErrorLog, undefined, 'error 134 must not trigger the business-error diagnostic log');
  });
});
