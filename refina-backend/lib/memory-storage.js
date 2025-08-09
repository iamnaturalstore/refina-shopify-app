// refina/backend/lib/memory-storage.js

export class MemorySessionStorage {
  constructor() {
    this.store = new Map()
  }

  async storeSession(session) {
    this.store.set(session.id, session)
    return true
  }

  async loadSession(id) {
    return this.store.get(id) || undefined
  }

  async deleteSession(id) {
    return this.store.delete(id)
  }

  async findSessionsByShop(shop) {
    return Array.from(this.store.values()).filter((s) => s.shop === shop)
  }

  async deleteSessionsByShop(shop) {
    for (const [id, session] of this.store.entries()) {
      if (session.shop === shop) this.store.delete(id)
    }
  }
}
