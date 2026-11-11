/**
 * Stateless round-robin selector. One independent cursor per key
 * (per backend service), so load balancing for /api/users is separate
 * from /api/products etc.
 */
function createRoundRobin() {
  const cursors = new Map();

  function next(key, candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    const idx = (cursors.get(key) || 0) % candidates.length;
    cursors.set(key, idx + 1);
    return candidates[idx];
  }

  return { next };
}

module.exports = { createRoundRobin };
