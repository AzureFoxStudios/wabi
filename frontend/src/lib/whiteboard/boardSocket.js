import { getSocket } from '$lib/socket-manager';
export function joinWhiteboardChannel(channelId) {
    const socket = getSocket();
    if (!socket || !channelId.trim())
        return;
    socket.emit('whiteboard:join', { channelId: channelId.trim() });
}
export function leaveWhiteboard(boardId) {
    const socket = getSocket();
    if (!socket || !boardId.trim())
        return;
    socket.emit('whiteboard:leave', { boardId: boardId.trim() });
}
export function saveWhiteboardSnapshot(boardId, document) {
    const socket = getSocket();
    if (!socket || !boardId.trim())
        return;
    socket.emit('whiteboard:snapshot', { boardId: boardId.trim(), document });
}
export function sendWhiteboardPatch(boardId, patch) {
    const socket = getSocket();
    if (!socket || !boardId.trim())
        return;
    socket.emit('whiteboard:patch', { boardId: boardId.trim(), patch });
}
export function sendWhiteboardCursor(boardId, cursor) {
    const socket = getSocket();
    if (!socket || !boardId.trim())
        return;
    socket.emit('whiteboard:cursor', { boardId: boardId.trim(), cursor });
}
export function subscribeWhiteboardEvents(handlers) {
    const socket = getSocket();
    if (!socket)
        return () => { };
    const listeners = [];
    const addListener = (event, handler) => {
        if (!handler)
            return;
        const listener = (payload) => {
            handler(payload);
        };
        listeners.push([event, listener]);
        socket.on(event, listener);
    };
    addListener('whiteboard:snapshot', handlers.onSnapshot);
    addListener('whiteboard:presence', handlers.onPresence);
    addListener('whiteboard:patch', handlers.onPatch);
    addListener('whiteboard:cursor', handlers.onCursor);
    addListener('whiteboard:error', handlers.onError);
    return () => {
        for (const [event, listener] of listeners) {
            socket.off(event, listener);
        }
    };
}
