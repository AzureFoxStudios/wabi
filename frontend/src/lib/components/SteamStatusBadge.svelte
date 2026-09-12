<script lang="ts">
  import type { User } from '$lib/socket';
  let { user: _user }: {user?:User|null} = $props();
  // Intentionally no badge: the legacy self-only polling store was not shared presence.
</script>
