const fs = require('fs');
const content = fs.readFileSync('socket.ts', 'utf-8');

// Add isSpoiler to Message interface (first occurrence of replyTo)
let modified = content.replace(
  /(export interface Message \{[^}]+replyTo\?: string;)/,
  '$1\n\tisSpoiler?: boolean; // Mark media as spoiler (requires click to reveal)'
);

// Add isSpoiler to sendMessage options (second occurrence in function params)
modified = modified.replace(
  /(export function sendMessage[^{]+replyTo\?: string;)/,
  '$1\n\tisSpoiler?: boolean;'
);

fs.writeFileSync('socket.ts', modified);
console.log('File updated successfully');
