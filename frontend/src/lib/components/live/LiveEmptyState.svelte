<script lang="ts">
  import { currentUser, users } from '$lib/socket';
  import type { Channel } from '$lib/socket';

  export let channel: Channel;
  export let liveCount: number = 0;
  export let onJoin: () => void;

  $: participantUsers = $users.filter(u =>
    channel.members?.includes(u.id) || channel.members === undefined
  ).slice(0, 5);

  $: displayName = channel.name || 'Live Room';
  $: topic = channel.topic || channel.description || '';
</script>

<div class="live-empty-state">
  <div class="empty-content">
    <div class="live-icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="23 7 16 12 23 17 23 7"></polygon>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
      </svg>
    </div>

    <h2 class="room-name">{displayName}</h2>
    {#if topic}
      <p class="topic">{topic}</p>
    {/if}

    <p class="subtitle">Be here now. Nothing is saved.</p>

    {#if participantUsers.length > 0}
      <div class="avatar-row">
        {#each participantUsers as user (user.id)}
          <div class="avatar-wrapper">
            {#if user.profilePicture}
              <img src={user.profilePicture} alt={user.username} class="avatar-img" />
            {:else}
              <div class="avatar-placeholder" style="background-color: {user.color || '#98D8C8'}">
                {user.username?.charAt(0).toUpperCase() || '?'}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <p class="live-count">{liveCount} {liveCount === 1 ? 'person' : 'people'} live right now</p>

    <button class="join-btn" on:click={onJoin}>
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon">
        <polygon points="23 7 16 12 23 17 23 7"></polygon>
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect>
      </svg>
      Join Live
    </button>
  </div>
</div>

<style>
  .live-empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 32px;
    box-sizing: border-box;
  }

  .empty-content {
    text-align: center;
    max-width: 400px;
  }

  .live-icon {
    width: 80px;
    height: 80px;
    margin: 0 auto 20px;
    color: var(--accent-primary-color, #5b8dee);
    opacity: 0.7;
  }

  .live-icon :global(svg) {
    width: 100%;
    height: 100%;
  }

  .room-name {
    font-size: 24px;
    font-weight: 700;
    margin: 0 0 8px;
    color: var(--text-primary);
  }

  .topic {
    font-size: 14px;
    color: var(--text-secondary);
    margin: 0 0 16px;
  }

  .subtitle {
    font-size: 14px;
    color: var(--text-muted, #8e9297);
    margin: 0 0 24px;
    font-style: italic;
  }

  .avatar-row {
    display: flex;
    justify-content: center;
    gap: -4px;
    margin-bottom: 12px;
  }

  .avatar-wrapper {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    overflow: hidden;
    border: 2px solid var(--surface-base);
    margin-left: -8px;
    flex-shrink: 0;
  }

  .avatar-wrapper:first-child {
    margin-left: 0;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    color: #fff;
    font-size: 14px;
  }

  .live-count {
    font-size: 14px;
    color: var(--text-muted, #8e9297);
    margin: 0 0 24px;
  }

  .join-btn {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 12px 28px;
    border: none;
    border-radius: 8px;
    background: var(--accent-primary-color, #5b8dee);
    color: #fff;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .join-btn:hover {
    background: var(--accent-primary-hover, #4a7bd5);
  }

  .btn-icon {
    width: 18px;
    height: 18px;
  }
</style>
