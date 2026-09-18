/// <reference lib="webworker" />
import { calculate, type WorkbookSnapshot } from './formula';
import { importBook, exportBook } from './fileAdapter';
export type { ImportedCell, ImportedSheet, ImportedWorkbook } from './fileAdapter';

type Operation =
    | { id: number; type: 'calculate'; payload: WorkbookSnapshot }
    | { id: number; type: 'import'; payload: { buffer: ArrayBuffer; name: string; delimiter?: string } }
    | { id: number; type: 'export'; payload: { book: WorkbookSnapshot; format: string; activeId: string } };

self.onmessage = async (event: MessageEvent<Operation>) => {
    const message = event.data;
    try {
        if (message.type === 'calculate') postMessage({ id: message.id, result: calculate(message.payload) });
        else if (message.type === 'import') postMessage({ id: message.id, result: await importBook(message.payload.buffer, message.payload.name, message.payload.delimiter) });
        else if (message.type === 'export') {
            const result = await exportBook(message.payload.book, message.payload.format, message.payload.activeId);
            postMessage({ id: message.id, result }, [result.bytes]);
        } else throw new Error('Unknown spreadsheet operation');
    } catch (error) {
        postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
};
