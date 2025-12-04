import { marked } from 'marked';
import Prism from 'prismjs';
import DOMPurify from 'dompurify';
import { get } from 'svelte/store';
import { emojis } from './socket';

// Import Prism language support
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-java';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-csharp';
import 'prismjs/components/prism-go';
import 'prismjs/components/prism-rust';
// Removed PHP - causes tokenizePlaceholders error
import 'prismjs/components/prism-ruby';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-css';

// Emote store (will be populated from server)
export const emotes = new Map<string, {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}>();

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Language aliases for common abbreviations
const languageAliases: Record<string, string> = {
  'js': 'javascript',
  'ts': 'typescript',
  'py': 'python',
  'rb': 'ruby',
  'sh': 'bash',
  'yml': 'yaml',
  'md': 'markdown',
  'c++': 'cpp',
  'csharp': 'csharp',
  'c#': 'csharp',
  'golang': 'go',
  'rs': 'rust',
};

// Custom renderer for code blocks with syntax highlighting
const renderer = {
  code(token: any) {
    const code = token.text;
    let lang = token.lang;

    // Map common aliases to full language names
    if (lang && languageAliases[lang.toLowerCase()]) {
      lang = languageAliases[lang.toLowerCase()];
    }

    if (lang && Prism.languages[lang]) {
      try {
        const highlighted = Prism.highlight(code, Prism.languages[lang], lang);
        return `<pre class="language-${lang}"><code class="language-${lang}">${highlighted}</code></pre>`;
      } catch (e) {
        console.error('Prism highlighting failed for', lang, ':', e);
        const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<pre class="language-${lang}"><code class="language-${lang}">${escaped}</code></pre>`;
      }
    }
    const escaped = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  }
};

marked.use({ renderer });

/**
 * Parse markdown and replace emotes
 */
export function parseMessage(text: string): string {
  // Preprocess spoiler tags ||text|| before markdown parsing
  // Replace with span that can be clicked to reveal
  text = text.replace(/\|\|(.+?)\|\|/g, '<span class="spoiler" data-spoiler="true">$1</span>');

  // Discord-style code block preprocessing: ensure closing ``` is on its own line
  // Matches: ```lang\ncode``` and converts to: ```lang\ncode\n```
  text = text.replace(/```(\w+)\n([\s\S]*?)```/g, (match, lang, code) => {
    // If code doesn't end with newline, add one before closing backticks
    if (!code.endsWith('\n')) {
      return '```' + lang + '\n' + code + '\n```';
    }
    return match;
  });

  // First, parse markdown - use parseInline for single-line or parse for multi-line
  let html: string;
  try {
    const result = marked.parse(text, { async: false });
    html = typeof result === 'string' ? result : String(result);
  } catch (e) {
    console.error('Markdown parse error:', e);
    html = text; // Fallback to plain text
  }

  // Replace emote codes with images (custom emotes uploaded by users)
  html = html.replace(/:([a-zA-Z0-9_]+):/g, (match, emoteName) => {
    const emote = emotes.get(emoteName);
    if (emote) {
      return `<img src="${emote.url}" alt=":${emoteName}:" class="emote ${emote.type === 'animated' ? 'emote-animated' : ''}" title=":${emoteName}:">`;
    }
    // If not an emote, check if it's an emoji
    const emojiList = get(emojis);
    const emoji = emojiList.find(e => e.name === emoteName);
    if (emoji) {
      return `<img src="${emoji.url}" alt=":${emoji.name}:" class="emoji-inline" title=":${emoji.name}:">`;
    }
    return match; // Return original if neither emote nor emoji found
  });

  // Sanitize HTML to prevent XSS
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'u', 's', 'del', 'code', 'pre',
      'a', 'img', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3',
      'h4', 'h5', 'h6', 'hr', 'span'
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'class', 'title', 'target', 'rel', 'data-spoiler'],
    FORBID_TAGS: ['style', 'script'],
    FORBID_ATTR: ['style', 'onerror', 'onload'],
  });

  return clean;
}

/**
 * Add emote to the store
 */
export function addEmote(emote: {
  name: string;
  url: string;
  type: 'static' | 'animated';
  uploadedBy: string;
  timestamp: number;
}) {
  emotes.set(emote.name, emote);
}

/**
 * Remove emote from the store
 */
export function removeEmote(emoteName: string) {
  emotes.delete(emoteName);
}

/**
 * Get all emotes as array
 */
export function getAllEmotes() {
  return Array.from(emotes.values());
}

/**
 * Initialize emotes from server data
 */
export function initEmotes(serverEmotes: any[]) {
  emotes.clear();
  serverEmotes.forEach(emote => {
    emotes.set(emote.name, emote);
  });
}
