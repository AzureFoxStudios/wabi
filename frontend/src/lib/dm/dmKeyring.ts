export interface StoredKeyBundle {
  publicKeyB64: string
  privateKeyJwk: JsonWebKey
  deviceId: string
  createdAt: number
  layoutPreference?: string
}

const DB_NAME = 'wabi-keyring'
const STORE_NAME = 'keys'
const DB_VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveIdentity(uid: string, bundle: StoredKeyBundle): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(bundle, uid)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  } catch {
    throw new Error('Failed to save identity key')
  }
}

export async function loadIdentity(uid: string): Promise<StoredKeyBundle | null> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).get(uid)
      request.onsuccess = () => { db.close(); resolve(request.result || null) }
      request.onerror = () => { db.close(); reject(request.error) }
    })
  } catch {
    return null
  }
}

export async function hasIdentity(uid: string): Promise<boolean> {
  const bundle = await loadIdentity(uid)
  return bundle !== null
}

export async function deleteIdentity(uid: string): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(uid)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    })
  } catch {
    throw new Error('Failed to delete identity key')
  }
}

export async function listIdentityIds(): Promise<string[]> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const request = tx.objectStore(STORE_NAME).getAllKeys()
      request.onsuccess = () => { db.close(); resolve(request.result as string[]) }
      request.onerror = () => { db.close(); reject(request.error) }
    })
  } catch {
    return []
  }
}

export async function saveLayoutPreference(uid: string, layout: string): Promise<void> {
  const bundle = await loadIdentity(uid)
  if (!bundle) return
  bundle.layoutPreference = layout
  await saveIdentity(uid, bundle)
}

export async function loadLayoutPreference(uid: string): Promise<string | undefined> {
  const bundle = await loadIdentity(uid)
  return bundle?.layoutPreference
}
