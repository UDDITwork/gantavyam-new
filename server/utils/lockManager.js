/**
 * Lock Manager - Prevents race conditions for critical operations
 * Uses in-memory Map for simple single-server deployments
 *
 * For multi-server deployments, consider Redis-based locking
 */

const locks = new Map();

/**
 * Acquire a lock for a given key
 * @param {string} key - Unique identifier for the lock
 * @param {number} ttlMs - Time-to-live in milliseconds (default: 10 seconds)
 * @returns {boolean} - True if lock acquired, false if already locked
 */
function acquireLock(key, ttlMs = 10000) {
  const existing = locks.get(key);

  // Check if lock exists and hasn't expired
  if (existing && Date.now() < existing.expiresAt) {
    return false;
  }

  // Acquire lock
  locks.set(key, {
    acquiredAt: Date.now(),
    expiresAt: Date.now() + ttlMs
  });

  return true;
}

/**
 * Release a lock for a given key
 * @param {string} key - Unique identifier for the lock
 */
function releaseLock(key) {
  locks.delete(key);
}

/**
 * Check if a key is currently locked
 * @param {string} key - Unique identifier for the lock
 * @returns {boolean} - True if locked, false otherwise
 */
function isLocked(key) {
  const existing = locks.get(key);
  if (!existing) return false;

  // Check if lock has expired
  if (Date.now() >= existing.expiresAt) {
    locks.delete(key);
    return false;
  }

  return true;
}

/**
 * Get remaining time on a lock
 * @param {string} key - Unique identifier for the lock
 * @returns {number} - Remaining time in ms, or 0 if not locked
 */
function getLockTimeRemaining(key) {
  const existing = locks.get(key);
  if (!existing) return 0;

  const remaining = existing.expiresAt - Date.now();
  return remaining > 0 ? remaining : 0;
}

/**
 * Clean up expired locks (called periodically)
 */
function cleanupExpiredLocks() {
  const now = Date.now();
  for (const [key, lock] of locks.entries()) {
    if (now >= lock.expiresAt) {
      locks.delete(key);
    }
  }
}

// Auto-cleanup every 5 minutes
setInterval(cleanupExpiredLocks, 5 * 60 * 1000);

module.exports = {
  acquireLock,
  releaseLock,
  isLocked,
  getLockTimeRemaining,
  cleanupExpiredLocks
};
