/** No auth credentials are accepted in an address. Invitation secrets stay in
 * fragments (not server logs/referrers) and are redeemed only on registration. */
export interface JoinInvitation { server: string; token: string; }
export function invitationServer(value: string): string {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Use the server origin only, without credentials, paths, queries or fragments.');
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(url.hostname);
    const lan = !!match && (Number(match[1]) === 10 || (Number(match[1]) === 192 && Number(match[2]) === 168) || (Number(match[1]) === 172 && Number(match[2]) >= 16 && Number(match[2]) <= 31));
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || lan))) {
        throw new Error('Internet invitations require HTTPS. Plain HTTP is only for localhost or a trusted private LAN.');
    }
    return url.origin;
}
export function makeInvitation(server: string, token: string): string {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid invitation credential.');
    const origin = invitationServer(server);
    const host = new URL(origin).hostname;
    if (['localhost', '127.0.0.1', '[::1]'].includes(host)) {
        throw new Error('A localhost link points to the recipient’s computer, not yours. Use a LAN address or a reachable HTTPS address.');
    }
    return `${origin}/join#invite=${token}`;
}
export function parseInvitation(value: string): JoinInvitation {
    if (value.length > 4096) throw new Error('Invitation is too long.');
    const url = new URL(value.trim());
    if (url.pathname !== '/join' || url.search) throw new Error('Use the complete Wabi /join invitation.');
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('invite') || '';
    if (Array.from(params).length !== 1 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('The invitation is missing or invalid.');
    const clean = new URL(url.origin);
    return { server: invitationServer(clean.href), token };
}
