export const MAX_TIME_SCALE = 120;
const MAX_SEGMENTS = 4096;
const MAX_DATE_MS = 8.64e15;
function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`ABS clock ${label} must be finite`);
  return value;
}
function timestamp(value, label) {
  finite(value, label);
  if (Math.abs(value) > MAX_DATE_MS) throw new RangeError(`ABS clock ${label} exceeds Date range`);
  return value;
}
export function validateTimeScale(value) {
  finite(value, 'timeScale');
  if (value < 0 || value > MAX_TIME_SCALE) throw new RangeError(`ABS timeScale must be between 0 and ${MAX_TIME_SCALE}`);
  return value === 0 ? 0 : value;
}
const project = (s, realAt) => timestamp(s.virtualAt + (realAt - s.realAt) * s.scale, 'projected time');
export function validateClockSnapshot(snapshot) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.segments) || !snapshot.segments.length || snapshot.segments.length > MAX_SEGMENTS) throw new Error('ABS clock snapshot invalid');
  let previous;
  for (const s of snapshot.segments) {
    if (!s || typeof s !== 'object') throw new Error('ABS clock segment invalid');
    timestamp(s.realAt, 'segment realAt'); timestamp(s.virtualAt, 'segment virtualAt'); validateTimeScale(s.scale);
    if (previous && (s.realAt < previous.realAt || s.virtualAt !== project(previous, s.realAt))) throw new Error('ABS clock segments are not continuous');
    previous = s;
  }
  timestamp(snapshot.lastRealAt, 'lastRealAt'); timestamp(snapshot.lastVirtualAt, 'lastVirtualAt');
  if (snapshot.lastRealAt < previous.realAt || snapshot.lastVirtualAt !== project(previous, snapshot.lastRealAt)) throw new Error('ABS clock watermark invalid');
  return snapshot;
}
/** Wall regressions freeze at the watermark: elapsed periods are never counted
 * twice. Receipt objects are untouched; callers explicitly map timestamps. */
export function createAbsClock({ realNow = Date.now, snapshot = null, initialVirtualMs, scale = 1 } = {}) {
  if (typeof realNow !== 'function') throw new TypeError('ABS realNow must be a function');
  validateTimeScale(scale);
  let segments, lastRealAt, lastVirtualAt;
  if (snapshot !== null) {
    validateClockSnapshot(snapshot);
    ({ segments, lastRealAt, lastVirtualAt } = structuredClone(snapshot));
  } else {
    lastRealAt = timestamp(realNow(), 'realNow');
    lastVirtualAt = initialVirtualMs === undefined ? lastRealAt : timestamp(initialVirtualMs, 'initialVirtualMs');
    segments = [{ realAt: lastRealAt, virtualAt: lastVirtualAt, scale: validateTimeScale(scale) }];
  }
  const current = () => segments[segments.length - 1];
  function sample() {
    const realAt = Math.max(lastRealAt, timestamp(realNow(), 'realNow'));
    const virtualAt = project(current(), realAt);
    lastRealAt = realAt; lastVirtualAt = virtualAt;
    return virtualAt;
  }
  return {
    now: sample,
    realNow() { sample(); return lastRealAt; },
    get timeScale() { return current().scale; },
    setScale(value) {
      const next = validateTimeScale(value);
      if (next !== current().scale && segments.length >= MAX_SEGMENTS) throw new RangeError('ABS clock segment capacity exceeded; refusing mapping eviction');
      sample();
      if (next !== current().scale) segments.push({ realAt: lastRealAt, virtualAt: lastVirtualAt, scale: next });
    },
    snapshot() {
      sample();
      return structuredClone({ version: 1, segments, lastRealAt, lastVirtualAt });
    },
    toVirtual(realTimestampMs) {
      timestamp(realTimestampMs, 'receipt timestamp');
      const first = segments[0];
      if (realTimestampMs < first.realAt) return timestamp(first.virtualAt + (realTimestampMs - first.realAt), 'legacy projected time');
      // Rightmost anchor wins when multiple changes share a wall tick.
      let low = 0, high = segments.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (segments[middle].realAt <= realTimestampMs) low = middle;
        else high = middle;
      }
      return project(segments[low], realTimestampMs);
    },
    delayUntil(virtualTargetMs) {
      timestamp(virtualTargetMs, 'target timestamp');
      const now = sample();
      return current().scale === 0 ? null : Math.max(0, (virtualTargetMs - now) / current().scale);
    },
  };
}
