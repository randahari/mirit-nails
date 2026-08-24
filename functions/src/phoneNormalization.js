// Server-side port of index.html's normalizePhoneForStorage(). Per explicit
// instruction: do not invent a second normalization convention — this must
// stay byte-for-byte behaviorally identical to the client version. Proven
// identical across the full format matrix by
// test/phoneNormalization.test.js (which re-implements the client function
// verbatim in a second place purely to assert the two never drift, not as
// a second convention).
//
// Client source (index.html, "===== Phone normalization ====="):
//   function normalizePhoneForStorage(raw) {
//     if (!raw) return '';
//     return String(raw).replace(/\D/g,'').replace(/^972/, '972').replace(/^0/, '972');
//   }
'use strict';

function normalizePhoneForStorage(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').replace(/^972/, '972').replace(/^0/, '972');
}

// NOT part of the client's normalization semantics (which never rejects
// anything — it just returns whatever digits remain, even "123"). Needed
// here because this server-side flow turns the result into an Invoice4U
// ExtNumber and must refuse obviously-invalid input before ever calling
// Invoice4U, rather than sending a nonsense ExtNumber. A real Israeli
// number (mobile or landline) normalizes to "972" + 8-10 more digits.
function isValidNormalizedPhone(normalized) {
  return /^972\d{8,10}$/.test(normalized);
}

module.exports = { normalizePhoneForStorage, isValidNormalizedPhone };
