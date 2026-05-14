# Plugin Decisions - GoogleSearchReplace

## 2026-02-28
### Decision: Translate as a search-to-browser bridge instead of replacing in-app search
- Reason:
  - Wabi's internal search is already useful and should stay primary.
  - Users only need a fast continuation path for broader web results.
- Consequence:
  - Feature remains lightweight and complements existing in-chat search.

### Decision: Use user-selectable provider with DuckDuckGo default
- Reason:
  - Avoid hard-coding a single engine while keeping a privacy-friendly default.
- Consequence:
  - Users can adjust provider once and keep the same workflow.

### Decision: Keep behavior fully client-side
- Reason:
  - External search launch does not require backend processing.
- Consequence:
  - No server-side logging or new API surface introduced.
