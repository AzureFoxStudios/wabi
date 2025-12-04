// Default emoji database for testing
export interface Emoji {
  id: string;
  name: string;
  url: string;
  category: string;
  isCustom: boolean;
}

// Stock emoji database using Twemoji (Twitter's open source emoji)
export const defaultEmojis: Emoji[] = [
  // Smileys
  { id: 'smile', name: 'smile', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f604.png', category: 'smileys', isCustom: false },
  { id: 'laughing', name: 'laughing', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f606.png', category: 'smileys', isCustom: false },
  { id: 'heart_eyes', name: 'heart_eyes', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60d.png', category: 'smileys', isCustom: false },
  { id: 'thinking', name: 'thinking', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f914.png', category: 'smileys', isCustom: false },
  { id: 'cry', name: 'cry', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f622.png', category: 'smileys', isCustom: false },
  { id: 'rage', name: 'rage', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f621.png', category: 'smileys', isCustom: false },
  { id: 'cool', name: 'cool', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f60e.png', category: 'smileys', isCustom: false },
  { id: 'skull', name: 'skull', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f480.png', category: 'smileys', isCustom: false },

  // Gestures
  { id: 'thumbsup', name: 'thumbsup', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44d.png', category: 'gestures', isCustom: false },
  { id: 'thumbsdown', name: 'thumbsdown', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44e.png', category: 'gestures', isCustom: false },
  { id: 'clap', name: 'clap', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44f.png', category: 'gestures', isCustom: false },
  { id: 'wave', name: 'wave', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44b.png', category: 'gestures', isCustom: false },
  { id: 'ok_hand', name: 'ok_hand', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f44c.png', category: 'gestures', isCustom: false },
  { id: 'pray', name: 'pray', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f64f.png', category: 'gestures', isCustom: false },

  // Hearts
  { id: 'heart', name: 'heart', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2764.png', category: 'hearts', isCustom: false },
  { id: 'heartbreak', name: 'heartbreak', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f494.png', category: 'hearts', isCustom: false },
  { id: 'fire', name: 'fire', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f525.png', category: 'symbols', isCustom: false },
  { id: 'sparkles', name: 'sparkles', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2728.png', category: 'symbols', isCustom: false },
  { id: 'star', name: 'star', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/2b50.png', category: 'symbols', isCustom: false },
  { id: 'boom', name: 'boom', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f4a5.png', category: 'symbols', isCustom: false },

  // Objects
  { id: 'rocket', name: 'rocket', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f680.png', category: 'objects', isCustom: false },
  { id: 'trophy', name: 'trophy', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f3c6.png', category: 'objects', isCustom: false },
  { id: 'gift', name: 'gift', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f381.png', category: 'objects', isCustom: false },
  { id: 'tada', name: 'tada', url: 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/1f389.png', category: 'objects', isCustom: false },
];

// Custom emojis uploaded by users (stored in memory for now, could be database)
export const customEmojis: Map<string, Emoji> = new Map();

export function getAllEmojis(): Emoji[] {
  return [...defaultEmojis, ...Array.from(customEmojis.values())];
}

export function getEmojiByName(name: string): Emoji | undefined {
  // Check custom emojis first
  const custom = customEmojis.get(name);
  if (custom) return custom;

  // Check default emojis
  return defaultEmojis.find(e => e.name === name);
}

export function addCustomEmoji(emoji: Emoji): void {
  customEmojis.set(emoji.name, emoji);
}

export function deleteCustomEmoji(name: string): boolean {
  return customEmojis.delete(name);
}
