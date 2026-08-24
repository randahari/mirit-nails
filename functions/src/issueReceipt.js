// The one Cloud Function this project adds. Orchestrates, in this order:
//   1. verify caller is the authenticated admin (never trust a client flag)
//   2. lock + durably record the payment fact (receiptState — before any
//      external call, so it can never be lost)
//   3. call Invoice4U (invoice4uClient)
//   4. record success or failure (receiptState — failure never erases the
//      payment fact recorded in step 2)
//
// Not wired into index.html yet, and not deployed (no Blaze plan active) —
// see investigation doc §13, Phase A. This file exists so the shape is
// right and can be exercised against the Firestore/Functions emulators now;
// step 3 cannot be exercised for real until Invoice4U QA credentials exist.
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getInvoice4uConfig } = require('./config');
const { beginReceiptAttempt, recordReceiptSuccess, recordReceiptFailure, ReceiptStateError } = require('./receiptState');
const { createReceipt, invoice4uApiToken } = require('./invoice4uClient');

const issueReceipt = onCall({
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

  const { appointmentId, amount, method, customerName, itemDescription } = request.data || {};
  if (!appointmentId || typeof appointmentId !== 'string') {
    throw new HttpsError('invalid-argument', 'appointmentId is required');
  }
  if (typeof amount !== 'number' || !(amount > 0)) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number');
  }
  if (!['cash', 'bit', 'paybox'].includes(method)) {
    throw new HttpsError('invalid-argument', "method must be 'cash' | 'bit' | 'paybox'");
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
    return { status: 'issued', receipt: attempt.receipt };
  }

  // ---- 3. Call Invoice4U ----
  const config = await getInvoice4uConfig();
  const paymentType = config.paymentTypeMap[method];

  try {
    const result = await createReceipt({
      environment: config.environment,
      documentType: config.documentType,
      apiIdentifier: attempt.apiIdentifier,
      customerName,
      itemDescription,
      amount,
      paymentType,
    });

    // ---- 4a. Success ----
    await recordReceiptSuccess(appointmentId, {
      documentId: result.documentId,
      documentNumber: result.documentNumber,
      documentType: result.documentType ?? config.documentType,
      pdfUrl: result.pdfUrl,
    });

    return { status: 'issued', documentNumber: result.documentNumber, pdfUrl: result.pdfUrl };
  } catch (e) {
    // ---- 4b. Failure — payment fact from step 2 is untouched and safe ----
    await recordReceiptFailure(appointmentId, e.code === 'NOT_CONFIGURED'
      ? 'Invoice4U is not configured yet (missing API token)'
      : e.message);

    if (e.code === 'NOT_CONFIGURED') {
      throw new HttpsError('failed-precondition', 'Invoice4U integration is not configured yet');
    }
    throw new HttpsError('internal', 'failed to issue receipt — payment was recorded, retry is safe');
  }
});

module.exports = { issueReceipt };
