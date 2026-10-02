export type VapidKeyResult = { ok: true; publicKey: string } | { ok: false; reason: string };
type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export async function fetchVapidKeyResult(url: string, fetcher: Fetcher = fetch): Promise<VapidKeyResult> {
    let response: Response;
    try { response = await fetcher(url, { credentials: 'same-origin' }); }
    catch { return { ok: false, reason: 'vapid_network_error' }; }
    if (!response.ok) return { ok: false, reason: `vapid_http_${response.status}` };
    let payload: unknown;
    try { payload = await response.json(); }
    catch { return { ok: false, reason: 'vapid_invalid_response' }; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'vapid_invalid_response' };
    const publicKey = (payload as { publicKey?: unknown }).publicKey;
    if (publicKey === undefined || publicKey === null || publicKey === '') return { ok: false, reason: 'no_vapid_key' };
    if (typeof publicKey !== 'string' || publicKey.length !== 87 || !/^[A-Za-z0-9_-]+$/.test(publicKey)) return { ok: false, reason: 'vapid_invalid_key' };
    try {
        const padded = publicKey.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - publicKey.length % 4) % 4);
        const decoded = atob(padded);
        if (decoded.length !== 65 || decoded.charCodeAt(0) !== 4) return { ok: false, reason: 'vapid_invalid_key' };
    } catch { return { ok: false, reason: 'vapid_invalid_key' }; }
    return { ok: true, publicKey };
}

export function pushFailureMessage(reason: string): string {
    const messages: Record<string, string> = {
        vapid_network_error: 'Could not reach this server’s push setup. Check the connection and try again.',
        vapid_invalid_response: 'This server returned an unexpected push setup response. Its operator needs to check the endpoint.',
        vapid_invalid_key: 'This server returned an invalid push public key. Its operator needs to check push setup.',
        no_vapid_key: 'This server has not provided a push public key. Its operator needs to enable push delivery.',
        not_authenticated: 'Sign in before enabling push.',
        account_changed: 'The account or server changed. Enable push again for the current account.',
        insecure_context: 'Push requires a secure connection. Open this server using HTTPS.',
        push_unsupported: 'Push is unavailable here. On iPhone or iPad, add Wabi to the Home Screen and open it there.',
        notification_unsupported: 'This browser does not support notifications here.',
        permission_denied: 'Notifications are blocked. Allow them in this device’s browser or app settings.',
        browser_subscription_denied: 'The browser refused push registration. Check notification permission and, on iOS, use the Home Screen app.',
        browser_subscription_conflict: 'This device’s push registration uses a different server key. Disable push here, then enable it again.',
        browser_subscription_failed: 'The browser could not register push. Try again after checking the connection.',
        subscription_network_error: 'The device registered with its push service, but Wabi could not save the subscription. Try enabling push again.'
    };
    if (/^vapid_http_\d{3}$/.test(reason)) return `This server’s push setup request failed (HTTP ${reason.slice(-3)}). Its operator needs to check access to the endpoint.`;
    if (/^subscription_http_\d{3}$/.test(reason)) return `Wabi could not save the push subscription (HTTP ${reason.slice(-3)}). Try signing in again.`;
    return Object.hasOwn(messages, reason) ? messages[reason] : 'Push setup failed. Try again or ask this server’s operator to check push delivery.';
}
