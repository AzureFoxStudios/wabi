import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';

// Local visual acceptance harness; synthetic identities/media never run in releases.
export function load() {
 if (!dev) error(404, 'Not found');
}
