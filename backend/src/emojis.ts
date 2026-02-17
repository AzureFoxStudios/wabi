import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Default emoji database for testing
export interface Emoji {
  id: string;
  name: string;
  displayName?: string;
  artist?: string;
  url: string;
  category: string;
  isCustom: boolean;
  type?: 'emoji' | 'sticker';
  source?: 'default' | 'openmoji' | 'custom';
}

// Stock emoji database using Twemoji (Twitter's open source emoji)
export const defaultEmojis: Emoji[] = [
  // Smileys
  { id: 'smile', name: 'smile', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f604.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'laughing', name: 'laughing', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f606.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'heart_eyes', name: 'heart_eyes', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60d.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'thinking', name: 'thinking', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f914.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'cry', name: 'cry', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f622.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'rage', name: 'rage', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f621.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'cool', name: 'cool', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60e.png', category: 'smileys', isCustom: false, source: 'default' },
  { id: 'skull', name: 'skull', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f480.png', category: 'smileys', isCustom: false, source: 'default' },

  // Gestures
  { id: 'thumbsup', name: 'thumbsup', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44d.png', category: 'gestures', isCustom: false, source: 'default' },
  { id: 'thumbsdown', name: 'thumbsdown', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44e.png', category: 'gestures', isCustom: false, source: 'default' },
  { id: 'clap', name: 'clap', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44f.png', category: 'gestures', isCustom: false, source: 'default' },
  { id: 'wave', name: 'wave', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44b.png', category: 'gestures', isCustom: false, source: 'default' },
  { id: 'ok_hand', name: 'ok_hand', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44c.png', category: 'gestures', isCustom: false, source: 'default' },
  { id: 'pray', name: 'pray', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f64f.png', category: 'gestures', isCustom: false, source: 'default' },

  // Hearts
  { id: 'heart', name: 'heart', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2764.png', category: 'hearts', isCustom: false, source: 'default' },
  { id: 'heartbreak', name: 'heartbreak', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f494.png', category: 'hearts', isCustom: false, source: 'default' },
  { id: 'fire', name: 'fire', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f525.png', category: 'symbols', isCustom: false, source: 'default' },
  { id: 'sparkles', name: 'sparkles', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2728.png', category: 'symbols', isCustom: false, source: 'default' },
  { id: 'star', name: 'star', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2b50.png', category: 'symbols', isCustom: false, source: 'default' },
  { id: 'boom', name: 'boom', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4a5.png', category: 'symbols', isCustom: false, source: 'default' },

  // Objects
  { id: 'rocket', name: 'rocket', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f680.png', category: 'objects', isCustom: false, source: 'default' },
  { id: 'trophy', name: 'trophy', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3c6.png', category: 'objects', isCustom: false, source: 'default' },
  { id: 'gift', name: 'gift', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f381.png', category: 'objects', isCustom: false, source: 'default' },
  { id: 'tada', name: 'tada', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f389.png', category: 'objects', isCustom: false, source: 'default' },
];

// Custom emojis uploaded by users (stored in memory for now, could be database)
export const customEmojis: Map<string, Emoji> = new Map();
let openMojiCache: Emoji[] | null = null;

function getOpenMojiDirCandidates(): string[] {
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  const envDir = process.env.OPENMOJI_DIR ? path.resolve(process.env.OPENMOJI_DIR) : null;
  const candidates = [
    envDir,
    path.resolve(process.cwd(), 'openmoji', 'png'),
    path.resolve(process.cwd(), 'frontend', 'static', 'openmoji', 'png'),
    path.resolve(currentDir, '..', '..', 'frontend', 'static', 'openmoji', 'png'),
  ].filter(Boolean) as string[];
  return candidates;
}

function loadOpenMojiEmojis(): Emoji[] {
  if (openMojiCache) return openMojiCache;

  const openMojiDir = getOpenMojiDirCandidates().find((candidate) => fs.existsSync(candidate));
  if (!openMojiDir) {
    openMojiCache = [];
    return openMojiCache;
  }

  const files = fs.readdirSync(openMojiDir).filter((file) => file.toLowerCase().endsWith('.png'));
  openMojiCache = files.map((file) => {
    const base = file.slice(0, -4);
    const normalized = base.toLowerCase();
    return {
      id: `openmoji_${normalized}`,
      name: `openmoji_${normalized}`,
      url: `/openmoji/png/${file}`,
      category: 'openmoji',
      isCustom: false,
      type: 'emoji',
      source: 'openmoji',
    };
  });

  return openMojiCache;
}

export function getAllEmojis(): Emoji[] {
  return [...defaultEmojis, ...loadOpenMojiEmojis(), ...Array.from(customEmojis.values())];
}

export function getEmojiByName(name: string): Emoji | undefined {
  // Check custom emojis first
  const custom = customEmojis.get(name);
  if (custom) return custom;

  const defaults = defaultEmojis.find(e => e.name === name);
  if (defaults) return defaults;

  return loadOpenMojiEmojis().find(e => e.name === name);
}

export function addCustomEmoji(emoji: Emoji): void {
  customEmojis.set(emoji.name, emoji);
}

export function deleteCustomEmoji(name: string): boolean {
  return customEmojis.delete(name);
}
