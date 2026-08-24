// TEST-ONLY. Simulates Invoice4U's GetCustomers/CreateCustomer for
// emulator-based verification — no real Invoice4U account, credentials, or
// network call anywhere in this file. Mirrors invoice4uMock.js's pattern
// exactly: only ever reached when both are true:
//   1. process.env.INVOICE4U_MOCK_MODE === 'true' — Functions Emulator only.
//   2. the request carries a `_mockCustomerScenario` field — test-only,
//      stripped/ignored whenever mock mode is off.
'use strict';

// Deterministic per-ExtNumber "customers" so a repeat resolve for the same
// phone reproduces the same ClientID, mirroring how the real Invoice4U
// dedup (ExtNumber, per-organization-unique) is supposed to behave.
const customersByExtNumber = new Map();

async function mockResolveInvoice4uCustomer({ extNumber, name, _mockCustomerScenario }) {
  const scenario = _mockCustomerScenario || 'new';

  switch (scenario) {
    case 'existing': {
      // Simulate GetCustomers finding exactly one pre-existing match,
      // regardless of the module-level map (lets a test assert the
      // "found → reuse, never CreateCustomer" path deterministically).
      return { clientId: `mock-existing-client-${extNumber}`, wasCreated: false };
    }

    case 'new': {
      const already = customersByExtNumber.get(extNumber);
      if (already) return { clientId: already, wasCreated: false };
      const clientId = `mock-new-client-${extNumber}`;
      customersByExtNumber.set(extNumber, clientId);
      return { clientId, wasCreated: true };
    }

    case 'race_duplicate': {
      // GetCustomers empty → CreateCustomer hits a duplicate-ExtNumber
      // error (another request won the race) → fallback GetCustomers finds it.
      return { clientId: `mock-race-resolved-client-${extNumber}`, wasCreated: false };
    }

    case 'timeout': {
      const err = new Error('mock: simulated Invoice4U customer-resolution timeout');
      err.code = 'CUSTOMER_TIMEOUT';
      throw err;
    }

    case 'http_error': {
      const err = new Error('mock: Invoice4U customer API HTTP 500');
      err.code = 'CUSTOMER_HTTP_ERROR';
      throw err;
    }

    case 'business_error': {
      const err = new Error('mock: Invoice4U rejected the customer (simulated validation error)');
      err.code = 'CUSTOMER_ERROR';
      err.invoice4uErrors = [{ ID: 28, Error: 'CustomerNameCanNotBeEmpty' }];
      throw err;
    }

    case 'invalid_response_shape': {
      const err = new Error('mock: Invoice4U customer response missing expected wrapper');
      err.code = 'CUSTOMER_INVALID_RESPONSE_SHAPE';
      throw err;
    }

    case 'ambiguous': {
      const err = new Error('mock: GetCustomers returned more than one match for this ExtNumber');
      err.code = 'CUSTOMER_AMBIGUOUS';
      throw err;
    }

    default:
      throw new Error(`unknown mock customer scenario: ${scenario}`);
  }
}

/** Test-harness helper — never used by production code paths. */
function _resetCustomerMock() {
  customersByExtNumber.clear();
}

module.exports = { mockResolveInvoice4uCustomer, _resetCustomerMock };
