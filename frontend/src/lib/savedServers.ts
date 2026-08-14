/**
 * savedServers.ts (unified re-export)
 * Maintains 100% backward compatibility
 *
 * Re-exports from:
 * - savedServerStore.ts: State management and derived stores
 * - savedServerUtils.ts: Normalization and utility functions
 * - savedServerActions.ts: Public API and actions
 */

import type { FrontendAppMetadataPolicy, LaunchPageConfig } from './api';
import { initializeCurrentServerMetadata } from './savedServerActions';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface SavedServerFolder {
	id: string;
	name: string;
}

export interface SavedServerEntry {
	url: string;
	localAlias: string | null;
	folderId: string | null;
	order: number;
	firstConnectedAt: number;
	lastConnectedAt: number;
	lastUsername: string | null;
	lastDbUserId: number | null;
	hasRegisteredSession: boolean;
	hasGuestSession: boolean;
	frontendMetadata: FrontendAppMetadataPolicy | null;
	launchPageBranding: Pick<LaunchPageConfig, 'brandName' | 'logoUrl' | 'heroImageUrl' | 'subheadline' | 'palette' | 'brandProfile'> | null;
	/** B3 — opt this server into the neutral (strip-Wabi) branding on launch. */
	useNeutralBranding?: boolean;
}

export interface SavedServerView extends SavedServerEntry {
	effectiveName: string;
	effectiveIconUrl: string | null;
	effectiveBannerUrl: string | null;
	effectiveAccentColor: string | null;
	effectiveDescription: string | null;
	effectiveTagline: string | null;
	isActive: boolean;
}

export interface SavedServerFolderView extends SavedServerFolder {
	members: SavedServerView[];
	effectiveName: string;
	effectiveAccentColor: string | null;
	activeMember: SavedServerView | null;
}

export type SavedServerRailItem =
	| {
		kind: 'server';
		id: string;
		server: SavedServerView;
		firstUrl: string;
		lastUrl: string;
	}
	| {
		kind: 'folder';
		id: string;
		folder: SavedServerFolderView;
		firstUrl: string;
		lastUrl: string;
	};

// ============================================================================
// RE-EXPORTS FROM savedServerStore.ts
// ============================================================================

export {
	savedServers,
	savedServerFolders,
	savedServerFolderViews,
	savedServerRailItems,
	currentSavedServer
} from './savedServerStore';

// ============================================================================
// RE-EXPORTS FROM savedServerActions.ts
// ============================================================================

export {
	recordSuccessfulServerConnection,
	renameLocalSavedServer,
	removeSavedServer,
	reorderSavedServer,
	createSavedServerFolder,
	moveSavedServerToFolder,
	renameSavedServerFolder,
	reorderSavedServerRailItem,
	refreshSavedServer,
	switchToSavedServer,
	switchToSavedServerChannel,
	openUnsavedServer,
	getUseNeutralBranding,
	setUseNeutralBranding
} from './savedServerActions';

// Initialization
initializeCurrentServerMetadata();
