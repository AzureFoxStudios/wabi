/**
 * The editor header's save state (design contract §7.23): "Saved 09:41". The locality tag beside
 * it already says where the file lives ("Private · this device", "Shared · Editor"), so the
 * status drops the repeated place words and names the time of the last save or sync instead.
 * States that carry their own news ("Offline · changes saved here", "Needs attention") stay
 * as the session words them.
 */
const clock = (at: Date) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at);

/**
 * `where` adds the place to the two settled states, in words that stay visible when the locality
 * tag collapses to a dot: a private file says "this device only", a shared one says where it
 * synced. Without it the status is the bare time.
 */
export function compactStatus(status: string, at: Date, where?: 'device' | 'server'): string {
	if (status === 'Saved on this device') return `Saved ${clock(at)}${where === 'device' ? ' · this device only' : ''}`;
	if (status === 'Synced to this server') return `Synced ${clock(at)}${where === 'server' ? ' · on this server' : ''}`;
	if (status === 'Saving on this device…') return 'Saving…';
	if (status === 'Loading') return 'Opening…';
	return status;
}
