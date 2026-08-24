// Entry point — kept deliberately thin. All real logic lives under src/.
'use strict';

const { initializeApp } = require('firebase-admin/app');
const { setGlobalOptions } = require('firebase-functions/v2');

// Required once, here, before any module below calls getFirestore()/getAuth()
// — without it the Admin SDK doesn't reliably pick up the emulator hosts
// (FIRESTORE_EMULATOR_HOST etc.) or production credentials. Found during B3
// verification: every call that reached receiptState.js failed/hung for
// ~7s against the emulator until this was added.
initializeApp();

// Approved (2026-08-24): Cloud Functions, Blaze plan, region europe-west1.
setGlobalOptions({ region: 'europe-west1' });

const { issueReceipt } = require('./src/issueReceipt');

exports.issueReceipt = issueReceipt;
