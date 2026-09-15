type VisibilityCallback = (visible: boolean) => void;

const callbacks = new Map<Element, Set<VisibilityCallback>>();
let observer: IntersectionObserver | null = null;

function getObserver(): IntersectionObserver | null {
	if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return null;
	if (observer) return observer;

	observer = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				const listeners = callbacks.get(entry.target);
				if (!listeners) continue;
				const visible = entry.isIntersecting || entry.intersectionRatio > 0;
				for (const listener of listeners) listener(visible);
			}
		},
		{
			// Start just before a message enters the viewport so the translation
			// can arrive without sending requests for the whole rendered history.
			root: null,
			rootMargin: '180px 0px',
			threshold: 0.01
		}
	);
	return observer;
}

export function observeTranslatorVisibility(
	element: Element,
	callback: VisibilityCallback
): () => void {
	let listeners = callbacks.get(element);
	if (!listeners) {
		listeners = new Set();
		callbacks.set(element, listeners);
		const sharedObserver = getObserver();
		if (sharedObserver) sharedObserver.observe(element);
		else callback(true);
	}
	listeners.add(callback);

	return () => {
		const current = callbacks.get(element);
		if (!current) return;
		current.delete(callback);
		if (current.size > 0) return;
		callbacks.delete(element);
		observer?.unobserve(element);
	};
}
