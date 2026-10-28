/** Pure finite defaults shared by resource specifications and inbox storage. */
export const DEFAULT_INBOX_LIMITS = Object.freeze({
  maxSessions: 256,
  maxMessagesPerSession: 500,
  maxBytesPerSession: 1024 * 1024,
  maxMessages: 5000,
  maxBytes: 8 * 1024 * 1024,
  maxMessageBytes: 64 * 1024,
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  maxBatchMessages: 100,
  maxBatchChars: 32000,
  maxBatches: 64,
  maxRetainedBatchBytes: 4 * 1024 * 1024,
  batchTtlMs: 60 * 60 * 1000,
  maxDedupEntriesPerSession: 1000,
  maxAcknowledgedBatches: 256,
  maxStateBytes: 32 * 1024 * 1024,
  maxPendingOperations: 128,
})
