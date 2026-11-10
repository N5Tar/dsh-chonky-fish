export const DEFAULT_CONFIG = Object.freeze({
  sampleIntervalMs: 5000,
  analysisIntervalMs: 30000,
  rawTtlMs: 3600000,
  summaryTtlMs: 7 * 86400000,
  cleanupIntervalMs: 300000,
  sampleStaleMs: 20000,
  analysisStaleMs: 90000,
  maxGapMs: 10000,
  clockToleranceMs: 1000,
});

export function resolveConfig(overrides = {}) {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) {
      throw new TypeError(`Invalid perception configuration: ${key}`);
    }
  }
  if (config.rawTtlMs < 15 * 60000 + config.analysisIntervalMs) {
    throw new RangeError('rawTtlMs must retain the 15 minute window plus one analysis period');
  }
  return Object.freeze(config);
}
