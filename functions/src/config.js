// Reads the Invoice4U integration configuration (document type, payment-type
// mapping, environment) from a single Firestore document — never from a
// literal in code. See investigation doc §14: this is what lets the document
// type or payment-method mapping change in the future without touching the
// app's flow or redeploying the frontend.
//
// Deliberately NOT here: the Invoice4U API token itself. That lives only in
// Secret Manager (see invoice4uClient.js) — this document holds no secrets,
// so an over-broad Firestore rule mistake here can never leak a credential.
'use strict';

const { getFirestore } = require('firebase-admin/firestore');

const CONFIG_PATH = ['config', 'invoice4uIntegration'];

// Known-safe fallback used only if the config document is missing entirely
// (e.g. first deploy, before anyone has written it). Mirrors the values
// approved 2026-08-24: Mirit is an עוסק פטור → Receipt (DocumentType=2);
// Cash/Bit/PayBox are the only three payment methods in use.
const DEFAULT_CONFIG = Object.freeze({
  documentType: 2,
  paymentTypeMap: Object.freeze({ cash: 4, bit: 8, paybox: 9 }),
  environment: 'qa',
});

let cached = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60_000;

/**
 * @returns {Promise<{documentType:number, paymentTypeMap:Record<string,number>, environment:'qa'|'production'}>}
 */
async function getInvoice4uConfig() {
  const now = Date.now();
  if (cached && now - cachedAt < CACHE_TTL_MS) return cached;

  const snap = await getFirestore().doc(CONFIG_PATH.join('/')).get();
  const value = snap.exists ? { ...DEFAULT_CONFIG, ...snap.data() } : DEFAULT_CONFIG;

  cached = value;
  cachedAt = now;
  return value;
}

/** Test/emulator helper — never used by production code paths. */
function _resetConfigCache() {
  cached = null;
  cachedAt = 0;
}

module.exports = { getInvoice4uConfig, DEFAULT_CONFIG, _resetConfigCache };
