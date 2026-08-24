// The one Cloud Function this project adds. Orchestrates, in this order:
//   1. verify caller is the authenticated admin (never trust a client flag)
//   2. lock + durably record the payment fact (receiptState — before any
//      external call, so it can never be lost)
//   3. call Invoice4U (invoice4uClient)
//   4. record success or failure (receiptState — failure never erases the
//      payment fact recorded in step 2)
//
// B3 (2026-08-24): wired to real UI, verified end-to-end against the
// Firestore/Auth/Functions emulators with invoice4uClient running in mock
// mode (see invoice4uMock.js) — no real Invoice4U account involved. Not
// deployed to production; no Blaze-dependent operation happens by this file
// merely existing.
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { getInvoice4uConfig } = require('./config');
const { beginReceiptAttempt, recordReceiptSuccess, recordReceiptFailure, ReceiptStateError } = require('./receiptState');
const { createReceipt, invoice4uApiToken } = require('./invoice4uClient');
const { resolveInvoice4uCustomer } = require('./invoice4uCustomer');

// Server-side deployment configuration ONLY — never Firestore, never
// client-supplied. Set via `functions/.env.*` at deploy time (B4+), not at
// runtime. Defaults to 'qa' so an unset value can never accidentally reach
// Invoice4U production. See investigation doc §34 (Environment Safety).
function getInvoice4uEnvironment() {
  return process.env.INVOICE4U_ENVIRONMENT === 'production' ? 'production' : 'qa';
}

// B4A readiness gate — deploy-time only, never Firestore, never
// client-reachable, no code path bypasses it. Defaults CLOSED: unless a
// deploy explicitly sets RECEIPT_ISSUANCE_ENABLED=true, this throws before
// beginReceiptAttempt is ever called — so even a fully authorized, fully
// valid request cannot reach Invoice4U, and no payment/receipt field on
// any real appointment is touched. B4A deploys with this unset (closed);
// flipping it to 'true' and redeploying is the explicit, separate B4B
// action, approved on its own.
function isReceiptIssuanceEnabled() {
  return process.env.RECEIPT_ISSUANCE_ENABLED === 'true';
}

const issueReceipt = onCall({
  // Only the secret for THIS deployment's environment — see above.
  secrets: [invoice4uApiToken],
  // Cheap insurance, not a real bottleneck at this business's volume: caps
  // how many concurrent instances a runaway client retry loop (or abuse)
  // could spin up. See investigation doc §17 Blaze cost assessment.
  maxInstances: 5,
}, async (request) => {
  // ---- 1. Auth: single admin identity, verified server-side ----
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'admin authentication required');
  }

  const { appointmentId, amount, method, itemDescription, _mockScenario, _mockCustomerScenario } = request.data || {};
  if (!appointmentId || typeof appointmentId !== 'string') {
    throw new HttpsError('invalid-argument', 'appointmentId is required');
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(amount > 0)) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number');
  }
  if (!['cash', 'bit', 'paybox'].includes(method)) {
    throw new HttpsError('invalid-argument', "method must be 'cash' | 'bit' | 'paybox'");
  }

  // ---- 1.5. B4A readiness gate — see isReceiptIssuanceEnabled() above.
  // Deliberately AFTER auth+validation (so those are still verifiable
  // against the real deployed function) and BEFORE beginReceiptAttempt (so
  // no Firestore field on any real appointment is touched, and Invoice4U
  // is never reached) regardless of how correct/authorized the request is.
  if (!isReceiptIssuanceEnabled()) {
    throw new HttpsError('failed-precondition', 'receipt issuance is not yet enabled in this environment');
  }

  // ---- 2. Lock + durably record payment, before touching Invoice4U ----
  let attempt;
  try {
    attempt = await beginReceiptAttempt(appointmentId, { amount, method, adminUid: request.auth.uid });
  } catch (e) {
    if (e instanceof ReceiptStateError && e.code === 'NOT_FOUND') {
      throw new HttpsError('not-found', 'appointment not found');
    }
    if (e instanceof ReceiptStateError && e.code === 'ALREADY_IN_PROGRESS') {
      throw new HttpsError('failed-precondition', 'a receipt is already being issued for this appointment');
    }
    throw new HttpsError('internal', 'failed to lock appointment for receipt issuance');
  }

  if (attempt.status === 'already-issued') {
    // Same response SHAPE as the fresh-success branch below — found during
    // B3 verification: this used to return { receipt: {...} } (nested)
    // while a fresh success returned documentNumber/pdfUrl at the top
    // level, so a caller reading result.documentNumber after a duplicate
    // click got undefined instead of the real, already-issued value.
    return { status: 'issued', documentNumber: attempt.receipt.documentNumber, pdfUrl: attempt.receipt.pdfUrl };
  }

  // ---- 3. Resolve a verified Invoice4U customer, then call Invoice4U ----
  const config = await getInvoice4uConfig();
  const paymentType = config.paymentTypeMap[method];

  try {
    // Server-side only — the customer's name/phone that end up on a real
    // legal document must never come from client-supplied request data.
    // Read fresh from the appointment itself (already locked by
    // beginReceiptAttempt above, so this is safe/consistent).
    const apptSnap = await getFirestore().collection('appointments').doc(appointmentId).get();
    const apptData = apptSnap.data() || {};

    // ---- 3a. Resolve/create the Invoice4U customer (ClientID) ----
    // Required because DocumentType=2 (Receipt) rejects GeneralCustomer
    // outright (Error 38, TypeOfDocumentDoesntAllowGeneralCustomer) — see
    // invoice4uCustomer.js for the full resolve-or-create + race handling.
    // If this throws, execution never reaches createReceipt() below —
    // the catch block records a safe failure exactly as any other
    // Invoice4U-side failure at this stage would.
    const { clientId } = await resolveInvoice4uCustomer({
      name: apptData.name,
      phone: apptData.phone,
      // TEST-ONLY: only has any effect when the server itself is running
      // with INVOICE4U_MOCK_MODE=true (Functions Emulator). See
      // invoice4uCustomerMock.js.
      _mockCustomerScenario,
    });

    const result = await createReceipt({
      environment: getInvoice4uEnvironment(),
      documentType: config.documentType,
      apiIdentifier: attempt.apiIdentifier,
      clientId,
      itemDescription,
      amount,
      paymentType,
      // TEST-ONLY: only has any effect when the server itself is running
      // with INVOICE4U_MOCK_MODE=true (Functions Emulator). See
      // invoice4uMock.js and invoice4uClient.js.
      _mockScenario,
    });

    // ---- 4a. Success (including idempotent-duplicate, e.g. Invoice4U code 134) ----
    await recordReceiptSuccess(appointmentId, {
      documentId: result.documentId,
      documentNumber: result.documentNumber,
      documentType: result.documentType ?? config.documentType,
      pdfUrl: result.pdfUrl,
    });

    return { status: 'issued', documentNumber: result.documentNumber, pdfUrl: result.pdfUrl };
  } catch (e) {
    // ---- 4b. Failure — payment fact from step 2 is untouched and safe ----
    // Covers both customer-resolution failures (3a) and receipt-issuance
    // failures — same guarantee either way: payment.* was already
    // committed before this try block, so retry is always safe.
    const isTimeout = e.code === 'TIMEOUT' || e.code === 'CUSTOMER_TIMEOUT';
    const isNotConfigured = e.code === 'NOT_CONFIGURED' || e.code === 'CUSTOMER_NOT_CONFIGURED';
    const lastError = isNotConfigured
      ? 'Invoice4U is not configured yet (missing API token)'
      : e.message;
    await recordReceiptFailure(appointmentId, lastError);

    if (isNotConfigured) {
      throw new HttpsError('failed-precondition', 'Invoice4U integration is not configured yet');
    }
    if (isTimeout) {
      // Distinct from a confirmed failure: we don't know whether Invoice4U
      // actually created the customer/document. The client must present
      // this differently ("unknown — safe to retry") from a definite
      // error. Retrying is safe regardless — same ApiIdentifier (and,
      // deterministically, the same ExtNumber) either way.
      throw new HttpsError('deadline-exceeded', 'Invoice4U did not respond in time — result is unknown, retry is safe');
    }
    throw new HttpsError('internal', 'failed to issue receipt — payment was recorded, retry is safe');
  }
});

module.exports = { issueReceipt };
