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

const invoice4uApiToken = defineSecret('INVOICE4U_API_TOKEN');

const HOSTS = {
  qa: 'https://apiqa.invoice4u.co.il/Services/ApiService.svc',
  production: 'https://api.invoice4u.co.il/Services/ApiService.svc',
};

/**
 * @param {{
 *   environment: 'qa'|'production',
 *   documentType: number,
 *   apiIdentifier: string,
 *   customerName: string,
 *   itemDescription: string,
 *   amount: number,
 *   paymentType: number,
 * }} req
 */
async function createReceipt(req) {
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

  const res = await fetch(`${host}/CreateDocumentWithIdentifierValidation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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
