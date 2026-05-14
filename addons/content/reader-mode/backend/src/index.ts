export interface ReaderSettings {
    fontSize: number;
    fontFamily: string;
    lineHeight: number;
    theme: ReaderTheme;
    width: ReaderWidth;
}

export type ReaderTheme = 'light' | 'dark' | 'sepia';
export type ReaderWidth = 'narrow' | 'medium' | 'wide' | 'full';

export function createDefaultSettings(): ReaderSettings {
    return {
        fontSize: 18,
        fontFamily: 'system-ui',
        lineHeight: 1.6,
        theme: 'dark',
        width: 'medium',
    };
}

export function transformContent(html: string, settings: ReaderSettings): string {
    return html;
}