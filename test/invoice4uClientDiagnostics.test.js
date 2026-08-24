// Isolated unit test for the diagnostic-capture addition to
// invoice4uClient.js's `!res.ok` path (added after the first real B4B
// attempt returned HTTP 500 with no captured body — see root cause
// investigation). No emulator, no network, no real secret involved: fetch
// is stubbed directly.
//
// The single most important property under test: however Invoice4U's
// response body is shaped, the diagnostic capture can NEVER surface the
// API token or any other outgoing-request detail, because it only ever
// reads fields out of the *response*, never the request.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FAKE_TOKEN = 'super-secret-invoice4u-token-do-not-leak';
process.env.INVOICE4U_API_TOKEN_PRODUCTION = FAKE_TOKEN;
// Ensure we exercise the real-fetch path, not invoice4uMock.js.
delete process.env.INVOICE4U_MOCK_MODE;

const { createReceipt } = require('../functions/src/invoice4uClient');

const baseReq = {
  environment: 'production',
  documentType: 2,
  apiIdentifier: 'appt-diagnostic-test',
  clientId: 12345,
  itemDescription: 'Manicure',
  amount: 140,
  paymentType: 9,
};

function fakeResponse({ ok, status, text }) {
  return {
    ok,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function withStubbedFetch(response, fn) {
  const original = global.fetch;
  global.fetch = async () => response;
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  return fn(loggedCalls).finally(() => {
    global.fetch = original;
    console.error = originalConsoleError;
  });
}

test('HTTP 500 with a JSON body: allowlisted fields surface, token never appears anywhere', async () => {
  const body = JSON.stringify({
    Message: 'Internal Server Error',
    ErrorCode: 500,
    UnrelatedInternalField: 'should not appear (not on allowlist)',
  });
  const response = fakeResponse({ ok: false, status: 500, text: body });

  await withStubbedFetch(response, async (loggedCalls) => {
    await assert.rejects(
      () => createReceipt({ ...baseReq, _mockScenario: undefined }),
      (err) => {
        assert.equal(err.code, 'HTTP_ERROR');
        assert.match(err.message, /Invoice4U HTTP 500/);
        assert.match(err.message, /Internal Server Error/);
        assert.ok(err.providerDiagnostics.fields.Message === 'Internal Server Error');
        assert.equal(err.providerDiagnostics.fields.UnrelatedInternalField, undefined);
        // Central safety property.
        assert.doesNotMatch(err.message, new RegExp(FAKE_TOKEN));
        assert.doesNotMatch(JSON.stringify(err.providerDiagnostics), new RegExp(FAKE_TOKEN));
        return true;
      }
    );
    const loggedText = JSON.stringify(loggedCalls);
    assert.doesNotMatch(loggedText, new RegExp(FAKE_TOKEN));
    assert.match(loggedText, /Internal Server Error/);
  });
});

test('HTTP 500 with a non-JSON (HTML/text) body: bounded excerpt captured, no crash, no token leak', async () => {
  const body = '<html><body>502 Bad Gateway from upstream proxy</body></html>'.repeat(50); // > 1000 chars
  const response = fakeResponse({ ok: false, status: 502, text: body });

  await withStubbedFetch(response, async (loggedCalls) => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'HTTP_ERROR');
        assert.match(err.message, /Invoice4U HTTP 502/);
        assert.match(err.message, /Bad Gateway/);
        assert.equal(err.providerDiagnostics.bodyFormat, 'text');
        assert.ok(err.providerDiagnostics.bodyExcerpt.length <= 1000);
        assert.ok(err.message.length < 500); // stays well within Firestore's 500-char lastError cap
        assert.doesNotMatch(err.message, new RegExp(FAKE_TOKEN));
        return true;
      }
    );
    assert.doesNotMatch(JSON.stringify(loggedCalls), new RegExp(FAKE_TOKEN));
  });
});

test('HTTP 500 with an empty body: does not throw while reading, still produces a usable error', async () => {
  const response = fakeResponse({ ok: false, status: 500, text: '' });

  await withStubbedFetch(response, async () => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.equal(err.code, 'HTTP_ERROR');
        assert.match(err.message, /Invoice4U HTTP 500/);
        return true;
      }
    );
  });
});

test('JSON body shaped like a real Invoice4U error (nested CreateDocumentResult) is still picked up', async () => {
  const body = JSON.stringify({
    CreateDocumentResult: {
      Errors: [{ ID: 56, Error: 'PaymentAmountDoesntMatchItemsAmount' }],
    },
  });
  const response = fakeResponse({ ok: false, status: 500, text: body });

  await withStubbedFetch(response, async () => {
    await assert.rejects(
      () => createReceipt({ ...baseReq }),
      (err) => {
        assert.ok(err.providerDiagnostics.fields.Errors);
        assert.equal(err.providerDiagnostics.fields.Errors[0].Error, 'PaymentAmountDoesntMatchItemsAmount');
        return true;
      }
    );
  });
});
