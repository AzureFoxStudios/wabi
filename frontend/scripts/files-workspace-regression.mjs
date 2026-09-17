#!/usr/bin/env node
// GF07 Files regression: static wiring guards (no browser, no network).
// Fails if the workspace regresses to snapshot reads, destination-keyed jobs,
// auto-pruned failures, or missing retry/ownership affordances.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const component = readFileSync(path.join(root, '../src/lib/components/FilesWorkspace.svelte'), 'utf8');
const session = readFileSync(path.join(root, '../src/lib/filesWorkspaceSession.ts'), 'utf8');

const failures = [];
function check(name, ok, hint = '') {
	if (!ok) failures.push(`${name}${hint ? ` — ${hint}` : ''}`);
}

check('reactive channel subscription', component.includes('currentChannel.subscribe') && component.includes('channels.subscribe'));
check('no derived(get()) snapshots', !component.includes('$derived(get(currentChannel))') && !component.includes('$derived(get(channels))'));
check('session ownership', component.includes('createFilesWorkspaceSession') && session.includes('sessionAlive'));
check('preview close invalidates pending', session.includes('closePreview') && session.includes('previewSeq'));
check('object URL revocation', session.includes('revokeObjectUrl') && session.includes('revokeActivePreviewUrl'));
check('unique upload job ids', session.includes('createUploadJobId') && component.includes('(job.id)'));
check('no destination-keyed jobs', !component.includes('(job.dest)'));
check('no auto-prune timer', !session.includes('setTimeout') || !session.includes('uploadJobs = uploadJobs.filter'));
check('explicit retry/dismiss', component.includes('session.retryUpload') && component.includes('session.dismissUpload'));
check('conflict without overwrite', session.includes('conflict') && session.includes('kept the server copy'));
check('mirror read-only respected', component.includes('readOnly: isMirror') && session.includes("readOnly"));
check('partial search warning', session.includes('Partial results') && component.includes('globalSearchWarning'));
check('spaces/files/search retry affordances', component.includes('reloadSpaces') && component.includes('reloadFiles') && component.includes('retrySearch'));

if (failures.length > 0) {
	console.error('files-workspace regression FAILED:');
	for (const failure of failures) console.error(` - ${failure}`);
	process.exit(1);
}
console.log('files-workspace regression OK');
