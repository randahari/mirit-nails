// Focused regression test for the FINAL, proven response shape: Invoice4U
// wraps its response in a top-level "d" envelope (ASP.NET AJAX/WCF
// anti-hijacking convention), and "d" directly IS the result object — no
// further nested "CreateDocumentWithIdentifierValidationResult" wrapper
// exists inside it. Proven by the sixth real B4B failure: the logged
// `receivedKeysInD` was the entire Document object's field set (ID,
// DocumentNumber, Errors, GeneralCustomer, Items, Payments,
// PrintOriginalPDFLink, IsSuccess, ~100+ more) — i.e. "d" itself, not a
// further-nested key inside it. This supersedes the fifth-failure fix's
// (incorrect) assumption of a second wrapper layer.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.INVOICE4U_API_TOKEN_PRODUCTION = 'test-token-not-real';
delete process.env.INVOICE4U_MOCK_MODE;

const { createReceipt } = require('../functions/src/invoice4uClient');

const baseReq = {
  environment: 'production',
  documentType: 2,
  apiIdentifier: 'appt-d-envelope-test',
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

test('{ d: { ID, DocumentNumber, Errors: [], ... } } — real success shape, correct mapping', async () => {
  const responseBody = {
    d: {
      ID: 'doc-real-999',
      DocumentNumber: 6001,
      DocumentType: 2,
      PrintOriginalPDFLink: 'https://invoice4u.example/doc-real-999.pdf',
      IsSuccess: true,
      Errors: [],
    },
  };

  await withStubbedFetch(responseBody, async () => {
    const result = await createReceipt({ ...baseReq });
    assert.equal(result.documentId, 'doc-real-999');
    assert.equal(result.documentNumber, 6001);
    assert.equal(result.documentType, 2);
    assert.equal(result.pdfUrl, 'https://invoice4u.example/doc-real-999.pdf');
    assert.equal(result.wasIdempotentDuplicate, false);
  });
});

test('business Errors[] are read directly from d (no intermediate wrapper)', async () => {
  const responseBody = {
    d: {
      IsSuccess: false,
      Errors: [{ ID: 56, Error: 'PaymentAmountDoesntMatchItemsAmount', Message: 'mismatch', Description: 'see docs' }],
    },
  };

  await withStubbedFetch(responseBody, async (getLoggedCalls) => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVOICE4U_ERROR');
        assert.equal(err.message, 'PaymentAmountDoesntMatchItemsAmount');
        assert.deepEqual(err.invoice4uErrors, responseBody.d.Errors);
        return true;
      }
    );
    const logged = getLoggedCalls();
    const businessErrorLog = logged.find((args) => args[0] === '[invoice4uClient] Invoice4U returned a business-level error');
    assert.ok(businessErrorLog, 'expected the business-error diagnostic to fire, reading Errors[] directly from d');
    assert.equal(businessErrorLog[1].errors[0].ID, 56);
  });
});

test('error 134 (DocumentAlreadyCreated) is read directly from d — idempotent success with real ID/DocumentNumber', async () => {
  const responseBody = {
    d: {
      ID: 'doc-existing-654', DocumentNumber: 6002, DocumentType: 2,
      PrintOriginalPDFLink: null, IsSuccess: false,
      Errors: [{ ID: 134, Error: 'DocumentAlreadyCreated' }],
    },
  };

  await withStubbedFetch(responseBody, async () => {
    const result = await createReceipt({ ...baseReq });
    assert.equal(result.documentId, 'doc-existing-654');
    assert.equal(result.documentNumber, 6002);
    assert.equal(result.wasIdempotentDuplicate, true);
  });
});

test('missing "d" entirely — rejected, logged safely, never reaches success', async () => {
  const responseBody = { SomethingElse: true };

  await withStubbedFetch(responseBody, async (getLoggedCalls) => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVALID_RESPONSE_SHAPE');
        assert.match(err.message, /"d" envelope/);
        return true;
      }
    );
    const logged = getLoggedCalls();
    const envelopeLog = logged.find((args) => args[0] === '[invoice4uClient] Invoice4U response missing expected "d" envelope');
    assert.ok(envelopeLog);
    assert.deepEqual(envelopeLog[1].receivedTopLevelKeys, ['SomethingElse']);
  });
});

test('malformed "d" (not an object) — rejected, not a crash', async () => {
  const responseBody = { d: 'not-an-object' };

  await withStubbedFetch(responseBody, async () => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVALID_RESPONSE_SHAPE');
        assert.match(err.message, /"d" envelope/);
        return true;
      }
    );
  });
});

test('missing ID/DocumentNumber inside d cannot return success (the exact bug that crashed recordReceiptSuccess)', async () => {
  const responseBody = { d: { Errors: [], IsSuccess: true } }; // no ID, no DocumentNumber

  await withStubbedFetch(responseBody, async (getLoggedCalls) => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVALID_RESPONSE_SHAPE');
        assert.match(err.message, /missing ID\/DocumentNumber/);
        return true;
      }
    );
    const logged = getLoggedCalls();
    const missingFieldsLog = logged.find((args) => args[0] === '[invoice4uClient] Invoice4U success response missing ID/DocumentNumber');
    assert.ok(missingFieldsLog);
    assert.equal(missingFieldsLog[1].hasId, false);
    assert.equal(missingFieldsLog[1].hasDocumentNumber, false);
  });
});

test('the now-known INCORRECT shape { d: { CreateDocumentWithIdentifierValidationResult: {...} } } is rejected, not silently accepted', async () => {
  // This was the fifth-failure fix's (wrong) assumption — a second nested
  // wrapper inside d. The sixth real failure proved d IS the result
  // directly, so this shape must now be rejected as missing ID/DocumentNumber
  // (the nested object is just an unrecognized extra field on d).
  const responseBody = {
    d: { CreateDocumentWithIdentifierValidationResult: { ID: 'should-be-ignored', DocumentNumber: 9999, Errors: [] } },
  };

  await withStubbedFetch(responseBody, async () => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'INVALID_RESPONSE_SHAPE');
        return true;
      }
    );
  });
});

test('no undefined success field can ever reach the return object, across every tested response shape', async () => {
  const shapes = [
    { d: { ID: 'x', DocumentNumber: 1, Errors: [] } }, // valid
    { d: { Errors: [] } }, // no ID/DocNum
    { d: { CreateDocumentWithIdentifierValidationResult: { ID: 'x', DocumentNumber: 1 } } }, // wrong (old) shape
    { d: {} },
    { d: null },
    {},
  ];

  for (const responseBody of shapes) {
    await withStubbedFetch(responseBody, async () => {
      try {
        const result = await createReceipt({ ...baseReq });
        assert.notEqual(result.documentId, undefined);
        assert.notEqual(result.documentNumber, undefined);
      } catch (err) {
        assert.equal(err.code, 'INVALID_RESPONSE_SHAPE');
      }
    });
  }
});
