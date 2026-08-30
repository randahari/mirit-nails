// Focused test suite for functions/src/invoice4uCustomer.js — the
// resolve-or-create flow that turns an appointment's phone into a
// verified Invoice4U ClientID.
//
// FINAL architecture (2026-08-24): customer lookup uses the dedicated
// GetCustomerByExternalNumber endpoint. VERIFIED against real, approved,
// read-only production evidence:
//   - existing customer → { d: { ID, Name, ExtNumber, Errors: [], ... } }
//   - genuinely new customer → { d: null }  ← the REAL NOT_FOUND response
// The earlier assumption (Errors[] containing ID 7) was never observed in
// production and is now only a defensive, unverified secondary signal —
// see D9 below. The generic GetCustomers search (getCustomersByExtNumber)
// has been removed from the module (2026-08-24 cleanup) — it is no longer
// part of this flow, and never will be without a fresh implementation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const FAKE_TOKEN = 'super-secret-invoice4u-token-do-not-leak';
process.env.INVOICE4U_API_TOKEN_PRODUCTION = FAKE_TOKEN;
delete process.env.INVOICE4U_MOCK_MODE;

const { resolveInvoice4uCustomer } = require('../functions/src/invoice4uCustomer');
const { createReceipt } = require('../functions/src/invoice4uClient');

const VALID_PHONE = '0501234567'; // normalizes to 972501234567 → ExtNumber 972501234567
const EXT_NUMBER = 972501234567;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

// Verified real GetCustomerByExternalNumber / CreateCustomer shape for a
// found/created customer — "d" directly holds the Customer object's fields.
function customerD(fields, errors = []) {
  return jsonResponse(200, {
    d: { Errors: errors, __type: 'Customer', Info: null, OpenInfo: null, RecaptchaToken: null, ...fields },
  });
}

// VERIFIED (2026-08-24): the real NOT_FOUND response for
// GetCustomerByExternalNumber — a bare { d: null }, observed for a
// genuinely new customer in production.
function customerNotFoundD() {
  return jsonResponse(200, { d: null });
}

// Legacy/defensive secondary "not found" shape (Errors[] with ID 7) —
// UNVERIFIED for this endpoint, never actually observed. Used only in D9
// to prove it's still handled defensively without interfering with the
// verified d:null path.
function customerNotFoundLegacyD() {
  return jsonResponse(200, {
    d: { Errors: [{ ID: 7, Error: 'ClientDoesntExists' }], __type: 'Customer', Info: null, OpenInfo: null, RecaptchaToken: null },
  });
}

function withFetchSequence(responses, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  let i = 0;
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (typeof next === 'function') return next();
    return next;
  };
  const originalConsoleError = console.error;
  const loggedCalls = [];
  console.error = (...args) => loggedCalls.push(args);
  return fn(() => calls, () => loggedCalls).finally(() => {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  });
}

// ---- A. Existing customer ----
test('A. GetCustomerByExternalNumber finds the customer ({d:{ID,ExtNumber,Errors:[]}}) → existing ClientID returned, CreateCustomer NOT called', async () => {
  await withFetchSequence([customerD({ ID: 8024360, Name: 'לקוחה', ExtNumber: EXT_NUMBER })], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
    assert.equal(clientId, 8024360);
    const calls = getCalls();
    assert.equal(calls.length, 1, 'must not call CreateCustomer when an existing customer was found');
    assert.match(calls[0].url, /\/GetCustomerByExternalNumber$/);
    assert.equal(calls[0].body.number, EXT_NUMBER);
    assert.equal(calls[0].body.token, FAKE_TOKEN);
  });
});

// ---- B. New customer: verified {d:null} → NOT_FOUND → CreateCustomer ----
test('B. GetCustomerByExternalNumber returns {d:null} → classified NOT_FOUND → CreateCustomer called → returned ID becomes ClientID', async () => {
  await withFetchSequence([customerNotFoundD(), customerD({ ID: 777, Name: 'אסתר', ExtNumber: EXT_NUMBER })], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'אסתר', phone: VALID_PHONE });
    assert.equal(clientId, 777);
    const calls = getCalls();
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/GetCustomerByExternalNumber$/);
    assert.match(calls[1].url, /\/CreateCustomer$/);
    assert.equal(calls[1].body.cu.Name, 'אסתר');
    assert.equal(calls[1].body.cu.ExtNumber, EXT_NUMBER);
  });
});

// ---- C. Full new-customer flow through to createReceipt ----
test('C. full new-customer flow: {d:null} → CreateCustomer → createReceipt with that ClientID, GeneralCustomer absent, DocumentType=2', async () => {
  const receiptSuccess = jsonResponse(200, {
    d: { ID: 'doc-esther-1', DocumentNumber: 30002, DocumentType: 2, PrintOriginalPDFLink: null, Errors: [] },
  });

  await withFetchSequence(
    [customerNotFoundD(), customerD({ ID: 777, Name: 'אסתר', ExtNumber: EXT_NUMBER }), receiptSuccess],
    async (getCalls) => {
      const { clientId } = await resolveInvoice4uCustomer({ name: 'אסתר', phone: VALID_PHONE });
      assert.equal(clientId, 777);

      const result = await createReceipt({
        environment: 'production',
        documentType: 2,
        apiIdentifier: 'appt-esther-test',
        clientId,
        itemDescription: 'Manicure',
        amount: 140,
        paymentType: 9,
      });
      assert.equal(result.documentNumber, 30002);

      const calls = getCalls();
      assert.equal(calls.length, 3);
      assert.match(calls[0].url, /\/GetCustomerByExternalNumber$/);
      assert.match(calls[1].url, /\/CreateCustomer$/);
      assert.match(calls[2].url, /\/CreateDocumentWithIdentifierValidation$/);

      const receiptBody = calls[2].body;
      assert.equal(receiptBody.doc.ClientID, 777);
      assert.equal(receiptBody.doc.GeneralCustomer, undefined, 'GeneralCustomer must never be sent');
      assert.equal(receiptBody.doc.DocumentType, 2);
    }
  );
});

// ---- D. Duplicate/race ----
test('D. lookup={d:null} → CreateCustomer returns 31/-2 → GetCustomerByExternalNumber retry → existing ID resolved, Receipt uses existing ClientID', async () => {
  const createCustomerDuplicate = customerD({}, [{ ID: -2, Error: 'CustomerExternalNumberExists' }]);

  await withFetchSequence(
    [customerNotFoundD(), createCustomerDuplicate, customerD({ ID: 888, Name: 'לקוחה', ExtNumber: EXT_NUMBER })],
    async (getCalls) => {
      const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
      assert.equal(clientId, 888);
      const calls = getCalls();
      assert.equal(calls.length, 3);
      assert.match(calls[0].url, /\/GetCustomerByExternalNumber$/);
      assert.match(calls[1].url, /\/CreateCustomer$/);
      assert.match(calls[2].url, /\/GetCustomerByExternalNumber$/, 'must retry via the dedicated endpoint exactly once, never guess an ID');
    }
  );
});

test('D-race2. duplicate via catalog code 31 is also recognized as the same race signal', async () => {
  const createCustomerDuplicate31 = customerD({}, [{ ID: 31, Error: 'CustomerExternalNumberExists' }]);

  await withFetchSequence([customerNotFoundD(), createCustomerDuplicate31, customerD({ ID: 999, Name: 'לקוחה', ExtNumber: EXT_NUMBER })], async () => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
    assert.equal(clientId, 999);
  });
});

test('D-race3. duplicate signal but fallback lookup still {d:null} → fail safely, no Receipt', async () => {
  const createCustomerDuplicate = customerD({}, [{ ID: -2, Error: 'CustomerExternalNumberExists' }]);

  await withFetchSequence([customerNotFoundD(), createCustomerDuplicate, customerNotFoundD()], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_AMBIGUOUS'); return true; }
    );
  });
});

// ---- E. Malformed shapes remain rejected ----
test('D1. HTTP error on GetCustomerByExternalNumber → CUSTOMER_HTTP_ERROR', async () => {
  await withFetchSequence([jsonResponse(500, {})], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_HTTP_ERROR'); return true; }
    );
  });
});

test('D2. AbortError from fetch → CUSTOMER_TIMEOUT', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  try {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_TIMEOUT'); return true; }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('D2b. raw network error → CUSTOMER_NETWORK_ERROR', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_NETWORK_ERROR'); return true; }
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('D3. malformed JSON body (res.json() throws) → surfaces as a clear error, not a crash', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    text: async () => 'not json',
    json: async () => { throw new SyntaxError('Unexpected token n in JSON'); },
  });
  try {
    await assert.rejects(() => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }));
  } finally {
    global.fetch = originalFetch;
  }
});

test('D4. missing "d" key entirely → CUSTOMER_INVALID_RESPONSE_SHAPE, safe diagnostics only', async () => {
  const malformed = jsonResponse(200, { SomethingElse: true });

  await withFetchSequence([malformed], async (getCalls, getLogged) => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
    const diag = getLogged().find((args) => args[0] === '[invoice4uCustomer] Invoice4U response missing/malformed expected wrapper');
    assert.ok(diag);
    assert.equal(diag[1].stage, 'GetCustomerByExternalNumber');
    assert.equal(diag[1].expectedKey, 'd');
    const loggedText = JSON.stringify(getLogged());
    assert.doesNotMatch(loggedText, new RegExp(FAKE_TOKEN));
  });
});

test('D5. "d" is an array (not null, not object) → CUSTOMER_INVALID_RESPONSE_SHAPE, no crash — must NOT be treated as not-found', async () => {
  await withFetchSequence([jsonResponse(200, { d: [1, 2, 3] })], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('D6. "d" is a primitive (string) → CUSTOMER_INVALID_RESPONSE_SHAPE, not treated as not-found', async () => {
  await withFetchSequence([jsonResponse(200, { d: 'unexpected' })], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('D7. business Errors[] (real provider error, not not-found) → CUSTOMER_ERROR, no ClientID guessed', async () => {
  await withFetchSequence([customerD({}, [{ ID: 80, Error: 'UnauthorizedUser' }])], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => {
        assert.equal(err.code, 'CUSTOMER_ERROR');
        assert.equal(err.invoice4uErrors[0].ID, 80);
        return true;
      }
    );
  });
});

test('D8. missing/invalid ID on an otherwise-clean customer object → CUSTOMER_INVALID_RESPONSE_SHAPE', async () => {
  await withFetchSequence([customerD({})], async () => { // Errors: [], no ID, not d:null either
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('D9. legacy/unverified ID-7 not-found signal is still handled defensively, without interfering with the verified d:null path', async () => {
  await withFetchSequence([customerNotFoundLegacyD(), customerD({ ID: 555, ExtNumber: EXT_NUMBER })], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
    assert.equal(clientId, 555, 'ID-7 legacy signal should still result in NOT_FOUND → CreateCustomer, same as {d:null}');
  });
});

test('D10. ExtNumber mismatch on an otherwise-valid response → CUSTOMER_INVALID_RESPONSE_SHAPE, no ClientID guessed', async () => {
  await withFetchSequence([customerD({ ID: 42, ExtNumber: 972500000000 })], async () => { // different ExtNumber than requested
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('invalid phone → INVALID_PHONE, never makes any network call', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should never be called'); };
  try {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'x', phone: '123' }),
      (err) => { assert.equal(err.code, 'INVALID_PHONE'); return true; }
    );
    assert.equal(called, false, 'must fail before any Invoice4U call when phone is invalid');
  } finally {
    global.fetch = originalFetch;
  }
});

test('never logs the token in any diagnostic path', async () => {
  const createCustomerBusinessError = customerD({}, [{ ID: 28, Error: 'CustomerNameCanNotBeEmpty' }]);

  await withFetchSequence([customerNotFoundD(), createCustomerBusinessError], async (getCalls, getLogged) => {
    await assert.rejects(() => resolveInvoice4uCustomer({ name: '', phone: VALID_PHONE }));
    const loggedText = JSON.stringify(getLogged());
    assert.doesNotMatch(loggedText, new RegExp(FAKE_TOKEN));
  });
});

// ---- F. Existing-customer Name sync (2026-08-24, customer-name-edit feature) ----
// Contract VERIFIED against a real, approved, no-op production UpdateCustomer
// call: request { cu: <full Customer>, token } → response { d: <full
// Customer>, Errors: [] } on success, same "d"-direct pattern as every other
// endpoint on this service.

test('F1. existing customer with name already matching → no UpdateCustomer call, clientId returned normally', async () => {
  await withFetchSequence([customerD({ ID: 42, Name: 'לקוחה', ExtNumber: EXT_NUMBER })], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
    assert.equal(clientId, 42);
    const calls = getCalls();
    assert.equal(calls.length, 1, 'must not call UpdateCustomer when the name already matches');
  });
});

test('F1b. name differs only by whitespace (trim/collapse) → still treated as matching, no UpdateCustomer call', async () => {
  await withFetchSequence([customerD({ ID: 42, Name: '  לקוחה   שם ', ExtNumber: EXT_NUMBER })], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'לקוחה שם', phone: VALID_PHONE });
    assert.equal(clientId, 42);
    assert.equal(getCalls().length, 1);
  });
});

test('F2. existing customer with a genuinely different name → UpdateCustomer called with the FULL existing object (only Name changed), succeeds, clientId returned', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER, Email: 'x@y.com', Phone: '0501112222', Active: true };
  const updateSuccess = jsonResponse(200, { d: { ...existingFull, Name: 'שם חדש', Errors: [] } });

  await withFetchSequence([customerD(existingFull), updateSuccess], async (getCalls) => {
    const { clientId } = await resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE });
    assert.equal(clientId, 42);
    const calls = getCalls();
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/GetCustomerByExternalNumber$/);
    assert.match(calls[1].url, /\/UpdateCustomer$/);
    // Full object echoed back — every existing field preserved, only Name changed.
    assert.equal(calls[1].body.cu.Email, 'x@y.com');
    assert.equal(calls[1].body.cu.Phone, '0501112222');
    assert.equal(calls[1].body.cu.Active, true);
    assert.equal(calls[1].body.cu.ID, 42);
    assert.equal(calls[1].body.cu.ExtNumber, EXT_NUMBER);
    assert.equal(calls[1].body.cu.Name, 'שם חדש');
  });
});

test('F3. UpdateCustomer returns a business-level error → resolveInvoice4uCustomer throws, nothing after it is ever called', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const updateBusinessError = customerD({}, [{ ID: 28, Error: 'CustomerNameCanNotBeEmpty' }]);

  await withFetchSequence([customerD(existingFull), updateBusinessError], async (getCalls) => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_ERROR'); return true; }
    );
    assert.equal(getCalls().length, 2, 'must call UpdateCustomer once, never anything after it');
  });
});

test('F4. UpdateCustomer returns a malformed response (missing d) → fails closed, CUSTOMER_INVALID_RESPONSE_SHAPE', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  await withFetchSequence([customerD(existingFull), jsonResponse(200, { SomethingElse: true })], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('F5. UpdateCustomer response has a mismatched ID → fails closed, no ClientID trusted', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const wrongId = jsonResponse(200, { d: { ID: 999, Name: 'שם חדש', ExtNumber: EXT_NUMBER, Errors: [] } });
  await withFetchSequence([customerD(existingFull), wrongId], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('F6. UpdateCustomer response has a mismatched ExtNumber → fails closed', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const wrongExt = jsonResponse(200, { d: { ID: 42, Name: 'שם חדש', ExtNumber: 972500000000, Errors: [] } });
  await withFetchSequence([customerD(existingFull), wrongExt], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('F7. UpdateCustomer response confirms a stale/wrong Name (not the intended one) → fails closed, never trusted', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const staleName = jsonResponse(200, { d: { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER, Errors: [] } }); // still the old name
  await withFetchSequence([customerD(existingFull), staleName], async () => {
    await assert.rejects(
      () => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }),
      (err) => { assert.equal(err.code, 'CUSTOMER_INVALID_RESPONSE_SHAPE'); return true; }
    );
  });
});

test('F8. fail-closed proof: when UpdateCustomer fails, no clientId is ever returned (so createReceipt/CreateDocumentWithIdentifierValidation can never be reached — see issueReceipt.js)', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const updateBusinessError = customerD({}, [{ ID: 28, Error: 'CustomerNameCanNotBeEmpty' }]);

  await withFetchSequence([customerD(existingFull), updateBusinessError], async (getCalls) => {
    let clientId;
    try {
      ({ clientId } = await resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }));
    } catch (e) { /* expected */ }
    assert.equal(clientId, undefined, 'clientId must never be returned when name sync failed');
    const docCalls = getCalls().filter((c) => /\/CreateDocumentWithIdentifierValidation$/.test(c.url));
    assert.equal(docCalls.length, 0, 'no receipt document call may ever happen after a failed name sync');
  });
});

test('F9. a genuinely new customer never triggers an UpdateCustomer call', async () => {
  await withFetchSequence([customerNotFoundD(), customerD({ ID: 777, Name: 'אסתר', ExtNumber: EXT_NUMBER })], async (getCalls) => {
    await resolveInvoice4uCustomer({ name: 'אסתר', phone: VALID_PHONE });
    assert.equal(getCalls().filter((c) => /\/UpdateCustomer$/.test(c.url)).length, 0);
  });
});

test('UpdateCustomer path never logs the token', async () => {
  const existingFull = { ID: 42, Name: 'שם ישן', ExtNumber: EXT_NUMBER };
  const updateBusinessError = customerD({}, [{ ID: 28, Error: 'x' }]);
  await withFetchSequence([customerD(existingFull), updateBusinessError], async (getCalls, getLogged) => {
    await assert.rejects(() => resolveInvoice4uCustomer({ name: 'שם חדש', phone: VALID_PHONE }));
    const loggedText = JSON.stringify(getLogged());
    assert.doesNotMatch(loggedText, new RegExp(FAKE_TOKEN));
  });
});

// ---- No generic GetCustomers call occurs anywhere in this flow ----
test('no request to /GetCustomers (generic search) occurs anywhere in a full resolve cycle', async () => {
  await withFetchSequence(
    [customerNotFoundD(), customerD({}, [{ ID: -2, Error: 'CustomerExternalNumberExists' }]), customerD({ ID: 5, Name: 'לקוחה', ExtNumber: EXT_NUMBER })],
    async (getCalls) => {
      await resolveInvoice4uCustomer({ name: 'לקוחה', phone: VALID_PHONE });
      const calls = getCalls();
      const genericSearchCalls = calls.filter((c) => /\/GetCustomers$/.test(c.url));
      assert.equal(genericSearchCalls.length, 0, 'the generic GetCustomers search must never be called in this flow');
    }
  );
});
