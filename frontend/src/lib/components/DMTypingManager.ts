// Typing timeout manager for DM/message views
let typingTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Handle typing indicator logic on input
 * @param channelId - The current channel ID
 * @param sendTyping - Function to send typing indicator to server
 */
export function handleTypingInput(channelId: string, sendTyping: (isTyping: boolean, channelId: string) => void): void {
  // Clear existing timeout if any
  if (typingTimeout) {
    clearTimeout(typingTimeout);
  }
  
  // Set new timeout to stop typing after 2 seconds of inactivity
  const newTimeout = setTimeout(() => {
    sendTyping(false, channelId);
    typingTimeout = null;
  }, 2000);
  
  typingTimeout = newTimeout;
  
  // Indicate typing started
  sendTyping(true, channelId);
}

/**
 * Stop typing indicator immediately
 * @param sendTyping - Function to send typing indicator to server
 */
export function stopTyping(sendTyping: (isTyping: boolean, channelId: string) => void): void {
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
  sendTyping(false, '');
}

/**
 * Reset typing timeout (used when sending a message or handling commands)
 * @param sendTyping - Function to send typing indicator to server
 */
export function resetTyping(sendTyping: (isTyping: boolean, channelId: string) => void): void {
  stopTyping(sendTyping);
}