/* Shared customer/manual booking persistence. No external effects in transactions. */
(function (root) {
  'use strict';
  function createBookingStore(api) {
    function matches(a, b) {
      return a.status !== 'cancelled' &&
        api.normalizePhone(a.phone) === api.normalizePhone(b.phone) &&
        a.branch === b.branch && a.datetime?.toMillis() === b.datetime.toMillis();
    }

    async function save(booking) {
      const phone = api.normalizePhone(booking.phone);
      if (!phone || !booking.branch || !Number.isFinite(booking.datetime?.toMillis())) {
        throw new Error('Invalid booking identity');
      }
      // Hash avoids putting a customer's phone number in document IDs / webhook IDs.
      // Services/name are deliberately excluded: editing those is not a new time slot.
      const identity = JSON.stringify([phone, booking.branch, booking.datetime.toMillis()]);
      const digest = await api.crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      const baseId = 'booking_' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');

      // Compatibility with appointments previously created using random IDs.
      // One equality filter uses Firestore's default single-field index.
      const legacy = await api.getDocs(api.query(api.collection(api.db, 'appointments'),
        api.where('datetime', '==', booking.datetime)));
      const candidates = legacy.docs.filter(d => matches(d.data(), booking)).map(d => d.ref);

      return api.runTransaction(api.db, async tx => {
        // Re-read candidates inside the transaction; never trust a stale status.
        for (const ref of candidates) {
          const snap = await tx.get(ref);
          if (snap.exists() && matches(snap.data(), booking)) {
            return { id: ref.id, booking: snap.data(), created: false };
          }
        }
        // Cancelled or rescheduled documents remain untouched (including receipts).
        // Every caller walks the same generation chain, including across reloads.
        for (let generation = 0; generation < 100; generation++) {
          const id = baseId + (generation ? '_' + generation : '');
          const ref = api.doc(api.db, 'appointments', id);
          const snap = await tx.get(ref);
          if (snap.exists()) {
            if (matches(snap.data(), booking)) {
              return { id, booking: snap.data(), created: false };
            }
            continue;
          }
          tx.set(ref, booking);
          return { id, booking, created: true };
        }
        throw new Error('Booking generation limit reached');
      });
    }
    return { save };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createBookingStore };
  else root.createBookingStore = createBookingStore;
})(typeof window !== 'undefined' ? window : globalThis);

