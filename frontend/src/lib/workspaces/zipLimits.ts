// Shared by every Office import (documents, sheets, slides). It lives outside the
// sheets and present folders so a build without those add-ons can still open .docx.

const MB = 1024 * 1024;

/** Validate the central directory before the format adapter allocates expanded data. */
export function zipLimits(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    let end = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
        if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === buffer.byteLength) { end = i; break; }
    }
    if (end < 0) throw new Error('Invalid or unsupported Office archive.');
    const count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), directorySize = view.getUint32(end + 12, true);
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || !count || count > 4096 || offset + directorySize !== end) throw new Error('Multipart, ZIP64, or invalid Office archive directory.');
    let at = offset, total = 0;
    const names = new Set<string>();
    for (let i = 0; i < count; i++) {
        if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('Invalid Office archive directory.');
        const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true), compressed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
        const nameSize = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true), local = view.getUint32(at + 42, true);
        const next = at + 46 + nameSize + extra + comment;
        if (next > end || flags & 1 || ![0, 8].includes(method) || size === 0xffffffff || size > 24 * MB || size > Math.max(1, compressed) * 250 || local + 30 > offset) throw new Error('Encrypted or over-expanded Office archive is not supported.');
        const name = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameSize));
        if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) throw new Error('Unsafe or duplicate Office archive entry.');
        names.add(name);
        if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method) throw new Error('Office archive headers disagree.');
        const localNameSize = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
        if (local + 30 + localNameSize + localExtra + compressed > offset || localNameSize !== nameSize || new TextDecoder().decode(new Uint8Array(buffer, local + 30, localNameSize)) !== name) throw new Error('Invalid Office archive entry bounds.');
        if (!(flags & 8) && (view.getUint32(local + 18, true) !== compressed || view.getUint32(local + 22, true) !== size)) throw new Error('Office archive sizes disagree.');
        total += size;
        if (total > 64 * MB) throw new Error('Office archive expands beyond the safe import limit.');
        at = next;
    }
    if (at !== end) throw new Error('Invalid Office archive directory size.');
}
