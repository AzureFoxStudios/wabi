/**
 * What dragging the fill handle writes, as pure rules over one column or row of cell inputs.
 *
 * `source` is the selected cells in order (top to bottom, or left to right). The result is the next
 * `count` cells beyond them. Following Excel's AutoFill:
 *  - two or more plain numbers continue the series by their step (1, 2 gives 3, 4, 5);
 *  - a single number, or anything else, is copied;
 *  - a single text ending in a number counts up ("Item 1" gives "Item 2");
 *  - a block of several cells repeats in order.
 * A formula is copied as a formula: `shift` says how far it has moved from the cell it came from, so
 * the caller can move its relative references with `shiftFormulaText`.
 */
export interface FilledCell { input: string; shift: number }

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function clean(value: number): string {
	// 0.1 + 0.2 must read 0.3, not 0.30000000000000004.
	return String(Number(value.toFixed(10)));
}

export function fillValues(source: string[], count: number): FilledCell[] {
	const k = source.length;
	if (k === 0 || count <= 0) return [];
	const trimmed = source.map((input) => input.trim());
	if (k >= 2 && trimmed.every((input) => NUMBER.test(input))) {
		const numbers = trimmed.map(Number);
		const step = (numbers[k - 1] - numbers[0]) / (k - 1);
		return Array.from({ length: count }, (_, i) => ({ input: clean(numbers[k - 1] + step * (i + 1)), shift: 0 }));
	}
	if (k === 1 && !source[0].startsWith('=') && !NUMBER.test(trimmed[0])) {
		const counted = /^(.*?)(\d+)$/.exec(source[0]);
		if (counted) {
			const width = counted[2].length;
			const first = Number(counted[2]);
			// Keep leading zeros ("A007" gives "A008") by padding back to the original width.
			return Array.from({ length: count }, (_, i) => ({ input: counted[1] + String(first + i + 1).padStart(width, '0'), shift: 0 }));
		}
	}
	return Array.from({ length: count }, (_, i) => {
		const position = k + i;
		return { input: source[position % k], shift: position - (position % k) };
	});
}
