# Calling.ts Refactoring Status

## Progress Tracking

### Files to refactor
- [x] calling.ts - 3810 lines → 4 modules
- [ ] socket-manager.ts - 3150 lines → 5 modules
- [ ] api.ts - 1746 lines → 6 modules

### Calling.ts Breakdown
- Total exports: 29 stores + 47 functions + 8 interfaces
- Key dependencies: svelte/store, socket.io, livekit, mediaGateway

### Module Distribution Plan

#### callState.ts
- All type definitions
- All exported stores
- State management functions
- Imports from: callSignaling, callMedia, callActions

#### callSignaling.ts
- createCallOffer, handleCallOffer, handleCallAnswer, handleCallIceCandidate
- createScreenShareOffer, handleScreenShareOffer, handleScreenShareAnswer, handleScreenShareIceCandidate
- Peer connection management
- RTC configuration

#### callMedia.ts
- toggleMute, toggleDeafen, toggleVideo
- applyCurrentAudioProcessingToLocalTrack
- startScreenShare, stopScreenShare, canScreenShare
- Local/remote stream management
- Audio/video configuration

#### callActions.ts
- openChannelCallPanel, closeChannelCallPanel, toggleChannelCallPanel
- setVoiceTransmitRoutingMode
- refreshLocalAudioMuteState
- addVoiceChannelListen, removeVoiceChannelListen
- Spatial audio functions
- clearAudioPerformanceFallbackOverride
- updateCallUsername

## Next Steps
1. Extract types and stores → callState.ts
2. Extract function implementations → respective modules
3. Update imports and re-exports
4. Verify compilation
5. Run tests

