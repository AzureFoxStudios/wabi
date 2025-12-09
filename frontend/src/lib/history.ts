export interface CallLog {
    id: string;
    username: string;
    type: 'incoming' | 'outgoing';
    status: 'answered' | 'missed' | 'declined' | 'ended';
    startTime: number;
    endTime?: number;
    duration?: number; // in seconds
    isVideo: boolean;
}

const HISTORY_KEY = 'call_history';

export function getCallHistory(): CallLog[] {
    if (typeof window === 'undefined') return [];
    const historyJson = localStorage.getItem(HISTORY_KEY);
    return historyJson ? JSON.parse(historyJson) : [];
}

export function addCallLog(log: Omit<CallLog, 'id'>): CallLog {
    const newLog = { ...log, id: crypto.randomUUID() };
    const history = getCallHistory();
    history.unshift(newLog); // Add to the beginning of the array
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    return newLog;
}

export function updateCallLog(id: string, updates: Partial<CallLog>) {
    const history = getCallHistory();
    const index = history.findIndex(log => log.id === id);
    if (index !== -1) {
        history[index] = { ...history[index], ...updates };
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }
}

export function clearCallHistory() {
    localStorage.removeItem(HISTORY_KEY);
}
