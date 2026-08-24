// TEST-ONLY. Simulates Invoice4U's CreateDocumentWithIdentifierValidation
// for B3 verification — no real Invoice4U account, credentials, or network
// call involved anywhere in this file.
//
// Only ever reached when both are true:
//   1. process.env.INVOICE4U_MOCK_MODE === 'true' — set exclusively in the
//      Functions Emulator (see test/ harness). Never set in any real
//      deployment, so this file has zero effect outside local testing.
//   2. the request carries a `_mockScenario` field — a test-only input that
//      invoice4uClient.js strips/ignores whenever mock mode is off, so a
//      client could never influence this in production even if it tried.
'use strict';

// Deterministic per-appointment "documents" so a retry with the same
// ApiIdentifier reproduces Invoice4U's own idempotent-duplicate behavior
// (error 134) instead of minting a new document each time.
const issuedByApiIdentifier = new Map();

async function mockCreateReceipt(req) {
  const scenario = req._mockScenario || 'success';

  const already = issuedByApiIdentifier.get(req.apiIdentifier);
  if (already) {
    // Mirrors real Invoice4U: same ApiIdentifier twice → idempotent
    // duplicate, not a new document, regardless of what scenario is asked
    // for on the retry.
    return { ...already, wasIdempotentDuplicate: true };
  }

  switch (scenario) {
    case 'success': {
      const result = {
        documentId: `mock-doc-${req.apiIdentifier}`,
        documentNumber: 1000 + issuedByApiIdentifier.size,
        documentType: req.documentType,
        pdfUrl: `https://mock.invoice4u.example/${req.apiIdentifier}.pdf`,
        wasIdempotentDuplicate: false,
      };
      issuedByApiIdentifier.set(req.apiIdentifier, result);
      return result;
    }

    case 'error': {
      const err = new Error('mock: Invoice4U rejected the request (simulated validation error)');
      err.code = 'INVOICE4U_ERROR';
      err.invoice4uErrors = [{ ID: 56, Error: 'PaymentAmountDoesntMatchItemsAmount' }];
      throw err;
    }

    case 'timeout': {
      const err = new Error('mock: simulated timeout — Invoice4U result is unknown, not a confirmed failure');
      err.code = 'TIMEOUT';
      throw err;
    }

    case 'timeout_after_success': {
      // The deepest ambiguous-result case: Invoice4U actually processed the
      // request (a document now exists under this ApiIdentifier) but we
      // never received the response — e.g. the connection dropped after
      // Invoice4U committed but before the HTTP response reached us. A
      // naive retry-with-new-document would duplicate; this proves the
      // idempotency layer catches it via ApiIdentifier even in this case.
      const result = {
        documentId: `mock-doc-${req.apiIdentifier}`,
        documentNumber: 1000 + issuedByApiIdentifier.size,
        documentType: req.documentType,
        pdfUrl: `https://mock.invoice4u.example/${req.apiIdentifier}.pdf`,
        wasIdempotentDuplicate: false,
      };
      issuedByApiIdentifier.set(req.apiIdentifier, result);
      const err = new Error('mock: simulated timeout AFTER Invoice4U actually committed the document');
      err.code = 'TIMEOUT';
      throw err;
    }

    case 'http_error': {
      const err = new Error('mock: Invoice4U HTTP 500');
      err.code = 'HTTP_ERROR';
      throw err;
    }

    default:
      throw new Error(`unknown mock scenario: ${scenario}`);
  }
}

/** Test-harness helper — never used by production code paths. */
function _resetMock() {
  issuedByApiIdentifier.clear();
}

module.exports = { mockCreateReceipt, _resetMock };
