// Thin wrapper around Invoice4U's CreateDocumentWithIdentifierValidation.
// Knows nothing about Firestore or admin auth — receiptState.js and
// issueReceipt.js own those concerns. This module's only job is: given a
// fully-formed request, talk to Invoice4U and normalize the response.
//
// The API token is never a literal in this repo. It is declared as a Cloud
// Functions v2 secret (Secret Manager-backed):
//   firebase functions:secrets:set INVOICE4U_API_TOKEN_PRODUCTION
//
// Architecture note (found during the first real B4A deploy attempts):
// Cloud Functions v2's deploy-time DISCOVERY step evaluates this module —
// including every defineSecret() call — BEFORE any `.env.<project>` file
// is loaded into process.env, and the discovery child process does not
// inherit the invoking shell's environment either. Concretely: which
// secret NAME gets bound to a function can only ever be a static,
// hardcoded decision in code — it cannot be conditioned on
// INVOICE4U_ENVIRONMENT or any other deploy-time/shell value, confirmed
// empirically (a conditional defineSecret() call based on
// process.env.INVOICE4U_ENVIRONMENT always saw `undefined` at discovery
// time, regardless of .env.mirit-nails or an exported shell variable).
//
// This function (issueReceipt, this deployment) is, by design, the
// PRODUCTION-only deployment — QA is fully covered by the Emulator Suite +
// invoice4uMock.js (approved: QA is preferred-not-mandatory, no live QA
// cloud function needed). So hardcoding the production secret name here is
// not a compromise — it's the correct shape for what's actually being
// deployed. getInvoice4uEnvironment() (issueReceipt.js) still correctly
// picks the HOST at genuine runtime (that value IS available once the
// function is actually serving live requests, unlike at discovery time) —
// so the host/token pairing for THIS deployment is: always the production
// host, always the production secret, both server-side, never
// client-influenceable. A live QA cloud function, if ever wanted later,
// would need to be a genuinely separate function with its own hardcoded
// INVOICE4U_API_TOKEN_QA — not a runtime branch inside this one. Until the
// secret is set, createReceipt() throws a clear, explicit error instead of
// attempting (and silently mishandling) a real network call.
'use strict';

const { defineSecret } = require('firebase-functions/params');
const { mockCreateReceipt } = require('./invoice4uMock');

const invoice4uApiToken = defineSecret('INVOICE4U_API_TOKEN_PRODUCTION');

const HOSTS = {
  qa: 'https://apiqa.invoice4u.co.il/Services/ApiService.svc',
  production: 'https://api.invoice4u.co.il/Services/ApiService.svc',
};

const REQUEST_TIMEOUT_MS = 20_000;

// Fixed allowlist (not a blocklist) — deliberately so: only these exact
// field names are ever pulled out of Invoice4U's response body. This can
// never accidentally surface anything from the outgoing REQUEST (token,
// headers, customer PII), because it never looks at the request at all —
// only at fields Invoice4U's own response happens to contain.
const DIAGNOSTIC_FIELD_ALLOWLIST = [
  'Message', 'Error', 'Errors', 'ErrorCode', 'ErrorMessage',
  'Code', 'Description', 'ExceptionMessage', 'ExceptionType',
];

function pickDiagnosticFields(obj) {
  if (!obj || typeof obj !== 'object') return undefined;
  const picked = {};
  for (const key of DIAGNOSTIC_FIELD_ALLOWLIST) {
    if (obj[key] !== undefined) picked[key] = obj[key];
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * Best-effort, safe extraction of diagnostic info from a non-OK Invoice4U
 * response. Never throws (diagnostics are a bonus, not a requirement), and
 * never includes anything from the outgoing request. Bounded in size either
 * way, so a large/unexpected body (e.g. an HTML error page from a proxy)
 * can never inflate logs or Firestore writes unexpectedly.
 */
async function extractProviderDiagnostics(res) {
  let rawText;
  try {
    rawText = await res.text();
  } catch (e) {
    return { readError: 'failed to read response body' };
  }

  const bodyExcerpt = rawText.slice(0, 1000);

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return { bodyFormat: 'text', bodyExcerpt };
  }

  const nested = parsed && typeof parsed === 'object' ? parsed.CreateDocumentResult : undefined;
  const fields = pickDiagnosticFields(parsed) ?? pickDiagnosticFields(nested);

  return fields
    ? { bodyFormat: 'json', fields }
    : { bodyFormat: 'json', bodyExcerpt };
}

function summarizeDiagnostics(diagnostics) {
  if (!diagnostics) return '';
  if (diagnostics.fields) {
    try {
      return JSON.stringify(diagnostics.fields).slice(0, 400);
    } catch (e) {
      return '';
    }
  }
  if (diagnostics.bodyExcerpt) return diagnostics.bodyExcerpt.slice(0, 400);
  if (diagnostics.readError) return diagnostics.readError;
  return '';
}

// Root cause of the first two real B4B failures (both HTTP 500), confirmed
// via the diagnostic capture above: Invoice4U's backend is a .NET/WCF
// service and rejects ISO 8601 DateTime values outright — the actual
// server error was "DateTime content '...' does not start with '/Date('
// and end with ')/' as required for JSON." It requires the legacy ASP.NET
// AJAX JSON date format instead: /Date(<milliseconds-since-epoch>)/.
// This is the ONLY DateTime-typed field in the request we send (see body
// below) — everything else (strings/numbers) is unaffected by this bug.
function toWcfJsonDate(date) {
  return `/Date(${date.getTime()})/`;
}

/**
 * @param {{
 *   environment: 'qa'|'production',
 *   documentType: number,
 *   apiIdentifier: string,
 *   clientId: number|string,  // verified Invoice4U ClientID — see invoice4uCustomer.js.
 *                              // Never GeneralCustomer: DocumentType=2 (Receipt) rejects
 *                              // it outright (Error 38, TypeOfDocumentDoesntAllowGeneralCustomer).
 *   itemDescription: string,
 *   amount: number,
 *   paymentType: number,
 *   _mockScenario?: string,  // TEST-ONLY — see invoice4uMock.js header
 * }} req
 */
async function createReceipt(req) {
  // TEST-ONLY branch. Gated on a server env var that only ever exists in
  // the Functions Emulator (see B3 test harness) — never set in any real
  // deployment, so this can never activate in production regardless of
  // anything a client sends.
  if (process.env.INVOICE4U_MOCK_MODE === 'true') {
    return mockCreateReceipt(req);
  }

  // This deployment only ever holds the production secret (see header
  // comment) — the host must match, or refuse outright rather than risk
  // pairing the production token with the wrong host. This is a hard
  // assertion, not a fallback: req.environment coming through as anything
  // else would mean getInvoice4uEnvironment() (issueReceipt.js) somehow
  // read a value this deployment was never configured for.
  if (req.environment !== 'production') {
    throw new Error(`refusing: this deployment only holds the production secret, but resolved environment was "${req.environment}"`);
  }
  const host = HOSTS.production;

  const token = invoice4uApiToken.value();
  if (!token) {
    // Expected and normal until the relevant secret (see header comment)
    // has been set for this environment. Surfaced as a distinct error code
    // so callers can show a clear "not configured yet" message rather than
    // a confusing network failure.
    const err = new Error(`Invoice4U ${req.environment} API token secret is not configured`);
    err.code = 'NOT_CONFIGURED';
    throw err;
  }

  // ClientID, not GeneralCustomer: confirmed via a real production Errors[]
  // entry (ID 38, TypeOfDocumentDoesntAllowGeneralCustomer) that Receipt
  // (DocumentType=2) rejects one-off customers outright — see
  // invoice4uCustomer.js for how clientId is resolved/verified beforehand.
  const body = {
    token,
    doc: {
      DocumentType: req.documentType,
      ApiIdentifier: req.apiIdentifier,
      ClientID: req.clientId,
      Items: [{ Name: req.itemDescription, Quantity: 1, Price: req.amount }],
      Payments: [{ PaymentType: req.paymentType, Amount: req.amount, Date: toWcfJsonDate(new Date()) }],
      Currency: 'ILS',
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${host}/CreateDocumentWithIdentifierValidation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      // We genuinely don't know whether Invoice4U processed the request —
      // it may have created a document we never heard back about. This is
      // NOT the same as a confirmed failure; see receiptState.js / the
      // ambiguous-result handling in issueReceipt.js. Retrying is safe
      // regardless, because the ApiIdentifier stays the same either way.
      const err = new Error('Invoice4U request timed out — result is unknown, not a confirmed failure');
      err.code = 'TIMEOUT';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Diagnostic-only addition (2026-08-24, after the first real B4B
    // failure returned HTTP 500 with no captured body): read and safely
    // summarize Invoice4U's own response so a repeat failure is
    // debuggable. See extractProviderDiagnostics() — allowlist-based, never
    // touches the outgoing request, always bounded in size.
    const diagnostics = await extractProviderDiagnostics(res);
    const summary = summarizeDiagnostics(diagnostics);
    const err = new Error(`Invoice4U HTTP ${res.status}${summary ? `: ${summary}` : ''}`);
    err.code = 'HTTP_ERROR';
    err.providerDiagnostics = diagnostics;
    console.error('[invoice4uClient] Invoice4U returned a non-OK HTTP status', {
      httpStatus: res.status,
      apiIdentifier: req.apiIdentifier,
      diagnostics,
    });
    throw err;
  }

  const json = await res.json();

  // Root cause of the fourth real B4B failure (2026-08-24): this endpoint
  // (CreateDocumentWithIdentifierValidation) wraps its response in
  // "CreateDocumentWithIdentifierValidationResult" — an endpoint-specific
  // name, confirmed against Invoice4U's official docs — NOT the generic
  // "CreateDocumentResult" (that name belongs to the plain /CreateDocument
  // endpoint). The old code's blind `json?.CreateDocumentResult ?? json`
  // fallback silently read fields off the wrong (top-level) object on
  // every real call to this endpoint — Errors was always [] regardless of
  // what Invoice4U actually sent, and ID/DocumentNumber were always
  // undefined, which crashed recordReceiptSuccess() downstream.
  //
  // Root cause of the fifth AND sixth real B4B failures (2026-08-24),
  // found via the diagnostics above once they finally had a real response
  // to look at: Invoice4U wraps its response in a top-level "d" envelope —
  // the classic ASP.NET AJAX/WCF anti-hijacking JSON convention (confirmed
  // empirically: the real response's only top-level key was "d"). The
  // fifth-failure fix correctly unwrapped "d" but then assumed a FURTHER
  // nested "CreateDocumentWithIdentifierValidationResult" wrapper inside
  // it — the sixth failure's diagnostic proved that assumption wrong: the
  // logged `receivedKeysInD` was the ENTIRE Document object's field set
  // (ID, DocumentNumber, Errors, GeneralCustomer, Items, Payments,
  // PrintOriginalPDFLink, IsSuccess, ~100+ more), meaning "d" directly IS
  // the result — the ASP.NET AJAX "d" envelope REPLACES the WCF-style
  // "{MethodName}Result" naming, it doesn't additionally contain it. Only
  // one level of unwrapping is real; no blind fallback either way —
  // anything else is treated as an integration/protocol error, never a
  // silent "success".
  const result = json?.d;

  if (!result || typeof result !== 'object') {
    console.error('[invoice4uClient] Invoice4U response missing expected "d" envelope', {
      apiIdentifier: req.apiIdentifier,
      receivedTopLevelKeys: json && typeof json === 'object' ? Object.keys(json) : typeof json,
    });
    const err = new Error('Invoice4U response missing expected "d" envelope');
    err.code = 'INVALID_RESPONSE_SHAPE';
    throw err;
  }

  const errors = Array.isArray(result.Errors) ? result.Errors : [];

  // Error 134 = DocumentAlreadyCreated. Per Invoice4U's own docs this is the
  // idempotent-duplicate signal, not a real failure — treat exactly like
  // success and return the existing document's identifiers. Now correctly
  // operates on Errors[] from the right nesting level (see above).
  const isRealError = errors.some((e) => e.ID !== 134);
  if (isRealError) {
    const err = new Error(errors.map((e) => e.Error).join('; ') || 'Invoice4U returned an error');
    err.code = 'INVOICE4U_ERROR';
    err.invoice4uErrors = errors;
    // Diagnostic-only addition (2026-08-24): after the date-format fix
    // resolved the earlier HTTP 500 (WCF deserialization crash), Invoice4U
    // now returns HTTP 200 with a business-level Errors[] instead — a
    // branch that was never logged. Same allowlist-based safety pattern as
    // the HTTP_ERROR diagnostics above: only these four fields are ever
    // read out of Invoice4U's own error objects, nothing from the outgoing
    // request (token/headers/full payload) is touched. No change to
    // error/return handling below — this is purely an added log line.
    console.error('[invoice4uClient] Invoice4U returned a business-level error', {
      apiIdentifier: req.apiIdentifier,
      errors: errors.map((e) => ({
        ID: e.ID,
        Error: e.Error,
        Message: e.Message,
        Description: e.Description,
      })),
    });
    throw err;
  }

  // Guard against ever returning an incomplete "success" — a response
  // shaped correctly (right wrapper, no real Errors) but somehow missing
  // ID/DocumentNumber must never reach recordReceiptSuccess() with
  // undefined fields (that guarantee is what this whole fix is for).
  // Applies equally to the error-134 idempotent-duplicate case, which per
  // Invoice4U's docs still includes ID/DocumentNumber for the existing
  // document.
  if (result.ID == null || result.DocumentNumber == null) {
    console.error('[invoice4uClient] Invoice4U success response missing ID/DocumentNumber', {
      apiIdentifier: req.apiIdentifier,
      hasId: result.ID != null,
      hasDocumentNumber: result.DocumentNumber != null,
    });
    const err = new Error('Invoice4U response reported no errors but is missing ID/DocumentNumber');
    err.code = 'INVALID_RESPONSE_SHAPE';
    throw err;
  }

  return {
    documentId: result.ID,
    documentNumber: result.DocumentNumber,
    documentType: result.DocumentType,
    pdfUrl: result.PrintOriginalPDFLink ?? null,
    wasIdempotentDuplicate: errors.length > 0,
  };
}

module.exports = { createReceipt, invoice4uApiToken, HOSTS };
