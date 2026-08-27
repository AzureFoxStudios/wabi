# Verifying the WabiDB outbound queue + "integration done" claims

## 1. IndexedDB queue round-trip probe (browser console)

Paste in the Wabi app's browser console (after WabiDB has booted via +layout.svelte).
Proves the keyPath fix actually persists and round-trips:

```js
// needs a scope registered; System is always-on by default after openWabiDB()
const db = window.__wabiDB || null;            // getWabiDB() isn't on window; get it via the app if exposed
// If not exposed, the app calls openWabiDB() on mount; trigger enqueue through the UI path instead.
// Minimal manual IDB check of the store itself:
const req = indexedDB.open('wabi-queue', 1);
req.onsuccess = () => {
  const idb = req.result;
  const tx = idb.transaction(['outbound_queue'], 'readwrite');
  const store = tx.objectStore('outbound_queue');
  const rec = { key: 'corechat:probe-1', id: 'probe-1', scopeId: 'corechat',
                type: 'test', status: 'pending', payload: { hi: 1 }, createdAt: Date.now() };
  store.put(rec);                              // with keyPath:'key', rec MUST have .key
  store.get('corechat:probe-1').onsuccess = (e) => {
    console.log('ROUNDTRIP_OK', e.target.result);   // null === BROKEN (keyPath mismatch)
    store.delete('corechat:probe-1');
  };
  store.put({ id: 'bad', scopeId: 'corechat' }).onerror = (err) =>
    console.log('NO_KEY_THROWS', err.target.error);  // DataError === the original bug
};
```

Interpretation: if `ROUNDTRIP_OK` logs the record object, the fix is live. If `NO_KEY_THROWS`
fires `DataError`, the keyPath mismatch is still present.

## 2. "Integration done" grep recipe (agent self-reports lie)

Run from /var/home/Ronin/wabi:

```bash
# Did StorageSettings actually USE wabidb, or just import it?
grep -n "getWabiDB\|listScopes\|retryFailed\|enableScope" frontend/src/lib/components/StorageSettings.svelte

# Do the offline.* i18n keys actually get rendered anywhere?
grep -rn "offline\." frontend/src --include=*.svelte

# Are the new i18n keys present in BOTH locales (symmetric)?
grep -c "offline" frontend/src/lib/i18n/locales/en.json
grep -c "offline" frontend/src/lib/i18n/locales/es.json
```

If the component imports `openWabiDB`/`getWabiDB` but none of the call-site greps match,
the integration is dead imports — finish it or remove them. If `offline.*` exists in i18n
but the svelte grep returns nothing, the strings are orphaned.

## 3. Build-check baseline (don't trust a green check)

```bash
cd /var/home/Ronin/wabi/frontend && npm run check 2>&1 | grep -E "svelte-check found|Error:"
```

Baseline (2026-07-25): `2 errors and 90 warnings` — the 2 errors are PRE-EXISTING
(VoiceChannelList.svelte 'announcement' type mismatch; LoreChannel.svelte string|number) and
unrelated to wabidb. A wabidb change is clean if the error count stays at 2 and no new
`Error:` lines name a wabidb file. svelte-check passing does NOT prove the queue works.
