#!/usr/bin/env python3
"""Replace the 7 type-siloed sidebar sections with ONE unified rearrangeable section."""
import sys

PATH = "/var/home/Ronin/wabi/frontend/src/lib/components/ChannelSidebar.svelte"

with open(PATH) as fh:
    lines = fh.readlines()

# Find boundaries (0-indexed)
# Start: the section-heading-row for Text Channels (first occurrence after CreateChannelForm)
start_idx = None
for i, line in enumerate(lines):
    if '<div class="section-heading-row">' in line:
        start_idx = i
        break
if start_idx is None:
    print("ERROR: start boundary not found")
    sys.exit(1)

# End: the dm-hub-entry div (line with 'dm-hub-entry')
end_idx = None
for i in range(start_idx, len(lines)):
    if 'dm-hub-entry' in lines[i]:
        end_idx = i
        break
if end_idx is None:
    print("ERROR: end boundary not found")
    sys.exit(1)

print(f"Replacing lines {start_idx+1}..{end_idx} ({end_idx - start_idx} lines)")

UNIFIED = '''		<div class="section-heading-row">
	<button class="section-toggle" type="button" aria-expanded={isTextSectionExpanded} on:click={() => toggleSection('text')}>
		<span class="section-chevron" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
		<span class="section-toggle-label">Channels</span><span class="section-count">{unifiedChannelCount}</span>
	</button>
	{#if canCreateChannel}<button class="section-add-btn" class:active={showCreateInput && newChannelType !== 'category'} on:click={() => toggleCreateInputForType('text')} title="Create channel" aria-label="Create channel"><span class="plus-glyph" aria-hidden="true">+</span></button>
		<button class="section-add-btn section-category-btn" class:active={showCreateInput && newChannelType === 'category'} on:click={openCreateFormForCategory} title="Create category" aria-label="Create category"><span class="plus-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><line x1="12" y1="10" x2="12" y2="16"></line><line x1="9" y1="13" x2="15" y2="13"></line></svg></span></button>{/if}
		</div>
		{#if isTextSectionExpanded}
	{#each unifiedCategoryMap.categories as cat (cat.id)}
		<div class="category-row" class:drop-target={categoryDropTargetClass(cat.id)} on:dragover|stopPropagation={(e) => handleCategoryDragOver(e, cat.id)} on:dragleave|stopPropagation={() => handleCategoryDragLeave(cat.id)} on:drop|stopPropagation={(e) => handleCategoryDrop(e, cat.id)} on:contextmenu={(e) => handleChannelRightClick(e, cat.channel)} use:longpress={{ onLongPress: (e) => handleChannelLongPress(e, cat.channel) }}>
			<button class="category-toggle" type="button" aria-expanded={!collapsedCategories.has(cat.id)} on:click={() => toggleCategory(cat.id)}>
				<span class="category-chevron"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"></path></svg></span>
				<span class="category-folder-icon"><svg class="category-folder-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg></span>
				<span class="category-name">{cat.name}<span class="category-count">{cat.channels.length}</span></span>
			</button>
		</div>
		{#if !collapsedCategories.has(cat.id)}
			<div class="category-channels" data-category-id={cat.id}>
				<UnifiedChannelList channels={cat.channels} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} {dropTargetClass} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragOver={handleChannelDragOver} onChannelDragLeave={handleChannelDragLeave} onChannelDrop={handleChannelDrop} onChannelDragEnd={handleChannelDragEnd} />
			</div>
		{/if}
	{/each}
	<UnifiedChannelList channels={unifiedCategoryMap.uncategorized} {threadChannelsByParent} {followedChannelIds} {liveWhiteboardChannelIds} {breakoutChannelsByParent} {connectedVoiceChannelIds} {runtimeActiveVoiceChannelId} {voiceDropTargetChannelId} {voicePresenceSince} {voiceDurationMode} {nowMs} {dropTargetClass} {isChannelDragging} onChannelClick={handleChannelClick} onChannelButtonClick={handleChannelButtonClick} onVoiceChannelClick={handleVoiceChannelClick} onChannelRightClick={handleChannelRightClick} onChannelLongPress={handleChannelLongPress} onToggleChannelFollow={toggleChannelFollowState} onOpenChannelSettings={handleOpenChannelSettings} onShowPinnedMessages={handleShowPinnedMessages} onToggleListenChannel={handleToggleListenChannel} onOpenVoiceChannelWhiteboard={openVoiceChannelWhiteboard} {canDragVoiceMember} onVoiceMemberDragStart={handleVoiceMemberDragStart} onVoiceMemberDragEnd={handleVoiceMemberDragEnd} onVoiceChannelDragOver={handleVoiceChannelDragOver} onVoiceChannelDragLeave={handleVoiceChannelDragLeave} onVoiceChannelDrop={handleVoiceChannelDrop} onChannelDragStart={handleChannelDragStart} onChannelDragOver={handleChannelDragOver} onChannelDragLeave={handleChannelDragLeave} onChannelDrop={handleChannelDrop} onChannelDragEnd={handleChannelDragEnd} />
	{/if}

'''

lines[start_idx:end_idx] = [UNIFIED]

with open(PATH, "w") as fh:
    fh.writelines(lines)

print("DONE")
