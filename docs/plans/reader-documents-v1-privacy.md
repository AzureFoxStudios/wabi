# Reader Documents V1 privacy boundary

Private Reader documents are scoped to the normalized active Wabi server plus the active account identity. Registered users use their database user ID; guests use the server-scoped guest session; signed-out use falls back to a stable local device identity.

Changing server or account clears the visible Reader selection before the next scope is hydrated. IndexedDB and recovery/fallback keys include the scope. A document from one scope must never appear in another scope's Documents list or Reader view.
