/**
 * Removes HTML tags until none remain. A single pass can leave a new tag
 * behind when tags are nested inside each other, e.g. `<scr<b>ipt>`.
 */
export function stripHtmlTags(text: string): string {
	let previous: string;
	do {
		previous = text;
		text = text.replace(/<[^>]*>/g, '');
	} while (text !== previous);
	return text;
}
