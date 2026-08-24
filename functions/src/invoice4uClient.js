// Thin wrapper around Invoice4U's CreateDocumentWithIdentifierValidation.
// Knows nothing about Firestore or admin auth — receiptState.js and
// issueReceipt.js own those concerns. This module's only job is: given a
// fully-formed request, talk to Invoice4U and normalize the response.
//
// The API token is never a literal in this repo. It is declared as a Cloud
// Functions v2 secret (Secret Manager-backed) and is simply undefined until
// someone runs:
//   firebase functions:secrets:set INVOICE4U_API_TOKEN
// That is a deploy-time operation, not a code change — see investigation
// doc §17. Until it's set, callInvoice4u() throws a clear, explicit error
// instead of attempting (and silently mishandling) a real network call.
'use strict';

const { defineSecret } = require('firebase-functions/params');
const { mockCreateReceipt } = require('./invoice4uMock');

const invoice4uApiToken = defineSecret('INVOICE4U_API_TOKEN');

const HOSTS = {
  qa: 'https://apiqa.invoice4u.co.il/Services/ApiService.svc',
  production: 'https://api.invoice4u.co.il/Services/ApiService.svc',
};

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * @param {{
 *   environment: 'qa'|'production',
 *   documentType: number,
 *   apiIdentifier: string,
 *   customerName: string,
 *   itemDescription: string,
 *   amount: number,
 *   paymentType: number,
 *   _mockScenario?: string,  // TEST-ONLY — see invoice4uMock.js header
 * }} req
 */
async function createReceipt(req) {
  // TEST-ONLY branch. Gated on a server env var that only ever exists in
  // the Functions Emulator (see B3 test harness) — never set in any real
  // deployment, so this can never activate in production regardless of
  // anything a client sends.
  if (process.env.INVOICE4U_MOCK_MODE === 'true') {
    return mockCreateReceipt(req);
  }

  const token = invoice4uApiToken.value();
  if (!token) {
    // Expected and normal until the manual "attach Invoice4U QA credentials"
    // step (investigation doc §19, item 1) is done. Surfaced as a distinct
    // error code so callers can show a clear "not configured yet" message
    // rather than a confusing network failure.
    const err = new Error('INVOICE4U_API_TOKEN secret is not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  const host = HOSTS[req.environment];
  if (!host) {
    throw new Error(`unknown Invoice4U environment: ${req.environment}`);
  }

  const body = {
    token,
    doc: {
      DocumentType: req.documentType,
      ApiIdentifier: req.apiIdentifier,
      GeneralCustomer: { Name: req.customerName },
      Items: [{ Name: req.itemDescription, Quantity: 1, Price: req.amount }],
      Payments: [{ PaymentType: req.paymentType, Amount: req.amount, Date: new Date().toISOString() }],
      Currency: 'ILS',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${host}/CreateDocumentWithIdentifierValidation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // We genuinely don't know whether Invoice4U processed the request —
      // it may have created a document we never heard back about. This is
      // NOT the same as a confirmed failure; see receiptState.js / the
      // ambiguous-result handling in issueReceipt.js. Retrying is safe
      // regardless, because the ApiIdentifier stays the same either way.
      const err = new Error('Invoice4U request timed out — result is unknown, not a confirmed failure');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const err = new Error(`Invoice4U HTTP ${res.status}`);
    err.code = 'HTTP_ERROR';
    throw err;
  }

  const json = await res.json();
  const result = json?.CreateDocumentResult ?? json;
  const errors = result?.Errors ?? [];

  // Error 134 = DocumentAlreadyCreated. Per Invoice4U's own docs this is the
  // idempotent-duplicate signal, not a real failure — treat exactly like
  // success and return the existing document's identifiers.
  const isRealError = errors.some((e) => e.ID !== 134);
  if (isRealError) {
    const err = new Error(errors.map((e) => e.Error).join('; ') || 'Invoice4U returned an error');
    err.code = 'INVOICE4U_ERROR';
    err.invoice4uErrors = errors;
    throw err;
  }

  return {
    documentId: result.ID,
    documentNumber: result.DocumentNumber,
    documentType: result.DocumentType,
    pdfUrl: result.PrintOriginalPDFLink ?? null,
    wasIdempotentDuplicate: errors.length > 0,
  };
}

module.exports = { createReceipt, invoice4uApiToken, HOSTS };
