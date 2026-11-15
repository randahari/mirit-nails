'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCustomerSearch, findCustomerHistory } = require('../src/customerHistory');

function appointment(id, time, fields) {
  return { id, data: () => ({ datetime: { toMillis: () => time }, ...fields }) };
}

test('search accepts partial Hebrew names with or without marks and rejects invalid input', () => {
  assert.equal(parseCustomerSearch('  שָׂרָה-לוי  '), 'שרה לוי');
  assert.equal(parseCustomerSearch('Mírit'), 'mirit');
  for (const input of ['', 'ל', '1234', null, 'ל'.repeat(101)]) {
    assert.equal(parseCustomerSearch(input), null);
  }
});

test('history follows the stored phone identity across names and separates customers with the same name', async () => {
  const docs = [
    appointment('a', 40, { name: 'שרה ישראלי', phone: '050-1234567', services: 'לק ג׳ל', branch: 'modiin' }),
    appointment('b', 30, { name: 'שרה לוי', phone: '052-7654321', services: 'פדיקור' }),
    appointment('c', 20, { name: 'שרה לוי', phoneRaw: '+972 50 123 4567', services: 'מניקור', status: 'cancelled' }),
    appointment('d', 10, { name: 'שם אחר', phone: '054-0000000', services: 'מניקור' })
  ];
  const { customers, hasMore } = await findCustomerHistory(docs, 'שר לו');
  assert.deepEqual(customers.map(({ name, phoneLastFour }) => [name, phoneLastFour]),
    [['שרה ישראלי', '4567'], ['שרה לוי', '4321']]);
  assert.deepEqual(customers[0].appointments.map(({ time, services, status }) => [time, services, status]),
    [[40, 'לק ג׳ל', null], [20, 'מניקור', 'cancelled']]);
  assert.deepEqual(Object.keys(customers[0]).sort(), ['appointments', 'name', 'phoneLastFour']);
  assert.equal(hasMore, false);
});

test('results and recent visits are capped without losing a match on an old name', async () => {
  const docs = Array.from({ length: 11 }, (_, i) =>
    appointment('repeat-' + i, 100 - i, { name: 'שם מעודכן', phone: '050-0001234' }));
  docs.push(appointment('old', 89, { name: 'שם ישן', phone: '050-0001234' }));
  docs.push(...Array.from({ length: 21 }, (_, i) =>
    appointment('legacy-' + i, 40 - i, { name: 'שם ישן נוסף' })));

  const { customers, hasMore } = await findCustomerHistory(docs, 'שם ישן');
  assert.equal(customers.length, 20);
  assert.equal(customers[0].name, 'שם מעודכן');
  assert.equal(customers[0].appointments.length, 10);
  assert.equal(customers[0].appointments.at(-1).time, 91);
  assert.equal(customers[1].phoneLastFour, '');
  assert.equal(hasMore, true);
});
