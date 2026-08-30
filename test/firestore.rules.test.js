// Firestore Security Rules verification — proposed rules vs. every flow
// listed as a required check (investigation doc §11 OQ#2 follow-up).
//
// Runs entirely against the local Firestore emulator. Does NOT touch
// production, and the proposed rules are NOT deployed anywhere by this
// file or by running it.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} = require('@firebase/rules-unit-testing');

let testEnv;

test.before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'mirit-nails-rules-test',
    firestore: {
      rules: fs.readFileSync(path.resolve(__dirname, '../firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

test.after(async () => {
  await testEnv.cleanup();
});

test.beforeEach(async () => {
  await testEnv.clearFirestore();
  // Seed one existing appointment, as an authenticated admin bypass context,
  // so update/delete checks have something real to act on.
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('appointments/appt1').set({
      name: 'לקוחה לדוגמה',
      phone: '972500000000',
      branch: 'rehovot',
      services: 'לק ג\'ל רגיל',
      duration: 45,
      status: 'confirmed',
    });
    await ctx.firestore().doc('availability/settings').set({ rehovot: {}, modiin: {} });
  });
});

function anon() {
  return testEnv.unauthenticatedContext().firestore();
}
function admin() {
  return testEnv.authenticatedContext('mirit-uid', { admin: true }).firestore();
}
function loggedInNonAdmin() {
  return testEnv.authenticatedContext('someone-else-uid', {}).firestore();
}

// ---- 1. Customer can view availability needed for booking ----
test('customer (unauthenticated) can read availability/settings', async () => {
  await assertSucceeds(anon().doc('availability/settings').get());
});
test('customer (unauthenticated) can read blocked_slots', async () => {
  await assertSucceeds(anon().collection('blocked_slots').get());
});

// ---- 2. Customer can create a new appointment without Firebase Auth ----
test('customer (unauthenticated) can create an appointment', async () => {
  await assertSucceeds(
    anon().doc('appointments/newAppt').set({
      name: 'לקוחה חדשה', phone: '972500000001', branch: 'modiin',
      services: 'גבות', duration: 15, status: 'confirmed',
    })
  );
});

// ---- 3. Customer cannot change financial or receipt fields ----
test('customer (unauthenticated) CANNOT write payment.* on an appointment', async () => {
  await assertFails(
    anon().doc('appointments/appt1').update({
      payment: { amount: 120, method: 'cash', confirmedAt: new Date(), confirmedByUid: 'x' },
    })
  );
});
test('customer (unauthenticated) CANNOT write receipt.* on an appointment', async () => {
  await assertFails(
    anon().doc('appointments/appt1').update({ receipt: { status: 'issued' } })
  );
});
test('authenticated ADMIN also CANNOT write payment.*/receipt.* directly (server-only, by design)', async () => {
  await assertFails(
    admin().doc('appointments/appt1').update({
      payment: { amount: 120, method: 'cash', confirmedAt: new Date(), confirmedByUid: 'mirit-uid' },
    })
  );
  await assertFails(
    admin().doc('appointments/appt1').update({ receipt: { status: 'issued' } })
  );
});

// ---- customer self-cancel must keep working (non-financial update) ----
test('customer (unauthenticated) CAN still update non-financial fields (e.g. self-cancel)', async () => {
  await assertSucceeds(anon().doc('appointments/appt1').update({ status: 'cancelled' }));
});

// ---- 4. Customer cannot read config/secrets-adjacent collection ----
test('customer (unauthenticated) CANNOT read config/invoice4uIntegration', async () => {
  await assertFails(anon().doc('config/invoice4uIntegration').get());
});
test('authenticated ADMIN also CANNOT read config/invoice4uIntegration from the client (server/Admin-SDK-only)', async () => {
  await assertFails(admin().doc('config/invoice4uIntegration').get());
});
test('nobody can write config/invoice4uIntegration from any client', async () => {
  await assertFails(anon().doc('config/invoice4uIntegration').set({ documentType: 2 }));
  await assertFails(admin().doc('config/invoice4uIntegration').set({ documentType: 2 }));
});

// ---- 5. Customer cannot change blocked_slots or availability ----
test('customer (unauthenticated) CANNOT write blocked_slots', async () => {
  await assertFails(anon().collection('blocked_slots').add({ date: '2026-09-01' }));
});
test('customer (unauthenticated) CANNOT write availability/settings', async () => {
  await assertFails(anon().doc('availability/settings').set({ rehovot: {} }, { merge: true }));
});
test('logged-in user WITHOUT the admin claim also CANNOT write blocked_slots', async () => {
  await assertFails(loggedInNonAdmin().collection('blocked_slots').add({ date: '2026-09-01' }));
});

// ---- 6. Authenticated admin CAN perform all existing admin operations ----
test('admin CAN edit an appointment (services/branch/datetime) — miritEditAppt', async () => {
  await assertSucceeds(
    admin().doc('appointments/appt1').update({ services: 'פדיקור לק ג\'ל', duration: 75 })
  );
});
test('admin CAN cancel an appointment — miritCancelAppt', async () => {
  await assertSucceeds(admin().doc('appointments/appt1').update({ status: 'cancelled' }));
});
test('admin CAN write blocked_slots (create + delete)', async () => {
  const ref = admin().collection('blocked_slots').doc('block1');
  await assertSucceeds(ref.set({ date: '2026-09-01', note: 'חופש' }));
  await assertSucceeds(ref.delete());
});
test('admin CAN write availability/settings', async () => {
  await assertSucceeds(
    admin().doc('availability/settings').set({ rehovot: { 0: { open: true } } }, { merge: true })
  );
});
test('admin CAN delete an appointment', async () => {
  await assertSucceeds(admin().doc('appointments/appt1').delete());
});

// ---- 7. Rules change does not break edit / cancel / reschedule flows ----
test('reschedule (datetime + duration update) by admin succeeds end to end', async () => {
  await assertSucceeds(
    admin().doc('appointments/appt1').update({
      datetime: new Date('2026-09-05T10:00:00Z'),
      duration: 60,
    })
  );
});

// ---- 9. `name` requires admin (2026-08-24, customer-name-edit feature) ----
test('admin CAN change name — customer-name-edit feature', async () => {
  await assertSucceeds(
    admin().doc('appointments/appt1').update({ name: 'שם מתוקן', nameEditedAt: new Date() })
  );
});
test('customer (unauthenticated) CANNOT change name', async () => {
  await assertFails(anon().doc('appointments/appt1').update({ name: 'שם מזויף' }));
});
test('logged-in user WITHOUT the admin claim also CANNOT change name', async () => {
  await assertFails(loggedInNonAdmin().doc('appointments/appt1').update({ name: 'שם מזויף' }));
});
test('non-admin CANNOT change name even when bundled with an otherwise-permitted field', async () => {
  await assertFails(anon().doc('appointments/appt1').update({ name: 'שם מזויף', status: 'cancelled' }));
});
test('existing self-cancel / reschedule flows (no `name` touched) remain unaffected by the new name rule', async () => {
  await assertSucceeds(anon().doc('appointments/appt1').update({ status: 'cancelled' }));
  await assertSucceeds(admin().doc('appointments/appt1').update({ services: 'פדיקור לק ג\'ל', duration: 75 }));
});

// ---- 8. Cloud Functions (Admin SDK) note ----
// The Admin SDK used inside Cloud Functions bypasses Security Rules entirely
// by design (this is documented Firebase behavior, not something these
// client-shaped rules-unit-testing calls can exercise). Confirmed instead by
// withSecurityRulesDisabled() above, which is how the Admin SDK's rule-free
// access is actually modeled by this same testing library.
test('sanity: Admin-SDK-equivalent access (rules disabled) can read config/*', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().doc('config/invoice4uIntegration').set({ documentType: 2 });
    const snap = await ctx.firestore().doc('config/invoice4uIntegration').get();
    assert.equal(snap.data().documentType, 2);
  });
});
