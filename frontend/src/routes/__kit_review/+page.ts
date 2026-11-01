import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';

// Local specimen of the control, overlay and prose kits (design contract §7); never in releases.
export function load() {
	if (!dev) error(404, 'Not found');
}
