import Prism from 'prismjs';

// prismjs grammar components are classic scripts that mutate the GLOBAL Prism
// object. In the Rollup production build their top-level code can be inlined
// eagerly into shared chunks while the core stays inside a lazy __commonJS
// wrapper — the first bare `Prism.languages...` statement then throws
// "Prism is not defined" at chunk evaluation and kills the whole app-bundle
// dynamic import (Tim 2026-09-02: login succeeded at the transport level but
// the UI never left the Login screen). This module is the ONLY place that may
// touch prismjs: it pins the core instance to the global itself, and loads
// grammars through dynamic imports that cannot run before the pin.
const globalScope = globalThis as unknown as { Prism?: typeof Prism };
if (!globalScope.Prism) {
	globalScope.Prism = Prism;
}

let grammarsPromise: Promise<void> | null = null;

// Loads every grammar component the app uses, sequentially in
// dependency-safe order (javascript before typescript, c before cpp, markup
// before markdown). Sequential matters: parallel dynamic imports evaluate in
// arrival order, and e.g. prism-cpp would extend an undefined 'c' grammar.
// PHP intentionally excluded (tokenizePlaceholders error).
export function ensurePrismGrammars(): Promise<void> {
	grammarsPromise ??= (async () => {
		await import('prismjs/components/prism-javascript');
		await import('prismjs/components/prism-typescript');
		await import('prismjs/components/prism-python');
		await import('prismjs/components/prism-java');
		await import('prismjs/components/prism-c');
		await import('prismjs/components/prism-cpp');
		await import('prismjs/components/prism-csharp');
		await import('prismjs/components/prism-go');
		await import('prismjs/components/prism-rust');
		await import('prismjs/components/prism-ruby');
		await import('prismjs/components/prism-bash');
		await import('prismjs/components/prism-json');
		await import('prismjs/components/prism-css');
		await import('prismjs/components/prism-clike');
		await import('prismjs/components/prism-markup');
		await import('prismjs/components/prism-markdown');
	})();
	return grammarsPromise;
}

export default Prism;
