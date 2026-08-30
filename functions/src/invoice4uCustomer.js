// Resolves a Firestore appointment's customer into a verified Invoice4U
// ClientID, so createReceipt() can send DocumentType=2 (Receipt) with a
// real customer instead of GeneralCustomer — required per the confirmed
// contract (Error 38, TypeOfDocumentDoesntAllowGeneralCustomer; see
// investigation history). Architecture decision (2026-08-24, final):
//   - identity key toward Invoice4U: ExtNumber = Number(normalized phone)
//     — NOT UniqueID (that field is documented as "VAT/company/ID number",
//     a different real-world meaning we must not misuse) and NOT
//     Phone/Cell (searchable but never documented as unique — no dedup
//     guarantee, so not usable as an authoritative key).
//   - normalization: reuses the app's existing normalizePhoneForStorage
//     convention verbatim (phoneNormalization.js) — no second convention.
//   - no local `customers` collection (Option A, explicitly decided over
//     Option B after architecture review) — Invoice4U itself is the
//     authoritative source of the phone→ClientID mapping. This module
//     never guesses a ClientID; every path either returns one Invoice4U
//     actually confirmed, or throws.
//
// Response-shape defense: we have already been burned three times by
// Invoice4U's documentation not matching its real response envelope for a
// SIBLING endpoint on this exact service (CreateDocumentWithIdentifierValidation
// — documented as flat, empirically a top-level "d" envelope with no
// further nesting). GetCustomers/CreateCustomer's documented envelopes
// (GetCustomersResult / CreateCustomerResult, no "d") are therefore
// UNVERIFIED against real production behavior — see the completion report
// for the exact empirical-verification plan. Every response here is
// validated explicitly; nothing is assumed, and any mismatch fails safely
// with structural (never full-body) diagnostics — the same posture that
// let us find the real shape for the document endpoint, applied from day
// one here instead of after a real failure.
'use strict';

const { invoice4uApiToken, HOSTS } = require('./invoice4uClient');
const { mockResolveInvoice4uCustomer } = require('./invoice4uCustomerMock');
const { normalizePhoneForStorage, isValidNormalizedPhone } = require('./phoneNormalization');

const REQUEST_TIMEOUT_MS = 20_000;

// Same allowlist-based safety pattern already proven for the document
// endpoint's diagnostics — only these field names are ever pulled out of
// an Invoice4U error object, never anything from the outgoing request.
const ERROR_FIELD_ALLOWLIST = ['ID', 'Error', 'Message', 'Description'];

function pickErrorFields(e) {
  const picked = {};
  for (const key of ERROR_FIELD_ALLOWLIST) {
    if (e && e[key] !== undefined) picked[key] = e[key];
  }
  return picked;
}

// CustomerExternalNumberExists — documented two ways across Invoice4U's
// own docs (as the Errors[].ID value -2, and separately as catalog code
// 31 for the same condition). Treated identically: not a fatal error, the
// signal to fall back to one more lookup (see resolveInvoice4uCustomer).
function isDuplicateExtNumberError(err) {
  return err && (err.ID === -2 || err.ID === 31);
}

async function fetchInvoice4u(path, body) {
  const token = invoice4uApiToken.value();
  if (!token) {
    const err = new Error('Invoice4U API token secret is not configured');
    err.code = 'CUSTOMER_NOT_CONFIGURED';
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${HOSTS.production}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, token }),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Invoice4U ${path} timed out — customer state is unknown`);
      err.code = 'CUSTOMER_TIMEOUT';
      throw err;
    }
    const err = new Error(`Invoice4U ${path} network error: ${e.message}`);
    err.code = 'CUSTOMER_NETWORK_ERROR';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Explicitly validates a response against ONE documented shape. Two modes:
 *   - resultInD=true: the result is json.d DIRECTLY (no further nested
 *     "{MethodName}Result" wrapper) — VERIFIED against real production
 *     logs for GetCustomers (2026-08-24): the real response is
 *     { d: { Response, Errors, __type, Info, OpenInfo, RecaptchaToken } },
 *     with no "GetCustomersResult" key anywhere. Same pattern already
 *     proven for the document endpoint — "d" replaces the documented
 *     "{MethodName}Result" naming, it doesn't additionally contain it.
 *   - resultInD=false (default): the result is json[wrapperKey] at the top
 *     level, per Invoice4U's documentation — used for CreateCustomer,
 *     whose real response envelope is still UNVERIFIED. Left unchanged
 *     deliberately; do not assume it also needs resultInD until it's been
 *     seen for real, the same way GetCustomers just was.
 * No blind fallback either way — any mismatch (missing wrapper, wrong
 * type, fails validate()) throws CUSTOMER_INVALID_RESPONSE_SHAPE with only
 * structural diagnostics (key names, types) logged — never the response
 * body, never request contents.
 */
async function parseInvoice4uResponse(res, { path, wrapperKey, extNumber, validate, resultInD = false, nullDIsNotFound = false }) {
  if (!res.ok) {
    let bodyExcerpt = '';
    try { bodyExcerpt = (await res.text()).slice(0, 300); } catch (e) { /* best-effort only */ }
    console.error('[invoice4uCustomer] Invoice4U returned a non-OK HTTP status', {
      stage: path, extNumber, httpStatus: res.status, bodyExcerpt,
    });
    const err = new Error(`Invoice4U ${path} HTTP ${res.status}`);
    err.code = 'CUSTOMER_HTTP_ERROR';
    throw err;
  }

  const json = await res.json();
  const dValue = json?.d;
  const dIsPlainObject = dValue !== null && typeof dValue === 'object' && !Array.isArray(dValue);

  // VERIFIED against real production evidence (2026-08-24): for
  // GetCustomerByExternalNumber specifically, a genuinely new customer
  // produces exactly { "d": null } — Invoice4U's real NOT_FOUND signal for
  // this single-record lookup, not an Errors[] entry. Opt-in only
  // (nullDIsNotFound) — every other caller of this function still
  // correctly rejects d===null as a malformed response, unchanged.
  if (resultInD && nullDIsNotFound && dValue === null) {
    return null;
  }

  const result = resultInD ? dValue : json?.[wrapperKey];
  const resultIsValidObject = result !== null && typeof result === 'object' && !Array.isArray(result) && validate(result);

  if (!resultIsValidObject) {
    // Structural-only diagnostic: key names and types ONLY — never any
    // value from Response/customer objects/Name/Phone/Cell/Email/Address/
    // token/request body/IDs. Kept for whichever mode is active so a
    // future CreateCustomer mismatch is just as diagnosable as this one was.
    const nestedWrapperValue = dIsPlainObject && wrapperKey ? dValue[wrapperKey] : undefined;
    const nestedWrapperIsObject = nestedWrapperValue !== null && typeof nestedWrapperValue === 'object' && !Array.isArray(nestedWrapperValue);

    console.error('[invoice4uCustomer] Invoice4U response missing/malformed expected wrapper', {
      stage: path,
      expectedContract: resultInD ? 'top-level "d" (object, no further nested wrapper)' : `top-level "${wrapperKey}"`,
      extNumber,
      expectedKey: resultInD ? 'd' : wrapperKey,
      receivedTopLevelKeys: json && typeof json === 'object' ? Object.keys(json) : typeof json,
      dType: typeof dValue,
      dIsObject: dIsPlainObject,
      keysInD: dIsPlainObject ? Object.keys(dValue) : undefined,
      keysInDWrapper: nestedWrapperIsObject ? Object.keys(nestedWrapperValue) : undefined,
    });
    const err = new Error(`Invoice4U ${path} response missing expected ${resultInD ? '"d"' : `"${wrapperKey}"`} wrapper`);
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  return result;
}

// NOTE: the generic GetCustomers multi-field search was removed from this
// module (2026-08-24 cleanup) after being proven unreliable for ExtNumber
// resolution in real production — it returned 0 matches for an ExtNumber
// that both CreateCustomer's own duplicate-check AND the dedicated
// GetCustomerByExternalNumber endpoint (see below) correctly confirmed as
// an existing customer. See git history (functions/src/invoice4uCustomer.js,
// pre-cleanup revision) if a generic multi-field search is ever needed
// again — GetCustomerByExternalNumber is the sole supported lookup now.

/**
 * Looks up a customer by ExtNumber via the dedicated, purpose-built
 * endpoint — VERIFIED against real, approved, read-only production calls
 * (2026-08-24): { number: extNumber, token } → { d: { ID, Name, ExtNumber,
 * Errors: [], ...full Customer object } } for an existing customer, no
 * further nested wrapper (same "d"-is-the-result pattern as every other
 * endpoint on this service). Correctly resolved a customer the generic
 * GetCustomers search could not find for the identical ExtNumber. Returns
 * the Customer object if found, or null if Invoice4U indicates no such
 * customer exists.
 *
 * "Not found" detection is now VERIFIED, not inferred: a real production
 * attempt for a genuinely new customer (2026-08-24) produced exactly
 * { "d": null } — handled via parseInvoice4uResponse's nullDIsNotFound
 * flag. This IS Invoice4U's real NOT_FOUND response for this endpoint.
 */
async function getCustomerByExternalNumber(extNumber) {
  const res = await fetchInvoice4u('GetCustomerByExternalNumber', { number: extNumber });
  const result = await parseInvoice4uResponse(res, {
    path: 'GetCustomerByExternalNumber',
    resultInD: true,
    nullDIsNotFound: true,
    extNumber,
    validate: (r) => 'Errors' in r || 'ID' in r,
  });

  if (result === null) {
    // VERIFIED (2026-08-24): { d: null } is the real NOT_FOUND response.
    return null;
  }

  const errors = Array.isArray(result.Errors) ? result.Errors : [];

  // Defensive secondary signal only — UNVERIFIED for this endpoint, never
  // actually observed. Kept in case Invoice4U also uses this Errors[]
  // shape for "not found" in some circumstance we haven't seen, but it is
  // checked strictly AFTER the verified d:null path above and can never
  // override or interfere with it.
  const notFoundLegacyUnverified = errors.some((e) => e.ID === 7);
  if (notFoundLegacyUnverified) {
    return null;
  }

  const isRealError = errors.length > 0;
  if (isRealError) {
    console.error('[invoice4uCustomer] GetCustomerByExternalNumber returned a business-level error', {
      extNumber, errors: errors.map(pickErrorFields),
    });
    const err = new Error(errors.map((e) => e.Error).join('; ') || 'Invoice4U GetCustomerByExternalNumber returned an error');
    err.code = 'CUSTOMER_ERROR';
    err.invoice4uErrors = errors;
    throw err;
  }

  if (result.ID == null) {
    console.error('[invoice4uCustomer] GetCustomerByExternalNumber reported no errors but returned no ID', { extNumber });
    const err = new Error('Invoice4U GetCustomerByExternalNumber reported no errors but returned no ID');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  if (String(result.ExtNumber) !== String(extNumber)) {
    console.error('[invoice4uCustomer] GetCustomerByExternalNumber returned a mismatched ExtNumber', {
      requestedExtNumber: extNumber, returnedExtNumberType: typeof result.ExtNumber,
    });
    const err = new Error('Invoice4U GetCustomerByExternalNumber returned a customer with a mismatched ExtNumber');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  // Returns the FULL Customer object (2026-08-24, customer-name-edit
  // feature) — previously narrowed to { ID: result.ID } here, but a
  // caller that needs to sync Name via UpdateCustomer requires the
  // complete object to echo back unchanged (VERIFIED via a real,
  // approved, no-op production UpdateCustomer call: echoing back every
  // field caused zero side effects on any field other than the one
  // intentionally changed — see resolveInvoice4uCustomer). Every existing
  // caller only ever read `.ID` off this return value, so this is a
  // strictly additive change to what's returned, not a breaking one.
  return result;
}

/**
 * Returns the new ClientID, or throws with code 'CUSTOMER_DUPLICATE_EXT_NUMBER'
 * (never a guessed ID) if Invoice4U reports the ExtNumber already exists —
 * the caller falls back to one GetCustomers lookup in that case.
 */
async function createCustomer({ name, extNumber }) {
  const res = await fetchInvoice4u('CreateCustomer', { cu: { Name: name, ExtNumber: extNumber } });
  // VERIFIED against real production logs (2026-08-24): the same "d"
  // envelope already confirmed for the document endpoint and GetCustomers
  // — json.d directly IS the Customer result object (ID, Name, ExtNumber,
  // Errors, ... ~65 fields), no further nested "CreateCustomerResult"
  // wrapper. Third independent confirmation of the same pattern on this
  // service.
  const result = await parseInvoice4uResponse(res, {
    path: 'CreateCustomer',
    resultInD: true,
    extNumber,
    validate: (r) => 'Errors' in r || 'ID' in r,
  });

  const errors = Array.isArray(result.Errors) ? result.Errors : [];
  const duplicate = errors.find(isDuplicateExtNumberError);
  if (duplicate) {
    console.error('[invoice4uCustomer] CreateCustomer hit a duplicate ExtNumber (race) — falling back to lookup', {
      extNumber, error: pickErrorFields(duplicate),
    });
    const err = new Error('Invoice4U CreateCustomer: ExtNumber already exists');
    err.code = 'CUSTOMER_DUPLICATE_EXT_NUMBER';
    throw err;
  }

  const isRealError = errors.length > 0;
  if (isRealError) {
    console.error('[invoice4uCustomer] CreateCustomer returned a business-level error', {
      extNumber, errors: errors.map(pickErrorFields),
    });
    const err = new Error(errors.map((e) => e.Error).join('; ') || 'Invoice4U CreateCustomer returned an error');
    err.code = 'CUSTOMER_ERROR';
    err.invoice4uErrors = errors;
    throw err;
  }

  if (result.ID == null) {
    console.error('[invoice4uCustomer] CreateCustomer reported no errors but returned no ID', { extNumber });
    const err = new Error('Invoice4U CreateCustomer reported no errors but returned no ID');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  return result.ID;
}

// Comparison-only normalization — trim + collapse internal whitespace.
// Never used to mutate the authoritative Firestore name itself, only to
// decide whether an UpdateCustomer call is actually needed. Deliberately
// no fuzzy matching and no case-folding (Hebrew has no case) — a real
// difference beyond trivial whitespace must always trigger a sync.
function normalizeNameForComparison(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

/**
 * Updates an existing Invoice4U customer — contract VERIFIED against a
 * real, approved, no-op production call (2026-08-24): request is
 * { cu: <full Customer object>, token }, response is
 * { d: <full Customer object> } — the same "d"-direct pattern as every
 * other endpoint on this service (no further nested
 * "UpdateCustomerResult"/"UpdateCustomerResponse", despite that being the
 * WSDL-documented response element name). Requires the FULL Customer
 * object, not a sparse patch: echoing back an object fetched from
 * GetCustomerByExternalNumber with only one field changed was verified to
 * cause zero side effects on any other field (email/phone/address/etc. —
 * all correctly preserved, byte-for-byte, in a real before/after
 * comparison). Callers MUST pass the complete object, never a
 * hand-constructed partial one.
 *
 * Validates strictly: Errors empty, AND the returned ID/ExtNumber/Name all
 * match what was intended — never trusts a "success" that doesn't actually
 * confirm the right customer received the right change. Any failure here
 * (network, timeout, business error, malformed shape, or a mismatch on
 * any of those three fields) throws — deliberately never swallowed by
 * this function, so a stale Name can never silently reach a receipt.
 */
async function updateCustomer(customerObject) {
  const res = await fetchInvoice4u('UpdateCustomer', { cu: customerObject });
  const result = await parseInvoice4uResponse(res, {
    path: 'UpdateCustomer',
    resultInD: true,
    extNumber: customerObject.ExtNumber,
    validate: (r) => 'Errors' in r || 'ID' in r,
  });

  const errors = Array.isArray(result.Errors) ? result.Errors : [];
  const isRealError = errors.length > 0;
  if (isRealError) {
    console.error('[invoice4uCustomer] UpdateCustomer returned a business-level error', {
      extNumber: customerObject.ExtNumber, errors: errors.map(pickErrorFields),
    });
    const err = new Error(errors.map((e) => e.Error).join('; ') || 'Invoice4U UpdateCustomer returned an error');
    err.code = 'CUSTOMER_ERROR';
    err.invoice4uErrors = errors;
    throw err;
  }

  if (String(result.ID) !== String(customerObject.ID)) {
    console.error('[invoice4uCustomer] UpdateCustomer returned a mismatched ID', {
      extNumber: customerObject.ExtNumber, expectedIdType: typeof customerObject.ID, returnedIdType: typeof result.ID,
    });
    const err = new Error('Invoice4U UpdateCustomer returned a mismatched ID');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  if (String(result.ExtNumber) !== String(customerObject.ExtNumber)) {
    console.error('[invoice4uCustomer] UpdateCustomer returned a mismatched ExtNumber', {
      expectedExtNumberType: typeof customerObject.ExtNumber, returnedExtNumberType: typeof result.ExtNumber,
    });
    const err = new Error('Invoice4U UpdateCustomer returned a mismatched ExtNumber');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  if (result.Name !== customerObject.Name) {
    console.error('[invoice4uCustomer] UpdateCustomer did not confirm the intended Name change', {
      extNumber: customerObject.ExtNumber,
    });
    const err = new Error('Invoice4U UpdateCustomer did not confirm the intended Name change');
    err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
    throw err;
  }

  return result;
}

/**
 * Keeps an existing Invoice4U customer's Name in sync with the
 * authoritative Firestore appointment name, BEFORE any receipt is created
 * against it. Fail-closed by construction: this function never catches
 * updateCustomer()'s errors — they propagate straight out of
 * resolveInvoice4uCustomer exactly like every other CUSTOMER_* failure
 * already does, so issueReceipt.js's existing catch block (never modified
 * for this feature) already guarantees createReceipt is never reached and
 * the receipt is marked failed, retry-safe — no new failure-handling
 * mechanism needed.
 *
 * No-ops (never calls UpdateCustomer) when the names already match after
 * comparison-only normalization — never sends an unnecessary write.
 */
async function syncCustomerNameIfNeeded(existing, authoritativeName) {
  if (normalizeNameForComparison(existing.Name) === normalizeNameForComparison(authoritativeName)) {
    return;
  }
  const updated = { ...existing, Name: authoritativeName };
  await updateCustomer(updated);
}

/**
 * @param {{ name: string, phone: string, _mockCustomerScenario?: string }} req
 * @returns {Promise<{ clientId: number|string }>}
 */
async function resolveInvoice4uCustomer(req) {
  const normalized = normalizePhoneForStorage(req.phone);
  if (!isValidNormalizedPhone(normalized)) {
    const err = new Error('customer phone is missing or invalid — cannot resolve Invoice4U customer');
    err.code = 'INVALID_PHONE';
    throw err;
  }
  const extNumber = Number(normalized);

  if (process.env.INVOICE4U_MOCK_MODE === 'true') {
    const mockResult = await mockResolveInvoice4uCustomer({
      extNumber, name: req.name, _mockCustomerScenario: req._mockCustomerScenario,
    });
    return { clientId: mockResult.clientId };
  }

  // 1. Look up first via the dedicated, production-verified endpoint —
  // never create blindly, and never the generic GetCustomers search
  // (proven unreliable for ExtNumber resolution — see the removal note
  // above getCustomerByExternalNumber's definition).
  let existing = await getCustomerByExternalNumber(extNumber);
  if (existing) {
    // Keep Invoice4U's Name in sync with the authoritative Firestore name
    // before this ClientID is ever handed to createReceipt — fail-closed:
    // any sync failure throws here and never reaches createReceipt (see
    // syncCustomerNameIfNeeded's own header comment).
    await syncCustomerNameIfNeeded(existing, req.name);
    return { clientId: existing.ID };
  }

  // 2. Not found — create. (No follow-up UpdateCustomer needed here: a
  // brand-new customer is created with the current, already-authoritative
  // name in the same call.)
  try {
    const clientId = await createCustomer({ name: req.name, extNumber });
    return { clientId };
  } catch (e) {
    if (e.code !== 'CUSTOMER_DUPLICATE_EXT_NUMBER') throw e;
    // 3. Race: another concurrent request created it between step 1 and 2.
    // Fall back to exactly one more lookup via the same dedicated endpoint
    // — never guess an ID.
    existing = await getCustomerByExternalNumber(extNumber);
    if (existing) {
      await syncCustomerNameIfNeeded(existing, req.name);
      return { clientId: existing.ID };
    }
    console.error('[invoice4uCustomer] Duplicate-ExtNumber fallback lookup could not resolve the existing customer', { extNumber });
    const err = new Error('Invoice4U reported a duplicate ExtNumber but the fallback lookup could not resolve it');
    err.code = 'CUSTOMER_AMBIGUOUS';
    throw err;
  }
}

module.exports = { resolveInvoice4uCustomer };
