// Hospital resource CRUD plus the deterministic resource matcher that compares
// the AI report's resources_needed[] against what a hospital actually has.
//
// The matcher is intentionally pure code, not an AI call: the hospital's
// accept/redirect decision must be explainable, instant, and repeatable —
// a receptionist has to be able to see exactly why a resource was flagged.
import { supabaseAdmin } from '../config/supabase.js';
import mapsService from './maps.service.js';
import logger from '../middleware/logger.js';

const VALID_STATUSES = ['available', 'unavailable', 'limited'];
const KEYWORD_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Module-level cache: the keyword map is small and changes almost never, but
// the matcher runs on every case view and for every candidate hospital.
let keywordCache = null;
let keywordCacheAt = 0;

function formatDistance(meters) {
  return `${(meters / 1000).toFixed(1)} km`;
}

// Loads (and caches) the AI-phrase → canonical_key map, longest keyword first
// so that specific phrases win over short ones during substring matching.
async function loadKeywordMap() {
  const fresh = keywordCache && Date.now() - keywordCacheAt < KEYWORD_CACHE_TTL_MS;
  if (fresh) return keywordCache;

  const { data, error } = await supabaseAdmin
    .from('resource_keywords')
    .select('keyword, canonical_key');
  if (error) {
    // Serve a stale cache rather than failing the whole case view.
    if (keywordCache) {
      logger.warn(`resource_keywords refresh failed, using stale cache: ${error.message}`);
      return keywordCache;
    }
    throw new Error(`Loading resource keywords failed: ${error.message}`);
  }

  keywordCache = (data || [])
    .map((r) => ({ keyword: String(r.keyword).toLowerCase().trim(), canonicalKey: r.canonical_key }))
    .sort((a, b) => b.keyword.length - a.keyword.length);
  keywordCacheAt = Date.now();
  return keywordCache;
}

// Exposed for tests and for the admin flow that edits the keyword table.
export function invalidateKeywordCache() {
  keywordCache = null;
  keywordCacheAt = 0;
}

// Resolves one AI phrase to a canonical resource key, or null when unknown.
// Exported (with buildChecks) so the matcher can be unit-tested without a DB.
export function resolveCanonicalKey(phrase, keywordMap) {
  const normalized = String(phrase || '').toLowerCase().trim();
  if (!normalized) return null;

  const exact = keywordMap.find((k) => k.keyword === normalized);
  if (exact) return exact.canonicalKey;

  // Fall back to a whole-word containment match, longest keyword first so
  // 'orthopedic surgeon' wins over 'surgeon'. Word boundaries are essential:
  // a plain substring test lets short keys like 'er' match inside unrelated
  // words ('hyperbaric' → Emergency Ward), which would tell the receptionist
  // a resource is available when the phrase was never actually understood.
  // An unrecognised phrase is reported as 'unknown — verify manually', which
  // is the safe outcome; a confident wrong match is not.
  const partial = keywordMap.find((k) => wholeWordRegex(k.keyword).test(normalized));
  return partial ? partial.canonicalKey : null;
}

// Cached per keyword — the matcher runs this for every phrase × hospital.
const wholeWordRegexCache = new Map();
function wholeWordRegex(keyword) {
  let rx = wholeWordRegexCache.get(keyword);
  if (!rx) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rx = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    wholeWordRegexCache.set(keyword, rx);
  }
  return rx;
}

// Builds the check list for one hospital's resources. Split out so the
// alternatives query can match many hospitals from a single DB read.
export function buildChecks(resourcesNeeded, hospitalResources, keywordMap) {
  const byKey = new Map(hospitalResources.map((r) => [r.canonical_key, r]));

  const checks = resourcesNeeded.map((needed) => {
    const canonical = resolveCanonicalKey(needed, keywordMap);

    if (!canonical) {
      return {
        needed,
        canonicalKey: null,
        status: 'unknown',
        note: 'Not in hospital resource list — verify manually',
      };
    }

    const resource = byKey.get(canonical);
    if (!resource) {
      return {
        needed,
        canonicalKey: canonical,
        resource: canonical,
        status: 'missing',
        note: 'Hospital does not have this resource',
      };
    }

    if (resource.status === 'limited') {
      return {
        needed,
        canonicalKey: canonical,
        resource: resource.resource_name,
        status: 'limited',
        quantity: resource.quantity,
        note: 'Limited availability — confirm',
      };
    }

    if (resource.status === 'unavailable') {
      return {
        needed,
        canonicalKey: canonical,
        resource: resource.resource_name,
        status: 'missing',
        quantity: resource.quantity,
        note: 'Currently unavailable/down',
      };
    }

    return {
      needed,
      canonicalKey: canonical,
      resource: resource.resource_name,
      status: 'ok',
      quantity: resource.quantity,
    };
  });

  const missingCount = checks.filter((c) => c.status === 'missing').length;
  const overallOk = missingCount === 0;

  return {
    checks,
    overallOk,
    missingCount,
    summary: overallOk
      ? 'All required resources available'
      : `${missingCount} required resource(s) unavailable — consider redirect`,
  };
}

// --- Public API -------------------------------------------------------------

// 1. All resources for a hospital, grouped by type for the Resources screen.
export async function getHospitalResources(hospitalId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');

  const { data, error } = await supabaseAdmin
    .from('hospital_resources')
    .select('*')
    .eq('hospital_id', hospitalId)
    .order('resource_type', { ascending: true })
    .order('resource_name', { ascending: true });
  if (error) throw new Error(error.message);

  const grouped = { equipment: [], specialist: [], service: [] };
  (data || []).forEach((row) => {
    if (grouped[row.resource_type]) grouped[row.resource_type].push(row);
  });
  return grouped;
}

// 2. Receptionist toggles a resource's status/quantity.
export async function updateResource(hospitalId, canonicalKey, { status, quantity } = {}, userId) {
  if (!hospitalId) throw new Error('No hospital associated with this account');
  if (!canonicalKey) throw new Error('canonicalKey is required');
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    throw new Error(`status must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  if (status === undefined && quantity === undefined) {
    throw new Error('Nothing to update — provide status and/or quantity');
  }

  const update = { updated_by: userId || null, updated_at: new Date().toISOString() };
  if (status !== undefined) update.status = status;
  if (quantity !== undefined) update.quantity = quantity === null ? null : Number(quantity);

  const { data, error } = await supabaseAdmin
    .from('hospital_resources')
    .update(update)
    .eq('hospital_id', hospitalId)
    .eq('canonical_key', canonicalKey)
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Resource not found for this hospital');

  return data;
}

// 3. THE CORE MATCHER — deterministic, no AI.
export async function matchResources(hospitalId, resourcesNeeded) {
  const needed = (Array.isArray(resourcesNeeded) ? resourcesNeeded : []).filter(
    (r) => r != null && String(r).trim() !== '',
  );
  if (needed.length === 0) {
    return {
      checks: [],
      overallOk: true,
      missingCount: 0,
      summary: 'No specific resources identified',
    };
  }

  const keywordMap = await loadKeywordMap();

  const { data: resources, error } = await supabaseAdmin
    .from('hospital_resources')
    .select('canonical_key, resource_name, status, quantity')
    .eq('hospital_id', hospitalId);
  if (error) throw new Error(error.message);

  return buildChecks(needed, resources || [], keywordMap);
}

export default {
  getHospitalResources,
  updateResource,
  matchResources,
  invalidateKeywordCache,
  resolveCanonicalKey,
  buildChecks,
};
