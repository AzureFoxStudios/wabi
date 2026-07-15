const MAX_CACHE_ENTRIES = 200

interface CacheEntry {
  key: CryptoKey
  lastAccessed: number
}

const keyCache = new Map<string, CacheEntry>()

function evictIfNeeded(): void {
  if (keyCache.size <= MAX_CACHE_ENTRIES) return
  let oldest = Infinity
  let oldestKey = ''
  for (const [k, v] of keyCache) {
    if (v.lastAccessed < oldest) {
      oldest = v.lastAccessed
      oldestKey = k
    }
  }
  if (oldestKey) keyCache.delete(oldestKey)
}

export async function getConversationKey(convId: string): Promise<CryptoKey | null> {
  const entry = keyCache.get(convId)
  if (!entry) return null
  entry.lastAccessed = Date.now()
  return entry.key
}

export function setConversationKey(convId: string, key: CryptoKey): void {
  keyCache.set(convId, { key, lastAccessed: Date.now() })
  evictIfNeeded()
}

export function evictConversationKey(convId: string): void {
  keyCache.delete(convId)
}

export function clearAllKeys(): void {
  keyCache.clear()
}

export function cacheSize(): number {
  return keyCache.size
}
