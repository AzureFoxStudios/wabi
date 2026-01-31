/**
 * WebRTC Screen Share Module
 *
 * This module now re-exports from calling.ts which provides unified
 * peer connection management for both calls and screen shares.
 *
 * This file is kept for backward compatibility with existing imports.
 */

export {
	screenShares,
	isSharing,
	startScreenShare,
	stopScreenShare,
	removeScreenShare,
	handleScreenShareOffer as handleOffer,
	handleScreenShareAnswer as handleAnswer,
	handleScreenShareIceCandidate as handleIceCandidate,
	createScreenShareOffer as createOffer,
	type ScreenShare
} from './calling';
