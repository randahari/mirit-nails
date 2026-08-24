// One-time operational script — NOT deployed as part of the app or the
// Cloud Functions codebase. Run manually, once, after Mirit's Firebase Auth
// user has been created in the Console, to grant her the `admin: true`
// custom claim that issueReceipt() and the Firestore Rules check for.
//
// Usage (against production, after real setup):
//   GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/setAdminClaim.js <uid>
//
// Usage (against the local emulator, for verification — as used in Phase A):
//   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 GCLOUD_PROJECT=mirit-nails node scripts/setAdminClaim.js <uid>
'use strict';

const admin = require('firebase-admin');

const uid = process.argv[2];
if (!uid) {
  console.error('Usage: node scripts/setAdminClaim.js <firebase-auth-uid>');
  process.exit(1);
}

admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'mirit-nails' });

admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => {
    console.log(`✓ admin:true claim set on uid ${uid}`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed to set custom claim:', err);
    process.exit(1);
  });
