import { config } from "../config.js";

const sanitizeProxyUrl = (proxyUrl) => {
  if (!proxyUrl) {
    return null;
  }

  try {
    const parsed = new URL(proxyUrl);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-proxy-url";
  }
};

const buildCandidates = () => {
  const directCandidate = {
    id: "direct",
    label: "direct",
    proxyUrl: null,
  };

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
      lastFailureAt: null,
      lastSuccessAt: null,
      lastError: null,
      lastOutcome: null,
    },
  ])
);

let cursor = 0;

const cloneMetrics = (entry) => ({ ...entry });

const nowIso = () => new Date().toISOString();

const rotateCandidates = () => {
  const startIndex = cursor % candidates.length;
  cursor = (cursor + 1) % candidates.length;
  return [...candidates.slice(startIndex), ...candidates.slice(0, startIndex)];
};

const updateMetric = (candidateId, updater) => {
  const current = metrics.get(candidateId);
  if (!current) {
    return;
  }

  updater(current);
};

export const getAttemptPlan = (rounds = 1) => {
  const safeRounds = Math.max(Number(rounds) || 1, 1);
  const orderedCandidates = rotateCandidates();
  const attempts = [];

  for (let round = 1; round <= safeRounds; round += 1) {
    for (const candidate of orderedCandidates) {
      attempts.push({
        ...candidate,
        round,
      });
    }
  }

  return attempts;
};

export const recordCandidateSuccess = (candidate, metadata = {}) => {
  updateMetric(candidate.id, (entry) => {
    entry.requests += 1;
    entry.successes += 1;
    entry.consecutiveFailures = 0;
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
  });
};

export const getProxyMetrics = () => {
  return candidates.map((candidate) => cloneMetrics(metrics.get(candidate.id)));
};

export const getProxySummary = () => ({
  candidateCount: candidates.length,
  configuredProxyCount: Math.max(candidates.length - 1, 0),
  metrics: getProxyMetrics(),
});
