'use strict';

const MAX_CUSTOMERS = 20;
const MAX_APPOINTMENTS = 10;

function normalizeName(name) {
  return name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function normalizedPhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.replace(/^00972/, '972').replace(/^0/, '972');
}

function parseCustomerSearch(value) {
  if (typeof value !== 'string' || value.length > 100) return null;
  const normalized = normalizeName(value);
  return /\p{L}/u.test(normalized) && Array.from(normalized).length >= 2 ? normalized : null;
}

// Firestore returns past appointments newest first. Keep recent entries for
// every identity so a legacy name can match a customer whose name changed.
async function findCustomerHistory(documents, search) {
  const groups = new Map();
  const words = search.split(' ');
  for await (const document of documents) {
    const appt = document.data();
    const time = appt.datetime?.toMillis?.();
    if (!Number.isFinite(time)) continue;

    const phone = normalizedPhone(appt.phone) || normalizedPhone(appt.phoneRaw);
    const key = phone ? 'phone:' + phone : 'appointment:' + document.id;
    const name = typeof appt.name === 'string' ? appt.name.trim().slice(0, 100) : '';
    const normalized = normalizeName(name);
    let group = groups.get(key);
    if (!group) {
      group = { name: '', phoneLastFour: phone.slice(-4), matches: false, exact: false, appointments: [] };
      groups.set(key, group);
    }
    if (!group.name) group.name = name;
    if (words.every(word => normalized.includes(word))) group.matches = true;
    if (normalized === search) group.exact = true;
    if (group.appointments.length === MAX_APPOINTMENTS) continue;

    group.appointments.push({
      time,
      services: typeof appt.services === 'string' ? appt.services.slice(0, 500) : '',
      branch: ['rehovot', 'modiin'].includes(appt.branch) ? appt.branch : null,
      status: ['cancelled', 'pending'].includes(appt.status) ? appt.status : null
    });
  }

  const matches = [...groups.values()].filter(group => group.matches)
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.appointments[0].time - a.appointments[0].time);
  return {
    customers: matches.slice(0, MAX_CUSTOMERS).map(({ name, phoneLastFour, appointments }) =>
      ({ name, phoneLastFour, appointments })),
    hasMore: matches.length > MAX_CUSTOMERS
  };
}

module.exports = { parseCustomerSearch, findCustomerHistory };
