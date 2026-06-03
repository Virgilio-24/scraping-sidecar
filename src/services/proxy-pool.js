import { config } from "../config.js";

// After this many consecutive failures a proxy is considered dead and skipped.
// It gets a retry window every DEAD_RETRY_MS to check if it recovered.
const DEAD_THRESHOLD = 5;
const DEAD_RETRY_MS = 30 * 60 * 1000; // 30 minutes

const sanitizeProxyUrl = (proxyUrl) => {
  if (!proxyUrl) return null;
  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-proxy-url";
  }
};

const buildCandidates = () => {
  const directCandidate = { id: "direct", label: "direct", proxyUrl: null };
  const proxyCandidates = config.proxyUrls.map((proxyUrl, index) => ({
    id: `proxy-${index + 1}`,
    label: `proxy-${index + 1}`,
    proxyUrl,
    proxyDisplay: sanitizeProxyUrl(proxyUrl),
  }));
  return [directCandidate, ...proxyCandidates];
};

const candidates = buildCandidates();

const metrics = new Map(
  candidates.map((candidate) => [
    candidate.id,
    {
      id: candidate.id,
      label: candidate.label,
      proxyUrl: candidate.proxyDisplay || null,
      requests: 0,
      successes: 0,
      failures: 0,
      consecutiveFailures: 0,
      dead: false,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastDeadAt: null,
      lastError: null,
      lastOutcome: null,
    },
  ])
);

let cursor = 0;

const cloneMetrics = (entry) => ({ ...entry });
const nowIso = () => new Date().toISOString();

const isAlive = (candidateId) => {
  const m = metrics.get(candidateId);
  if (!m) return false;
  if (!m.dead) return true;
  // Give dead proxies a retry window periodically
  if (m.lastDeadAt) {
    const deadSinceMs = Date.now() - new Date(m.lastDeadAt).getTime();
    if (deadSinceMs >= DEAD_RETRY_MS) return true;
  }
  return false;
};

const rotateCandidates = () => {
  const startIndex = cursor % candidates.length;
  cursor = (cursor + 1) % candidates.length;
  return [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
};

const updateMetric = (candidateId, updater) => {
  const current = metrics.get(candidateId);
  if (current) updater(current);
};

export const getAttemptPlan = (rounds = 1) => {
  const safeRounds = Math.max(Number(rounds) || 1, 1);
  const orderedCandidates = rotateCandidates();

  // Only include alive candidates. Always keep at least direct as fallback.
  const activeCandidates = orderedCandidates.filter((c) => isAlive(c.id));
  const pool = activeCandidates.length > 0 ? activeCandidates : orderedCandidates.slice(0, 1);

  const attempts = [];
  for (let round = 1; round <= safeRounds; round += 1) {
    for (const candidate of pool) {
      attempts.push({ ...candidate, round });
    }
  }
  return attempts;
};

export const recordCandidateSuccess = (candidate, metadata = {}) => {
  updateMetric(candidate.id, (entry) => {
    entry.requests += 1;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
    entry.dead = false;
    entry.lastDeadAt = null;
    entry.lastSuccessAt = nowIso();
    entry.lastError = null;
    entry.lastOutcome = metadata.outcome || "success";
  });
};

export const recordCandidateFailure = (candidate, metadata = {}) => {
  updateMetric(candidate.id, (entry) => {
    entry.requests += 1;
    entry.failures += 1;
    entry.consecutiveFailures += 1;
    entry.lastFailureAt = nowIso();
    entry.lastError = metadata.error || null;
    entry.lastOutcome = metadata.outcome || "failure";

    if (!entry.dead && entry.consecutiveFailures >= DEAD_THRESHOLD) {
      entry.dead = true;
      entry.lastDeadAt = nowIso();
      console.warn(`[proxy-pool] ${entry.label} marked as dead after ${entry.consecutiveFailures} consecutive failures.`);
    }
  });
};

export const getProxyMetrics = () =>
  candidates.map((candidate) => cloneMetrics(metrics.get(candidate.id)));

export const buildRequestAttemptPlan = (proxyUrls = [], rounds = 1) => {
  const safeRounds = Math.max(Number(rounds) || 1, 1);
  const direct = { id: "direct", label: "direct", proxyUrl: null };
  const proxies = proxyUrls.map((url, i) => ({
    id: `req-proxy-${i + 1}`,
    label: `req-proxy-${i + 1}`,
    proxyUrl: url,
    proxyDisplay: sanitizeProxyUrl(url),
  }));
  const pool = [direct, ...proxies];
  const attempts = [];
  for (let round = 1; round <= safeRounds; round++) {
    for (const candidate of pool) {
      attempts.push({ ...candidate, round });
    }
  }
  return attempts;
};

export const getProxySummary = () => {
  const all = getProxyMetrics();
  return {
    candidateCount: candidates.length,
    configuredProxyCount: Math.max(candidates.length - 1, 0),
    activeCount: all.filter((m) => !m.dead).length,
    deadCount: all.filter((m) => m.dead).length,
    metrics: all,
  };
};
