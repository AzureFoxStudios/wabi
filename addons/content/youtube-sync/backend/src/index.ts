export interface YouTubeVideo {
    videoId: string;
    title: string;
    channelName: string;
    duration: number;
}

export interface SyncSession {
    id: string;
    video: YouTubeVideo;
    channelId: string;
    hostId: string;
    currentTime: number;
    isPlaying: boolean;
    participants: string[];
}

export function extractVideoId(url: string): string | null {
    const patterns = [
        /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
    ];
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}