// The Firestore half of the two-layer idempotency design (investigation doc
// §15). Pure Firestore logic — no Invoice4U calls happen in this file, which
// is exactly why it can be built and tested now, before QA credentials
// exist.
//
// State machine for appointments/{id}.receipt.status:
//   (absent) --beginReceiptAttempt--> 'pending' --recordReceiptSuccess--> 'issued'
//                                              \--recordReceiptFailure--> 'failed'
//   'failed' --beginReceiptAttempt (retry)--> 'pending'  (same apiIdentifier, always)
//   'issued' --beginReceiptAttempt--> returns the existing result, no write (idempotent no-op)
//   'pending' --beginReceiptAttempt--> rejected: ALREADY_IN_PROGRESS
'use strict';

const { getFirestore, FieldValue } = require('firebase-admin/firestore');

class ReceiptStateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'NOT_FOUND' | 'ALREADY_IN_PROGRESS'
  }
}

/**
 * Locks the appointment for a receipt attempt and durably records the
 * payment fact. Must be called, and must succeed, BEFORE any Invoice4U API
 * call — so that "the money was received" is never lost even if the
 * Invoice4U call that follows fails.
 *
 * apiIdentifier is always the appointment's own document ID: deterministic,
 * stable across every retry, never derived from an attempt counter.
 *
 * @returns {Promise<{status:'ready', apiIdentifier:string} | {status:'already-issued', receipt:object}>}
 */
async function beginReceiptAttempt(appointmentId, { amount, method, adminUid }) {
  const db = getFirestore();
  const ref = db.collection('appointments').doc(appointmentId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      throw new ReceiptStateError('NOT_FOUND', `appointment ${appointmentId} does not exist`);
    }

    const existing = snap.data().receipt || {};

    if (existing.status === 'issued') {
      // Idempotent no-op at the app layer, ahead of ever reaching Invoice4U.
      return { status: 'already-issued', receipt: existing };
    }
    if (existing.status === 'pending') {
      throw new ReceiptStateError(
        'ALREADY_IN_PROGRESS',
        `receipt for ${appointmentId} is already being issued`
      );
    }

    const now = FieldValue.serverTimestamp();
    const apiIdentifier = appointmentId; // deterministic — never changes across retries

    tx.update(ref, {
      payment: {
        amount,
        method,
        confirmedAt: now,
        confirmedByUid: adminUid,
      },
      treatmentCompletedAt: now,
      receipt: {
        status: 'pending',
        provider: 'invoice4u',
        apiIdentifier,
        documentId: existing.documentId ?? null,
        documentNumber: existing.documentNumber ?? null,
        documentType: existing.documentType ?? null,
        pdfUrl: existing.pdfUrl ?? null,
        requestedAt: now,
        issuedAt: existing.issuedAt ?? null,
        lastError: null,
        lastErrorAt: null,
        attempts: FieldValue.increment(1),
      },
    });

    return { status: 'ready', apiIdentifier };
  });
}

/** Called after a successful (or idempotent-duplicate, Invoice4U code 134) CreateDocument call. */
async function recordReceiptSuccess(appointmentId, { documentId, documentNumber, documentType, pdfUrl }) {
  const db = getFirestore();
  await db.collection('appointments').doc(appointmentId).update({
    'receipt.status': 'issued',
    'receipt.documentId': documentId,
    'receipt.documentNumber': documentNumber,
    'receipt.documentType': documentType,
    'receipt.pdfUrl': pdfUrl ?? null,
    'receipt.issuedAt': FieldValue.serverTimestamp(),
  });
}

/** Called on any Invoice4U failure. Never touches `payment` — that fact stays recorded. */
async function recordReceiptFailure(appointmentId, errorMessage) {
  const db = getFirestore();
  await db.collection('appointments').doc(appointmentId).update({
    'receipt.status': 'failed',
    'receipt.lastError': String(errorMessage).slice(0, 500),
    'receipt.lastErrorAt': FieldValue.serverTimestamp(),
  });
}

module.exports = {
  beginReceiptAttempt,
  recordReceiptSuccess,
  recordReceiptFailure,
  ReceiptStateError,
};
