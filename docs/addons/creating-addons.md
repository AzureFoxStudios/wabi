# Creating Addons

Quick guide to creating a new Wabi addon.

## 1. Create Folder Structure

```
addons/
└── your-addon/
    ├── plugin.json
    ├── backend/
    │   └── index.ts          # or lib.rs for Rust
    └── frontend/
        └── YourAddon.svelte  # optional
```

## 2. Write plugin.json

```json
{
  "id": "your-addon",
  "name": "Your Addon",
  "version": "1.0.0",
  "description": "What it does",
  "author": "Your Name",
  "license": "MIT",
  "permissions": ["user:read"],
  "security": {
    "threatNotes": "Describe security model"
  },
  "backend": {
    "language": "typescript",
    "entry": "./backend/index.ts"
  },
  "frontend": {
    "entry": "./frontend/YourAddon.svelte",
    "mountPoint": "settings/your-addon"
  }
}
```

See `ADDON_ARCHITECTURE.md` for full manifest schema.

## 3. Implement Backend

### TypeScript Addon

```typescript
// backend/index.ts
import type { AddonContext } from 'wabi-addon';

export default {
  async onLoad(ctx: AddonContext) {
    // Register API routes
    ctx.api.get('/your-addon/hello', handler);
  },
  
  async onUnload(ctx: AddonContext) {
    // Cleanup
  }
};
```

### Rust Addon

```rust
// backend/src/lib.rs
pub struct YourAddon;

impl Addon for YourAddon {
    fn load(&self, ctx: &AddonContext) -> Result<()> {
        // Register hooks
        Ok(())
    }
}
```

## 4. Implement Frontend (Optional)

```svelte
<!-- frontend/YourAddon.svelte -->
<script lang="ts">
  export const mountPoint = 'settings/your-addon';
</script>

<div class="your-addon">
  <h2>Your Addon Settings</h2>
</div>
```

## 5. Package & Test

```bash
# Package addon
./scripts/addon-pack.sh your-addon

# Test install/enable/disable
# Copy to plugins/ and enable in Settings
```

## 6. Verify

- [ ] Installs without errors
- [ ] Enables in Settings
- [ ] Frontend mounts if present
- [ ] Works with other addons
- [ ] Uninstalls cleanly

See `ADDON_ARCHITECTURE.md` for lifecycle details and security model.