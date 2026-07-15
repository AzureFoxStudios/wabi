export type PortalTarget = HTMLElement | string;

export function portal(node: HTMLElement, target: PortalTarget = document.body) {
	const dest =
		typeof target === 'string'
			? (document.querySelector(target) as HTMLElement | null) ?? document.body
			: target;

	dest.appendChild(node);

	return {
		update(next: PortalTarget = document.body) {
			const nextDest =
				typeof next === 'string'
					? (document.querySelector(next) as HTMLElement | null) ?? document.body
					: next;
			if (nextDest !== node.parentNode) nextDest.appendChild(node);
		},
		destroy() {
			node.parentNode?.removeChild(node);
		}
	};
}
