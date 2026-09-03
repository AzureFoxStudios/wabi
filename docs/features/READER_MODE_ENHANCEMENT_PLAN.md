# Reader Mode Enhancement Plan

## Purpose

This document outlines the plan to fix critical issues in Wabi's reader mode and add requested features. It covers both the immediate fix strategy (Svelte/UI layer) and the future integration path when wabi-web receives a pass after wabi-core stabilization.

---

## Architecture Context (Rust Realignment)

Based on [RUST_REALIGNMENT_DECISION_MEMO.md](RUST_REALIGNMENT_DECISION_MEMO.md (docs-history branch, 2026-04-rust-realignment/)):

```
wabi-core (Rust)     <- Protocol, domain rules, validation, types
wabi-server (TS)     <- Gradually reduced as Rust modules take over  
wabi-web (Svelte)    <- DOM, UI, browser APIs (WHERE READER LIVES)
wabi-desktop (Tauri) <- Uses wabi-web UI + native capabilities
wabi-tui (Rust)      <- Future terminal client
```

### What Goes Where

| Reader Feature | Current Location | Future Location |
|----------------|------------------|-----------------|
| Document types, format enums | TypeScript (`readerWorkspace.ts`) | `wabi-core` (Rust) |
| Image page types | TypeScript | `wabi-core` |
| Preferences schema | TypeScript | `wabi-core` → persisted to SpacetimeDB |
| **UI/View layer** | Svelte (`ReaderTab.svelte`) | **Stays in wabi-web** |
| Scroll manipulation | Svelte/DOM | **Stays in wabi-web** |
| Image rendering | Svelte | **Stays in wabi-web** |
| Keyboard handling | Svelte | **Stays in wabi-web** |

**Key Principle**: Browser-native interaction (DOM, scroll, UI controls) stays in Svelte. Protocol types and validation move to `wabi-core`.

---

## Current State

### Location
- **Component**: `/frontend/src/lib/components/ReaderTab.svelte`
- **State Management**: `/frontend/src/lib/readerWorkspace.ts`
- **Architecture Layer**: `wabi-web` (SvelteKit browser client)

### Issues Identified

1. **Critical: Scroll Restoration Race Condition**
   - **Location**: `ReaderTab.svelte:162-171`
   - **Symptom**: Reader feels "frozen" at top of page, scroll position doesn't restore properly
   - **Root Cause**: Async `tick().then()` callback can execute for wrong document when switching documents rapidly
   - **Code**:
     ```svelte
     $: if ($readerSelection && articleViewport && $readerSelection.docKey !== lastRestoredDocKey) {
         lastRestoredDocKey = $readerSelection.docKey;
         const nextProgress = selectedStoredProgress;
         void tick().then(() => {
             if (!articleViewport) return;  // Only checks viewport existence
             const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
             articleViewport.scrollTop = maxScroll * nextProgress;
             readerProgressPercent = Math.round(nextProgress * 100);
         });
     }
     ```

2. **Missing: Page Navigation Controls**
   - No "Next Page" or "Previous Page" buttons
   - Users must scroll manually through entire document
   - No pagination UI indicators

3. **Missing: Full-Screen No-UI Mode**
   - No way to hide all UI elements for distraction-free reading
   - No fullscreen toggle button

4. **Feature: Image/Manga Viewer** (NEWLY ADDED)
   - Reader now handles both text documents AND image galleries
   - Supports manga/comic reading with LTR/RTL direction
   - Page-by-page navigation for images

---

## Part 1: Normal Fix Plan (Svelte/UI Layer)

### Fix 1: Scroll Restoration Race Condition

**File**: `ReaderTab.svelte` (lines 162-171)

**Problem**: The async callback captures `nextProgress` but doesn't validate that the document hasn't changed by the time the callback executes.

**Solution**: Add document key validation inside the async callback.

**Implementation**:
```svelte
$: if ($readerSelection && articleViewport && $readerSelection.docKey !== lastRestoredDocKey) {
    const currentDocKey = $readerSelection.docKey;  // Capture current key
    lastRestoredDocKey = currentDocKey;
    const nextProgress = selectedStoredProgress;
    void tick().then(() => {
        // VALIDATION: Ensure document hasn't changed
        if (!articleViewport || $readerSelection?.docKey !== currentDocKey) return;
        
        const maxScroll = Math.max(0, articleViewport.scrollHeight - articleViewport.clientHeight);
        articleViewport.scrollTop = maxScroll * nextProgress;
        readerProgressPercent = Math.round(nextProgress * 100);
    });
}
```

**Why This Works**:
- Captures `currentDocKey` synchronously before the async boundary
- Validates document identity inside the async callback
- Prevents scroll restoration for wrong document
- Maintains backward compatibility

---

### Fix 2: Clickable Page Navigation

**File**: `ReaderTab.svelte` (add UI controls and logic)

**Design Decision**: Since reader mode renders documents as a single scrollable view (not true paginated pages), "Next Page" and "Previous Page" will scroll by approximately 80% of the viewport height (providing 20% overlap for readability).

**UI Implementation**:
Add buttons to the reader controls area (near existing history dropdown):

```svelte
<!-- In reader controls section -->
<div class="reader-controls">
    <button 
        class="reader-control-btn" 
        on:click={goToPreviousPage}
        disabled={isAtDocumentStart}
        title="Previous Page"
    >
        ← Previous
    </button>
    
    <span class="reader-page-indicator">
        {currentPageEstimate} / {totalPagesEstimate}
    </span>
    
    <button 
        class="reader-control-btn" 
        on:click={goToNextPage}
        disabled={isAtDocumentEnd}
        title="Next Page"
    >
        Next →
    </button>
</div>
```

**Logic Implementation**:
```typescript
// Add to ReaderTab.svelte script section
let isAtDocumentStart = true;
let isAtDocumentEnd = false;
$: currentPageEstimate = 1;
$: totalPagesEstimate = 1;

function goToNextPage(): void {
    if (!articleViewport) return;
    const viewportHeight = articleViewport.clientHeight;
    const newScroll = Math.min(
        articleViewport.scrollTop + (viewportHeight * 0.8),
        articleViewport.scrollHeight - viewportHeight
    );
    articleViewport.scrollTop = newScroll;
    updatePageEstimate();
}

function goToPreviousPage(): void {
    if (!articleViewport) return;
    const viewportHeight = articleViewport.clientHeight;
    const newScroll = Math.max(
        articleViewport.scrollTop - (viewportHeight * 0.8),
        0
    );
    articleViewport.scrollTop = newScroll;
    updatePageEstimate();
}

function updatePageEstimate(): void {
    if (!articleViewport) return;
    const { scrollTop, scrollHeight, clientHeight } = articleViewport;
    if (scrollHeight <= clientHeight) {
        currentPageEstimate = 1;
        totalPagesEstimate = 1;
        isAtDocumentStart = true;
        isAtDocumentEnd = true;
        return;
    }
    totalPagesEstimate = Math.ceil(scrollHeight / (clientHeight * 0.8));
    currentPageEstimate = Math.floor(scrollTop / (clientHeight * 0.8)) + 1;
    isAtDocumentStart = scrollTop <= 0;
    isAtDocumentEnd = scrollTop + clientHeight >= scrollHeight - 5; // 5px threshold
}
```

**Integration**: Call `updatePageEstimate()` inside `handleViewportScroll()` function.

---

### Fix 3: Full-Screen No-UI Mode

**File**: `ReaderTab.svelte` (add toggle button, state, and CSS)

**State Addition**:
```typescript
import { writable } from 'svelte/store';
// ... existing code ...
let isFullscreenMode = false;

function toggleFullscreenMode(): void {
    isFullscreenMode = !isFullscreenMode;
    // Optional: persist preference
    if (browser) {
        localStorage.setItem('wabi:reader:fullscreen', isFullscreenMode ? 'true' : 'false');
    }
}
```

**UI Toggle Button**:
```svelte
<button 
    class="reader-control-btn"
    on:click={toggleFullscreenMode}
    title={isFullscreenMode ? "Exit Fullscreen" : "Enter Fullscreen"}
>
    {isFullscreenMode ? 'Exit ↔️' : 'Fullscreen ⛶'}
</button>
```

**CSS Classes**:
```css
/* Fullscreen mode - hide all UI */
.reader-shell.fullscreen-mode .reader-header,
.reader-shell.fullscreen-mode .reader-controls,
.reader-shell.fullscreen-mode .reader-history-dropdown {
    display: none;
}

.reader-shell.fullscreen-mode .reader-document-viewport {
    padding: 0;
    height: 100vh;
    max-width: 100%;
}

.reader-shell.fullscreen-mode {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9999;
    background: var(--bg-primary);
}
```

**Apply Class**:
```svelte
<div
    class="reader-shell"
    class:theme-paper={$readerPreferences.theme === 'paper'}
    class:theme-sepia={$readerPreferences.theme === 'sepia'}
    class:theme-night={$readerPreferences.theme === 'night'}
    class:font-serif={$readerPreferences.fontFamily === 'serif'}
    class:font-sans={$readerPreferences.fontFamily === 'sans'}
    class:fullscreen-mode={isFullscreenMode}
>
```

---

## Part 2: Future Integration (Post wabi-core Pass)

### Context: Rust Realignment Impact

When wabi-core is patched and wabi-web receives a pass, the following may change:

1. **Protocol Definitions**: Types (ReaderDocumentFormat, ReaderTheme, ImageFitMode, etc.) move to `wabi-core` Rust
2. **State Management**: Preferences/progress may sync to SpacetimeDB instead of remaining browser-local
3. **Cross-Client Consistency**: Desktop (Tauri) and future TUI clients will share core types
4. **Image Handling**: May use wabi-core for image metadata/caching

### wabi-core Type Extraction (Future)

The following types should eventually be defined in `wabi-core` and imported:

```rust
// crates/wabi-core/src/reader.rs (future)
#[derive(Serialize, Deserialize)]
pub enum ReaderDocumentFormat {
    Markdown,
    Html,
    Text,
}

#[derive(Serialize, Deserialize)]
pub enum ReaderContentType {
    Text,
    Images,
}

#[derive(Serialize, Deserialize)]
pub struct ImagePage {
    pub url: String,
    pub alt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize, Deserialize)]
pub struct ReaderDocumentSelection {
    pub id: String,
    pub doc_key: String,
    pub title: String,
    pub content: String,
    pub format: ReaderDocumentFormat,
    pub updated_at: i64,
    pub source: ReaderDocumentSource,
    pub content_type: ReaderContentType,
    pub images: Option<Vec<ImagePage>>,
}
```

### What Stays the Same

- **Reader mode remains Svelte UI**: As per the Rust realignment memo, browser-native interaction (DOM, scroll, UI controls) stays in Svelte/TypeScript
- **Component Structure**: `ReaderTab.svelte` remains the primary UI component
- **Visual Design**: CSS classes, theming, and layout remain Svelte-scoped
- **Browser APIs**: Scroll manipulation, DOM events, and viewport measurements remain in UI layer
- **Image Rendering**: Image display, fit modes, and lightbox stay in Svelte

### Integration Strategy

#### 1. Type Migration to wabi-core
**Current**: TypeScript types in `readerWorkspace.ts`
**Future**: Import from `@wabi/core` or generated TypeScript from Rust

```typescript
// Future: Import from wabi-core
import type { 
  ReaderDocumentFormat, 
  ReaderDocumentSelection,
  ReaderPreferences as CoreReaderPreferences 
} from '@wabi/core';

// Keep UI-only types in Svelte
export type ImageFitMode = 'width' | 'height' | 'original';
export type ReadingDirection = 'ltr' | 'rtl';
```

#### 2. Scroll Restoration Fix
**Current**: Pure Svelte store + localStorage
**Future**: Uses core document identity validation

**Adaptation**:
```typescript
// If wabi-core provides document identity validation:
import { validateDocumentKey } from '@wabi/core'; // Future import

$: if ($readerSelection && articleViewport && $readerSelection.docKey !== lastRestoredDocKey) {
    const currentDocKey = $readerSelection.docKey;
    lastRestoredDocKey = currentDocKey;
    const nextProgress = selectedStoredProgress;
    void tick().then(() => {
        // Use core validation if available
        if (!articleViewport) return;
        if (typeof validateDocumentKey === 'function') {
            if (!validateDocumentKey(currentDocKey, $readerSelection)) return;
        } else {
            if ($readerSelection?.docKey !== currentDocKey) return;
        }
        // ... rest of scroll restoration
    });
}
```

#### 3. Page Navigation
**Current**: DOM scroll manipulation in Svelte
**Future**: No change needed - this is UI-layer behavior

**Adaptation**: None required. Scroll manipulation is browser-native and stays in Svelte.

#### 4. Full-Screen Mode
**Current**: CSS class toggle + localStorage
**Future**: May sync preference via `wabi-core` user settings protocol

**Adaptation**:
```typescript
// If wabi-core provides user settings sync:
import { userSettings } from '@wabi/core'; // Future import

function toggleFullscreenMode(): void {
    isFullscreenMode = !isFullscreenMode;
    // Sync to core if available
    if (userSettings?.set) {
        userSettings.set('reader.fullscreen', isFullscreenMode);
    } else {
        // Fallback to localStorage
        localStorage.setItem('wabi:reader:fullscreen', isFullscreenMode ? 'true' : 'false');
    }
}
```

#### 5. Image/Manga Viewer (NEW)
**Current**: Svelte handles all image logic
**Future**: Core may handle image metadata/caching, UI stays in Svelte

The image/manga viewer is inherently a UI feature:
- Image loading/rendering: Svelte (browser-native)
- Page navigation: Svelte (DOM manipulation)
- Fit modes: Svelte (CSS object-fit)
- **Potential core integration**: Image metadata validation, URL normalization

#### 6. Persistence Migration Path

**Current State**:
```typescript
// readerWorkspace.ts
const READER_PREFS_STORAGE_KEY = 'wabi:reader:prefs:v1';
const READER_PROGRESS_STORAGE_KEY = 'wabi:reader:progress:v1';

// Uses localStorage directly
function writeJson<T>(key: string, value: T): void {
    if (!browser) return;
    localStorage.setItem(key, JSON.stringify(value));
}
```

**Future State (Post Core with Persistence)**:
```typescript
// readerWorkspace.ts - Updated for core integration
import { persistence } from '@wabi/core'; // Future

const readerPreferences = writable<ReaderPreferences>(
    normalizePreferences(
        // Try core persistence first, fallback to localStorage
        persistence?.get('reader.prefs') ?? 
        readJson<Partial<ReaderPreferences> | null>(READER_PREFS_STORAGE_KEY, null)
    )
);

// Sync to core on changes
readerPreferences.subscribe((value) => {
    if (persistence?.set) {
        persistence.set('reader.prefs', value);
    } else {
        writeJson(READER_PREFS_STORAGE_KEY, value);
    }
});
```

**Note**: Reader preferences can persist beyond browser-local state once wired to SpacetimeDB.

---

## Implementation Priority

### Phase 1: Critical Fix (Done)
1. ✅ Fix scroll restoration race condition
2. ✅ Test rapid document switching
3. ✅ Verify scroll position restores correctly

### Phase 2: Feature Addition (Done)
1. ✅ Add page navigation buttons
2. ✅ Add fullscreen toggle
3. ✅ Add image/manga viewer
4. ✅ Style to match existing reader UI

### Phase 3: Future-Proofing (Prepare for Core)
1. ✅ Add types with comments noting future wabi-core migration
2. ✅ Document which parts are UI-only vs protocol-dependent
3. ✅ Ensure clean separation between DOM logic and state logic
4. ⏳ Add feature flags or abstraction layers for persistence (when core is ready)

---

## Testing Checklist

### Scroll Fix Verification
- [x] Open document A, scroll to 50%, switch to document B, switch back to A
- [x] Rapidly switch between 3+ documents in history dropdown
- [x] Verify scroll position restores to correct document
- [x] Verify no "frozen" scroll at top

### Page Navigation Verification
- [x] Click "Next Page" - document scrolls approximately 80% viewport height
- [x] Click "Previous Page" - document scrolls back
- [x] Buttons disable at document boundaries
- [x] Page estimate updates during manual scroll

### Fullscreen Mode Verification
- [x] Toggle fullscreen - all UI hides except document
- [x] Document expands to fill viewport
- [x] Toggle off - UI returns
- [x] Preference persists across sessions (localStorage)

### Image/Manga Viewer Verification
- [x] Click "Images" button to open file picker
- [x] Select multiple image files - opens in image viewer mode
- [x] Navigate between images with prev/next buttons
- [x] Arrow keys work in image viewer (left/right)
- [x] Escape closes image viewer
- [x] Image fit modes work (width/height/original)
- [x] RTL reading direction for manga
- [x] Fullscreen mode works with images
- [x] Image counter shows current page / total

---

## Files Modified (Current Phase)

1. `/frontend/src/lib/components/ReaderTab.svelte`
   - Fix scroll restoration
   - Add page navigation buttons and logic
   - Add fullscreen toggle and state
   - Add image/manga viewer UI

2. `/frontend/src/lib/readerWorkspace.ts`
   - Add image types (ImagePage, ImageFitMode, ReadingDirection)
   - Add contentType to ReaderDocumentSelection
   - Add image preferences (imageFit, readingDirection)
   - Add functions for opening image documents
   - Add comments noting future wabi-core migration

3. `/docs-history branch: READER_MODE_ENHANCEMENT_PLAN.md`
   - Updated for Rust realignment architecture
   - Added image/manga viewer to scope
   - Documented future wabi-core integration path

---

## Summary

| Feature | Current Implementation | Future Integration |
|---------|----------------------|-------------------|
| Scroll Fix | Svelte store + validation | May use core document validation |
| Page Navigation | DOM scroll manipulation | No change (UI-layer) |
| Fullscreen Mode | CSS classes + localStorage | May sync via core user settings |
| Image Viewer | Svelte + DOM APIs | Core may handle metadata |
| Persistence | localStorage | Migrate to SpacetimeDB or keep browser-local in IndexedDB |

The key principle: **Keep UI behavior in Svelte, prepare state management for core integration.**
