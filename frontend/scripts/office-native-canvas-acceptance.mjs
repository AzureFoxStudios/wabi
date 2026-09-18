import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

export async function nativeCanvasAcceptance(page, audience, accounts, artifacts, engineName) {
    let checks = 0;
    const before = await page.evaluate(() => window.workspaceTest.records('present'));
    await page.getByRole('button', { name: 'New presentation', exact: true }).click();
    await page.getByLabel('Slide title', { exact: true }).fill('Canvas regression');
    await page.getByLabel('Slide text', { exact: true }).fill('Public copied text');
    await page.getByLabel('Native slide preset', { exact: true }).selectOption('comparison');
    await page.getByRole('button', { name: 'Apply native layout', exact: true }).click();
    await page.locator('.designer-stage .scene').waitFor();
    const records = await page.evaluate(() => window.workspaceTest.records('present'));
    const record = records.find(item => !before.some(old => old.id === item.id));
    assert(record, 'A distinct local native deck must have been created'); checks++;

    await page.getByRole('button', { name: 'Add text', exact: true }).click();
    await page.getByLabel('Object text or data', { exact: true }).fill('NATIVE_CANVAS_PERSISTED_TEXT');
    await page.locator('.object-handle.chosen').press('ArrowRight');
    await page.getByLabel('Slide theme', { exact: true }).selectOption('night');
    await page.getByRole('button', { name: 'Add chart', exact: true }).click();
    await page.getByLabel('Object text or data', { exact: true }).fill('Public first\t12\nPublic second\t-4');
    await page.getByLabel('Private speaker notes', { exact: true }).fill('PRIVATE_NATIVE_NOTES');
    await page.waitForFunction(async id => {
        const record = await window.workspaceTest.record(id);
        return Object.values(record?.data?.slides || {}).some(slide => {
            const objects = Object.values(slide.design?.objects || {});
            return slide.layout === 'canvas' && slide.design?.theme === 'night' &&
                objects.some(object => object.text === 'NATIVE_CANVAS_PERSISTED_TEXT' && object.x > 0.1) &&
                objects.some(object => object.kind === 'chart' && object.text === 'Public first\t12\nPublic second\t-4');
        });
    }, record.id); checks++;
    const saved = await page.evaluate(id => window.workspaceTest.record(id), record.id);
    assert(!saved.meta, 'Creating a native deck must not implicitly publish it');
    assert(!JSON.stringify(saved.data).includes('PRIVATE_NATIVE_NOTES')); checks++;

    const stage = await page.locator('.designer-stage').boundingBox();
    for (const handle of await page.locator('.object-handle').all()) {
        const box = await handle.boundingBox();
        assert(box && stage && box.x >= stage.x - 1 && box.y >= stage.y - 1 && box.x + box.width <= stage.x + stage.width + 1 && box.y + box.height <= stage.y + stage.height + 1, 'Object selection handles must align with the actual audience canvas');
    }
    checks++;
    await page.screenshot({ path: path.join(artifacts, `${engineName}-native-canvas.png`) });
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export PPTX subset', exact: true }).click();
    const download = await downloading;
    const output = path.join(artifacts, `${engineName}-native-canvas.pptx`);
    await download.saveAs(output);
    const zip = await JSZip.loadAsync(await readFile(output));
    const names = Object.keys(zip.files);
    assert(!names.some(name => name.startsWith('ppt/embeddings/') && !zip.files[name].dir), 'Pinned charts must not include an embedded private workbook');
    const slide = await zip.file('ppt/slides/slide1.xml').async('string');
    assert(slide.includes('NATIVE_CANVAS_PERSISTED_TEXT'));
    assert(slide.includes('Public first'));
    for (const name of names.filter(name => name.endsWith('.xml'))) assert(!(await zip.file(name).async('string')).includes('PRIVATE_NATIVE_NOTES'));
    checks++;

    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await page.evaluate(id => window.workspaceTest.open('present', { id }), record.id);
    await page.locator('.designer-stage .scene').waitFor();
    await page.getByText('NATIVE_CANVAS_PERSISTED_TEXT', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Private speaker notes', { exact: true }).inputValue(), 'PRIVATE_NATIVE_NOTES');
    const reopened = await page.evaluate(id => window.workspaceTest.record(id), record.id);
    assert.deepEqual(reopened.data, saved.data, 'Reopening must preserve stable identities, text, positions and pinned chart values'); checks++;

    await page.getByRole('button', { name: 'Share…', exact: true }).click();
    await page.getByLabel('Person', { exact: true }).selectOption(String(accounts[1].id));
    await page.getByLabel('Recipient permission', { exact: true }).selectOption('viewer');
    await page.getByRole('button', { name: 'Add person', exact: true }).click();
    await page.getByRole('button', { name: 'Publish and save sharing', exact: true }).click();
    await page.locator('dialog[open]').waitFor({ state: 'hidden' });
    const starting = page.waitForResponse(response => response.url().endsWith('/api/workspace/presentations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Present to channel…', exact: true }).click();
    await page.getByRole('button', { name: 'Start approved presentation', exact: true }).click();
    const response = await starting, room = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(room));
    assert.equal(room.slides.length, 1); assert.equal(room.slides[0].layout, 'canvas');
    assert(room.slides[0].design.objects.some(object => object.text === 'NATIVE_CANVAS_PERSISTED_TEXT'));
    assert.equal(room.slides[0].body, ''); assert.equal(room.slides[0].image, null);
    assert(!JSON.stringify(room).includes('PRIVATE_NATIVE_NOTES')); checks++;
    await audience.evaluate(id => window.workspaceTest.open('audience', { sessionId: id }), room.id);
    await audience.getByText('NATIVE_CANVAS_PERSISTED_TEXT', { exact: true }).waitFor();
    assert.equal(await audience.getByRole('button', { name: 'Add text', exact: true }).count(), 0);
    assert(!(await audience.locator('body').innerText()).includes('PRIVATE_NATIVE_NOTES')); checks++;
    await audience.screenshot({ path: path.join(artifacts, `${engineName}-native-audience.png`) });
    await page.getByRole('button', { name: 'End presentation', exact: true }).click();
    await page.waitForFunction(() => document.body.textContent.includes('Ended'));
    await page.evaluate(id => window.workspaceTest.open('present', { id }), record.id);
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    return checks;
}
