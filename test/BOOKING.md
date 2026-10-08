# Booking deduplication

Run `npm run test:booking` with Node.js. These tests execute the production
persistence helper and the actual customer/manual submit handlers against an
optimistic transaction double with forced conflicts. They use synthetic data
and a stubbed webhook; they do not contact Firestore or Make.

The identity is normalized phone + branch + appointment timestamp. Both submit
paths use a deterministic Firestore document reference and a transaction. Only
the caller that creates the document sends the existing Make payload. Existing
random-ID appointments at the same time are reused without modification.
Cancelled/rescheduled records are preserved; deterministic successor IDs allow
booking the original time again. Transaction callbacks have no external effects.

No Firestore Rules, Cloud Functions, Make scenario, webhook URL, or webhook
field names/formats are changed. The appointment_id value remains an opaque
Firestore document ID, now derived from a hash instead of addDoc randomness.

Limits:
- This protects cooperating updated customer/manual clients. Existing open old
  clients and other writers can still create random-ID duplicates under the
  unchanged Rules. Reload the application after the Pages deployment.
- It does not prevent different customers booking overlapping appointments.
- It does not deduplicate existing data or serialize against every concurrent
  legacy-client write/admin reschedule.
- Webhook delivery remains best-effort, as before. A crash between the database
  commit and fetch can leave a booking without a Make call. A reused document
  deliberately does not resend: retrying an ambiguous external result safely
  would require durable delivery and receiver-side deduplication.
- Tests model transaction conflicts but are not a live Firebase/Make integration
  test. A deployment must not be described as an end-to-end Make verification.
