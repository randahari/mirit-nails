// Entry point — kept deliberately thin. All real logic lives under src/.
'use strict';

const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
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

const { AppointmentEditError, rescheduleAppointment } = require('./src/rescheduleAppointment');
const makeCalendarConfig = defineSecret('MAKE_CALENDAR_EDIT_CONFIG');

exports.rescheduleAppointment = onCall({
  secrets: [makeCalendarConfig],
  timeoutSeconds: 70
}, async (request) => {
  try {
    return await rescheduleAppointment(request, {
      db: getFirestore(),
      calendar: JSON.parse(makeCalendarConfig.value())
    });
  } catch (error) {
    if (error instanceof AppointmentEditError) {
      throw new HttpsError(error.code, error.message, { reason: error.reason });
    }
    throw error;
  }
});

const { parseCustomerSearch, findCustomerHistory } = require('./src/customerHistory');

exports.searchCustomerHistory = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (request.auth?.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin authentication required');
  }
  const search = parseCustomerSearch(request.data?.name);
  if (!search) throw new HttpsError('invalid-argument', 'Enter at least two characters of a customer name');

  const appointments = getFirestore().collection('appointments')
    .where('datetime', '<=', Timestamp.now())
    .orderBy('datetime', 'desc')
    .select('name', 'phone', 'phoneRaw', 'datetime', 'services', 'branch', 'status');
  return findCustomerHistory(appointments.stream(), search);
});
