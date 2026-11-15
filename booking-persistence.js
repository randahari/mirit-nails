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

(function () {
  if (typeof document === 'undefined') return;

  // index.html loads this script before defining the original edit handler.
  // Install the calendar-backed save after the page scripts have run.
  document.addEventListener('DOMContentLoaded', () => {
    window.confirmEditAppt = async function() {
      const es = window._editState;
      if (es.saving || !es.apptId || !es.selectedDate || !es.selectedTime || es.services.length === 0) return;

      const btn = document.getElementById('edit-submit-btn');
      es.saving = true;
      btn.disabled = true;
      btn.style.opacity = '0.5';
      btn.style.pointerEvents = 'none';
      btn.textContent = 'שומרת...';

      try {
        const [h, m] = es.selectedTime.split(':').map(Number);
        const newDt = new Date(es.selectedDate);
        newDt.setHours(h, m, 0, 0);

        const { getFunctions, httpsCallable } = await import(
          'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js'
        );
        const functions = getFunctions(window._auth.app, 'europe-west1');
        const reschedule = httpsCallable(functions, 'rescheduleAppointment');
        await reschedule({
          appointmentId: es.apptId,
          expectedStart: es.appt.datetime.toMillis(),
          expectedEdit: es.appt.editedAt?.toMillis() ?? null,
          start: newDt.toISOString(),
          services: es.services.join(' + '),
          duration: es.totalDuration,
          note: document.getElementById('edit-note').value.trim()
        });

        if (window._editState === es) hideMiritEditModal();
        showToast('התור עודכן באפליקציה וביומן ✓');

        if (document.getElementById('screen-mirit').classList.contains('active')) loadMiritDashboard();
        if (document.getElementById('screen-mirit-appts').classList.contains('active')) loadMiritAppts();
      } catch (error) {
        const messages = {
          'event-id-missing': 'לתור הזה חסר קישור ליומן Google. השינוי לא נשמר.',
          'appointment-missing': 'התור כבר לא קיים. רענני את הרשימה.',
          'appointment-changed': 'התור השתנה מאז שפתחת אותו. פתחי אותו מחדש.',
          'appointment-busy': 'יש עדכון קודם לתור הזה. המתיני מעט ונסי שוב.',
          'receipt-locked': 'אי אפשר לשנות את שעת התור לאחר הפקת קבלה או בזמן הפקתה.',
          'calendar-unavailable': 'החיבור ליומן לא זמין כרגע. השינוי לא נשמר.',
          'calendar-unconfirmed': 'לא התקבל אישור מיומן Google. השינוי לא נשמר באפליקציה.',
          'calendar-updated-save-unconfirmed': 'היומן עודכן, אבל השמירה באפליקציה לא אושרה. רענני ובדקי את התור.'
        };
        showToast(messages[error.details?.reason] || 'לא התקבל אישור לשמירת התור. רענני ובדקי לפני ניסיון נוסף.');
      } finally {
        es.saving = false;
        btn.disabled = false;
        btn.textContent = 'שמרי שינוי';
        checkEditForm();
      }
    };
  }, { once: true });
})();
