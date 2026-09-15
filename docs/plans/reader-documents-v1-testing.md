# Reader Documents V1 hardening coverage

The V1 release gate includes explicit coverage for:

- source content remains untouched when entering Edit;
- private working copies survive reload and offline use;
- server/account scope changes hide the old document set and clear the visible selection;
- chat and Notes use stable source entity identities;
- stale browser windows cannot overwrite a newer IndexedDB revision;
- concurrent writers keep separate recovery mirrors;
- Share / Go Live remain gated until merge-safe replication exists.
