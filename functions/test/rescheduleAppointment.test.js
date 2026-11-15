'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rescheduleAppointment } = require('../src/rescheduleAppointment');

const eventId = 'fixtureevent00';
const previousStart = Date.parse('2026-11-16T08:00:00.000Z');
const request = {
  auth: { token: { admin: true } },
  data: {
    appointmentId: 'fixture',
    expectedStart: previousStart,
    expectedEdit: null,
    start: '2026-11-16T10:00:00.000Z',
    services: 'טיפול "בדיקה"',
    duration: 45,
    note: 'synthetic'
  }
};

function fixture(fields = {}) {
  const appointment = {
    datetime: { toMillis: () => previousStart },
    eventId,
    status: 'confirmed',
    name: 'בדיקה',
    ...fields
  };
  const records = new Map([['appointments/fixture', appointment]]);
  const db = {
    doc: (path) => path,
    async runTransaction(callback) {
      const writes = [];
      const result = await callback({
        async get(path) {
          const data = records.get(path);
          return { exists: !!data, data: () => data };
        },
        set(path, value) { writes.push(() => records.set(path, value)); },
        update(path, value) { writes.push(() => records.set(path, { ...records.get(path), ...value })); },
        delete(path) { writes.push(() => records.delete(path)); }
      });
      writes.forEach((write) => write());
      return result;
    }
  };
  return { appointment, db, records };
}

const confirmed = (id = eventId) => ({
  ok: true,
  json: async () => ({ status: 1, outputs: { calendar_status: 200, event_id: id } })
});

test('updates the same event, then saves the corresponding time and service in Firestore', async () => {
  const { appointment, db, records } = fixture();
  const result = await rescheduleAppointment(request, {
    db, token: 'test-token',
    fetchImpl: async (url, options) => {
      assert.match(url, /\/scenarios\/8591093\/run$/);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.Authorization, 'Token test-token');
      const { data, responsive } = JSON.parse(options.body);
      assert.equal(responsive, true);
      assert.equal(data.event_id, eventId);
      const patch = JSON.parse(data.calendar_patch);
      assert.deepEqual(patch.start, { dateTime: request.data.start, timeZone: 'Asia/Jerusalem' });
      assert.equal(patch.end.dateTime, '2026-11-16T10:45:00.000Z');
      assert.equal(patch.summary, appointment.name + request.data.services);
      assert.equal(records.get('appointments/fixture'), appointment);
      return confirmed();
    }
  });
  const saved = records.get('appointments/fixture');
  assert.deepEqual(result, { eventId });
  assert.equal(saved.eventId, eventId);
  assert.equal(saved.datetime.toISOString(), request.data.start);
  assert.equal(saved.reminderSent, false);
  assert.equal(records.has('appointment_edit_locks/fixture'), false);
});

test('missing and legacy invalid IDs leave Calendar and Firestore untouched', async () => {
  for (const id of [null, 'Scenario failed to complete.']) {
    const { db, appointment, records } = fixture({ eventId: id });
    await assert.rejects(rescheduleAppointment(request, {
      db, token: 'test-token', fetchImpl: () => assert.fail('unexpected Calendar call')
    }), { reason: 'event-id-missing' });
    assert.equal(records.get('appointments/fixture'), appointment);
    assert.equal(records.size, 1);
  }
});

test('a stale edit, cancelled appointment or issued receipt cannot change the calendar', async () => {
  for (const [changes, expected] of [
    [{ editedAt: { toMillis: () => 1000 } }, 'appointment-changed'],
    [{ status: 'cancelled' }, 'appointment-changed'],
    [{ receipt: { status: 'issued' } }, 'receipt-locked']
  ]) {
    const { db } = fixture(changes);
    await assert.rejects(rescheduleAppointment(request, {
      db, token: 'test-token', fetchImpl: () => assert.fail('unexpected Calendar call')
    }), { reason: expected });
  }
});

test('non-admin requests cannot access either system', async () => {
  await assert.rejects(rescheduleAppointment({ ...request, auth: { token: {} } }, {
    db: { doc: () => assert.fail('unexpected Firestore access') }, token: 'test-token',
    fetchImpl: () => assert.fail('unexpected Calendar call')
  }), { reason: 'admin-required' });
});

test('an unconfirmed calendar update never saves the appointment', async () => {
  for (const fetchImpl of [
    async () => ({ ok: false, status: 410 }),
    async () => ({ ok: true, json: async () => ({ status: 2, outputs: { calendar_status: 502 } }) }),
    async () => confirmed('different-event'),
    async () => { throw new Error('timeout'); }
  ]) {
    const { appointment, db, records } = fixture();
    await assert.rejects(rescheduleAppointment(request, { db, token: 'test-token', fetchImpl }),
      { reason: 'calendar-unconfirmed' });
    assert.equal(records.get('appointments/fixture'), appointment);
    assert.equal(records.has('appointment_edit_locks/fixture'), true);
  }
});

test('another editor cannot send a second update while Calendar is handling the first', async () => {
  const { db } = fixture();
  let enteredCalendar;
  const entered = new Promise((resolve) => { enteredCalendar = resolve; });
  let finishCalendar;
  const finish = new Promise((resolve) => { finishCalendar = resolve; });
  const saving = rescheduleAppointment(request, {
    db, token: 'test-token',
    fetchImpl: async () => {
      enteredCalendar();
      await finish;
      return confirmed();
    }
  });
  await entered;
  try {
    await assert.rejects(rescheduleAppointment(request, {
      db, token: 'test-token', fetchImpl: () => assert.fail('unexpected second Calendar call')
    }), { reason: 'appointment-busy' });
  } finally {
    finishCalendar();
    await saving;
  }
});

test('a cancellation during Calendar sync is not overwritten or reported as saved', async () => {
  const { db, appointment, records } = fixture();
  await assert.rejects(rescheduleAppointment(request, {
    db, token: 'test-token',
    fetchImpl: async () => {
      records.set('appointments/fixture', { ...appointment, status: 'cancelled' });
      return confirmed();
    }
  }), { reason: 'calendar-updated-save-unconfirmed' });
  assert.equal(records.get('appointments/fixture').status, 'cancelled');
  assert.equal(records.get('appointments/fixture').datetime.toMillis(), previousStart);
});
