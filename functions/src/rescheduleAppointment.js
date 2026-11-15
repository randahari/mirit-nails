'use strict';

const { createHmac, randomUUID } = require('node:crypto');

const MAKE_WEBHOOK = /^https:\/\/hook\.eu1\.make\.com\/[a-z0-9]+$/;
const EVENT_ID = /^[A-Za-z0-9_-]{5,1024}$/;
const LOCK_DURATION_MS = 2 * 60_000;
const TIME_ZONE = 'Asia/Jerusalem';

class AppointmentEditError extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
    this.reason = reason;
  }
}

function readAppointment(snapshot, edit) {
  if (!snapshot.exists) throw new AppointmentEditError('not-found', 'appointment-missing');
  const appt = snapshot.data();
  const currentStart = appt.datetime?.toMillis();
  if (appt.status === 'cancelled' || currentStart !== edit.expectedStart ||
      (appt.editedAt?.toMillis() ?? null) !== edit.expectedEdit) {
    throw new AppointmentEditError('failed-precondition', 'appointment-changed');
  }
  if (currentStart !== Date.parse(edit.start) &&
      ['issued', 'pending'].includes(appt.receipt?.status)) {
    throw new AppointmentEditError('failed-precondition', 'receipt-locked');
  }
  if (typeof appt.eventId !== 'string' || !EVENT_ID.test(appt.eventId)) {
    throw new AppointmentEditError('failed-precondition', 'event-id-missing');
  }
  return appt;
}

async function updateCalendar(calendar, appt, edit, fetchImpl) {
  const start = new Date(edit.start);
  const end = new Date(start.getTime() + edit.duration * 60_000);
  const patch = JSON.stringify({
    start: { dateTime: start.toISOString(), timeZone: TIME_ZONE },
    end: { dateTime: end.toISOString(), timeZone: TIME_ZONE },
    summary: (appt.name || '') + edit.services
  });
  const sentAt = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', calendar.signingKey)
    .update([sentAt, appt.eventId, patch].join('|'))
    .digest('hex');

  const response = await fetchImpl(calendar.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      calendar_edit: 'update',
      calendar_event_id: appt.eventId,
      calendar_sent_at: sentAt,
      calendar_patch: patch,
      calendar_signature: signature
    })
  });
  if (!response.ok) throw new Error('Make HTTP ' + response.status);
  const result = await response.json();
  if (result?.status !== 'updated' || result.event_id !== appt.eventId) {
    throw new Error('Calendar update was not confirmed');
  }
}

async function rescheduleAppointment(request, { db, calendar, fetchImpl = fetch }) {
  if (request.auth?.token.admin !== true) {
    throw new AppointmentEditError('permission-denied', 'admin-required');
  }

  const edit = request.data ?? {};
  if (typeof edit.appointmentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(edit.appointmentId) ||
      typeof edit.start !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(edit.start) ||
      !Number.isFinite(Date.parse(edit.start)) || !Number.isSafeInteger(edit.expectedStart) ||
      (edit.expectedEdit !== null && !Number.isSafeInteger(edit.expectedEdit)) ||
      !Number.isInteger(edit.duration) || edit.duration < 1 || edit.duration > 1440 ||
      typeof edit.services !== 'string' || !edit.services.trim() || edit.services.length > 500 ||
      typeof edit.note !== 'string' || edit.note.length > 5000) {
    throw new AppointmentEditError('invalid-argument', 'invalid-edit');
  }
  if (typeof calendar?.signingKey !== 'string' || calendar.signingKey.length < 32 ||
      typeof calendar.webhookUrl !== 'string' || !MAKE_WEBHOOK.test(calendar.webhookUrl)) {
    throw new AppointmentEditError('unavailable', 'calendar-unavailable');
  }

  const apptRef = db.doc('appointments/' + edit.appointmentId);
  const lockRef = db.doc('appointment_edit_locks/' + edit.appointmentId);
  const lockId = randomUUID();

  const appt = await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(apptRef);
    const lock = await tx.get(lockRef);
    const current = readAppointment(snapshot, edit);
    const now = Date.now();
    if (lock.data()?.expiresAt > now) {
      throw new AppointmentEditError('aborted', 'appointment-busy');
    }
    tx.set(lockRef, { id: lockId, expiresAt: now + LOCK_DURATION_MS });
    return current;
  });

  try {
    await updateCalendar(calendar, appt, edit, fetchImpl);
  } catch {
    // Make may finish after a timeout. Keep the lease until it expires so
    // another edit does not immediately race an update with an unknown outcome.
    throw new AppointmentEditError('unavailable', 'calendar-unconfirmed');
  }

  try {
    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(apptRef);
      const lock = await tx.get(lockRef);
      const current = readAppointment(snapshot, edit);
      if (lock.data()?.id !== lockId || current.eventId !== appt.eventId ||
          current.name !== appt.name) {
        throw new Error('Appointment changed during the Calendar update');
      }
      tx.update(apptRef, {
        datetime: new Date(edit.start),
        services: edit.services,
        duration: edit.duration,
        note: edit.note,
        reminderSent: false,
        editedAt: new Date(),
        editedBy: 'mirit'
      });
      tx.delete(lockRef);
    });
  } catch {
    throw new AppointmentEditError('aborted', 'calendar-updated-save-unconfirmed');
  }

  return { eventId: appt.eventId };
}

module.exports = { AppointmentEditError, rescheduleAppointment };
