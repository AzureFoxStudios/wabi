export interface SpotifyTrack {
    id: string;
    name: string;
    artist: string;
    album: string;
    durationMs: number;
    uri: string;
}

export interface SpotifySyncSession {
    id: string;
    track: SpotifyTrack;
    channelId: string;
    hostId: string;
    positionMs: number;
    isPlaying: boolean;
    volume: number;
    participants: string[];
}

export function parseTrackUri(uri: string): string | null {
    if (uri.startsWith('spotify:track:')) {
        return uri.split(':')[2];
    }
    return null;
}