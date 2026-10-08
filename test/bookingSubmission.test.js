'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createBookingStore } = require('../booking-persistence');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
class Timestamp {
  constructor(ms) { this.ms = ms; }
  toMillis() { return this.ms; }
  toDate() { return new Date(this.ms); }
  static now() { return new Timestamp(Date.now()); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
}
const normalizePhone = raw => String(raw || '').replace(/\D/g, '').replace(/^0/, '972');
const booking = overrides => ({
  name: 'Test Customer', phone: '972500000000', phoneRaw: '0500000000',
  branch: 'rehovot', services: 'Test service', duration: 45,
  datetime: new Timestamp(new Date(2030, 0, 7, 10, 0).getTime()),
  status: 'confirmed', createdAt: Timestamp.now(), eventId: null, ...overrides
});

// In-memory optimistic transaction model: validates every read at commit and
// retries conflicts. No network, real customer data or Make endpoints are used.
function database(startTogether = 0) {
  const rows = new Map(), versions = new Map();
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const put = (id, data) => { rows.set(id, data); versions.set(id, (versions.get(id) || 0) + 1); };
  const snap = id => ({ id, ref: { id }, exists: () => rows.has(id), data: () => rows.get(id) });
  let retries = 0;
  const api = {
    db: {}, crypto: webcrypto, normalizePhone,
    collection: () => ({}), doc: (_, collection, id) => ({ id }),
    where: (field, op, value) => ({ field, value }), query: (_, filter) => filter,
    getDocs: async filter => ({ docs: [...rows.keys()]
      .filter(id => rows.get(id).datetime?.toMillis() === filter.value.toMillis())
      .map(id => ({ ...snap(id), data: () => rows.get(id) })) }),
    runTransaction: async (_, fn) => {
      if (startTogether && arrivals < startTogether) {
        arrivals++;
        if (arrivals === startTogether) release();
        await barrier;
      }
      for (let attempt = 0; attempt < 30; attempt++) {
        const reads = new Map(), writes = [];
        const result = await fn({
          get: async ref => {
            reads.set(ref.id, versions.get(ref.id) || 0);
            const data = rows.get(ref.id);
            await Promise.resolve();
            return { exists: () => data !== undefined, data: () => data };
          },
          set: (ref, data) => writes.push([ref.id, data])
        });
        if ([...reads].some(([id, version]) => (versions.get(id) || 0) !== version)) {
          retries++; continue;
        }
        for (const [id, data] of writes) put(id, data);
        return result;
      }
      throw new Error('Too many conflicts');
    }
  };
  return { api, rows, put, retries: () => retries };
}
function page(db, options = {}) {
  const elements = new Map();
  function el(id) {
    if (!elements.has(id)) elements.set(id, {
      style: {}, innerHTML: 'Submit', textContent: '',
      value: id.includes('name') ? 'Test Customer' : id.includes('phone') ? '0500000000' : '',
      classList: { contains: () => true }
    });
    return elements.get(id);
  }
  const requests = [], toasts = [];
  const state = {
    branch: 'rehovot', services: ['Test service'], totalDuration: 45,
    selectedTime: '10:00', selectedDate: new Date(2030, 0, 7), chips: [], screenHistory: []
  };
  const context = {
    createBookingStore, crypto: webcrypto, TextEncoder, console: { error() {}, warn() {} },
    document: { getElementById: el }, state, normalizePhoneForStorage: normalizePhone,
    validateSlotBookable: async () => {
      if (options.validationError) throw new Error('Validation unavailable');
      return { ok: !options.invalidSlot, reason: 'Closed' };
    },
    loadTimeSlots() {}, showToast: m => toasts.push(m),
    goTo() { if (options.uiError) throw new Error('UI error'); },
    closeManualBooking() { if (options.uiError) throw new Error('UI error'); },
    loadMiritDashboard() {}, setTimeout() {},
    localStorage: { setItem() { if (options.storageError) throw new Error('Storage disabled'); } },
    WEBHOOK_BOOKING: 'https://example.invalid/booking',
    fetch: async (url, args) => {
      requests.push({ url, ...args, payload: JSON.parse(args.body) });
      return { text: async () => '{"event_id":"test-event"}' };
    },
    _db: db.api.db, _col: db.api.collection, _doc: db.api.doc,
    _query: db.api.query, _where: db.api.where, _getDocs: db.api.getDocs,
    _runTransaction: db.api.runTransaction, _Timestamp: Timestamp,
    _updateDoc: async () => {}, _manualState: { ...state }
  };
  context.window = context;
  vm.createContext(context);
  const persistence = html.slice(html.indexOf('// Shared persistence for both'), html.indexOf('// ===== HISTORY'));
  const manual = html.slice(html.indexOf('let manualBookingSubmissionInProgress'), html.indexOf('// ===== BRANCH SELECTION'));
  vm.runInContext(persistence + '\n' + manual, context);
  return { context, requests, toasts, elements };
}

test('four concurrent callers converge to one appointment and one creator', async () => {
  const db = database(4);
  const results = await Promise.all(Array.from({ length: 4 }, () => createBookingStore(db.api).save(booking())));
  assert.equal(db.rows.size, 1);
  assert.equal(new Set(results.map(r => r.id)).size, 1);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.ok(db.retries() > 0);
  assert.ok(!results[0].id.includes('972500000000'));
});
test('reload/retry and modified name/services preserve the original appointment', async () => {
  const db = database();
  const first = await createBookingStore(db.api).save(booking({ receipt: { status: 'issued' } }));
  const again = await createBookingStore(db.api).save(booking({ name: 'Other spelling', services: 'Different' }));
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  assert.equal(again.booking.services, 'Test service');
  assert.equal(again.booking.receipt.status, 'issued');
});
test('legacy random-ID appointment is reused without overwriting it', async () => {
  const db = database(), data = booking({ phone: '0500000000' });
  db.put('legacy-random-id', data);
  const result = await createBookingStore(db.api).save(booking());
  assert.equal(result.id, 'legacy-random-id');
  assert.equal(result.created, false);
  assert.equal(db.rows.get(result.id), data);
});
test('cancel then concurrent rebook creates one new generation and preserves history', async () => {
  const db = database(), store = createBookingStore(db.api);
  const first = await store.save(booking());
  const cancelled = { ...first.booking, status: 'cancelled', receipt: { status: 'issued' } };
  db.put(first.id, cancelled);
  const results = await Promise.all([store.save(booking()), store.save(booking())]);
  assert.equal(results[0].id, first.id + '_1');
  assert.equal(results[1].id, results[0].id);
  assert.equal(results.filter(r => r.created).length, 1);
  assert.equal(db.rows.get(first.id), cancelled);
});
test('rescheduled appointment is preserved when its former time is booked again', async () => {
  const db = database(), store = createBookingStore(db.api);
  const first = await store.save(booking());
  const moved = { ...first.booking, datetime: new Timestamp(first.booking.datetime.toMillis() + 3600000) };
  db.put(first.id, moved);
  const result = await store.save(booking());
  assert.equal(result.id, first.id + '_1');
  assert.equal(db.rows.get(first.id), moved);
});
test('different time, phone or branch is a different booking', async () => {
  const db = database(), store = createBookingStore(db.api);
  await store.save(booking());
  await store.save(booking({ phone: '972511111111' }));
  await store.save(booking({ branch: 'modiin' }));
  await store.save(booking({ datetime: new Timestamp(12345) }));
  assert.equal(db.rows.size, 4);
});
test('query failure fails closed without creating a document', async () => {
  const db = database();
  db.api.getDocs = async () => { throw new Error('Offline'); };
  await assert.rejects(createBookingStore(db.api).save(booking()), /Offline/);
  assert.equal(db.rows.size, 0);
});
test('actual customer handler: rapid calls send one unchanged Make payload', async () => {
  const db = database(), p = page(db);
  await Promise.all(Array.from({ length: 4 }, () => p.context.submitBooking()));
  assert.equal(db.rows.size, 1);
  assert.equal(p.requests.length, 1);
  const payload = p.requests[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), [
    'appointment_id', 'branch', 'date', 'datetime_iso', 'duration', 'name', 'phone', 'services', 'time'
  ]);
  assert.equal(payload.phone, '972500000000');
  assert.equal(payload.name, 'Test Customer');
  assert.equal(payload.duration, 45);
  assert.equal(payload.services, 'Test service');
  assert.equal(payload.branch, 'רחובות - חיים קאופמן 8');
  assert.equal(payload.datetime_iso, new Date(2030, 0, 7, 10, 0).toISOString());
  assert.equal(payload.appointment_id, [...db.rows.keys()][0]);
  await p.context.submitBooking();
  assert.equal(p.requests.length, 1);
});
test('actual customer and manual handlers across four pages send Make once', async () => {
  const db = database(4), pages = Array.from({ length: 4 }, () => page(db));
  await Promise.all(pages.map((p, i) => i % 2 ? p.context.submitManualBooking() : p.context.submitBooking()));
  assert.equal(db.rows.size, 1);
  assert.equal(pages.reduce((n, p) => n + p.requests.length, 0), 1);
});
test('manual handler keeps created_by_mirit and deduplicates rapid calls', async () => {
  const db = database(), p = page(db);
  await Promise.all([p.context.submitManualBooking(), p.context.submitManualBooking()]);
  assert.equal(db.rows.size, 1);
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].payload.created_by_mirit, true);
  assert.equal([...db.rows.values()][0].createdByMirit, true);
});
test('blocked localStorage does not turn a saved booking into failure', async () => {
  const db = database(), p = page(db, { storageError: true });
  await p.context.submitBooking();
  await p.context.submitBooking();
  assert.equal(db.rows.size, 1);
  assert.equal(p.requests.length, 1);
  assert.equal(p.toasts.length, 0);
});
test('UI failure after commit reports saved; retry cannot duplicate or resend', async () => {
  for (const handler of ['submitBooking', 'submitManualBooking']) {
    const db = database(), p = page(db, { uiError: true });
    await p.context[handler]();
    await p.context[handler]();
    assert.equal(db.rows.size, 1);
    assert.equal(p.requests.length, 1);
    assert.ok(p.toasts.some(t => t.includes('התור נשמר')));
    assert.ok(!p.toasts.some(t => t.includes('שגיאה')));
  }
});
test('validation errors release the customer lock for a later attempt', async () => {
  const db = database(), options = { validationError: true }, p = page(db, options);
  await p.context.submitBooking();
  assert.equal(db.rows.size, 0);
  options.validationError = false;
  await p.context.submitBooking();
  assert.equal(db.rows.size, 1);
});
test('after success a genuinely different date can be booked in the same page', async () => {
  const db = database(), p = page(db);
  await p.context.submitBooking();
  p.context.state.selectedDate = new Date(2030, 0, 8);
  await p.context.submitBooking();
  assert.equal(db.rows.size, 2);
  assert.equal(p.requests.length, 2);
});
test('HTML scripts and worker parse; helper is loaded before booking handlers', () => {
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (m[2].trim() && !m[1].includes('module')) new vm.Script(m[2]);
  }
  new vm.Script(fs.readFileSync(require.resolve('../sw.js'), 'utf8'));
  assert.ok(html.indexOf('src="booking-persistence.js"') < html.indexOf('window.submitBooking'));
});
