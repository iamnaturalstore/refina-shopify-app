function ttlCache({ ttlMs = 86400000, max = 2000 } = {}) {
  const store = new Map();

  function set(key, value) {
    const expiresAt = Date.now() + ttlMs;
    store.set(key, { value, expiresAt });
    if (store.size > max) {
      // drop oldest
      const firstKey = store.keys().next().value;
      if (firstKey) store.delete(firstKey);
    }
  }

  function get(key) {
    const ent = store.get(key);
    if (!ent) return null;
    if (Date.now() > ent.expiresAt) {
      store.delete(key);
      return null;
    }
    return ent.value;
  }

  function size() {
    return store.size;
  }

  return { set, get, size };
}

module.exports = { ttlCache };
