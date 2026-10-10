/** Read an authenticated room policy; unknown metadata is never a 24h choice. */
export function currentRetentionFromPrivacy(value: unknown, channelId: string): string | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const policy = value as { channelId?: unknown; retention?: unknown };
    if (policy.channelId !== channelId || typeof policy.retention !== 'string') return null;
    const label = policy.retention;
    if (label === 'live' || label === 'forever') return label;
    const match = /^([1-9]\d*)(s|m|h|d)$/.exec(label);
    if (!match) return null;
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2] as 's' | 'm' | 'h' | 'd'];
    const milliseconds = Number(match[1]) * unit;
    if (!Number.isSafeInteger(milliseconds) || milliseconds > 365 * 86400000) return null;
    const aliases: Record<number, string> = {
        5000: '5s', 30000: '30s', 60000: '1m', 300000: '5m', 1800000: '30m',
        3600000: '1h', 21600000: '6h', 43200000: '12h', 86400000: '24h',
        259200000: '3d', 604800000: '7d', 1209600000: '14d', 2592000000: '30d', 7776000000: '90d'
    };
    return aliases[milliseconds] || label;
}

/** Saving a name/description must not overwrite the current retention. */
export function explicitRetentionUpdate(choice: string | null | undefined): { autoDeleteAfter?: string | null } {
    return choice === undefined ? {} : { autoDeleteAfter: choice };
}
