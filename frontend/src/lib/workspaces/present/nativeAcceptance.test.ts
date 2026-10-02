import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { initialize, collection, addSlide, readSlides, audienceSlides, validateNative } from './model';
import { setDesign, presetDesign, readDesign } from './nativeScene';
import { prepareEdition, verifyEdition } from './versionPreview';
import { objectAnchor, describeAnchor, linkAnchor, parseAnchor } from '../anchors';
import { addDesignToPptx } from './sceneExport';

function deck() {
    const doc = new Y.Doc(), root = doc.getMap('data');
    initialize(root, 'Public title');
    const id = readSlides(root)[0].id;
    setDesign(root, id, presetDesign('comparison', 'Public title', 'Public left'));
    return { doc, root, id };
}

test('canvas audience projection excludes unused legacy text, hidden slides and removed objects', () => {
    const { doc, root, id } = deck();
    const slide = collection(root).get(id)!;
    slide.set('body', new Y.Text('PRIVATE_UNUSED_LEGACY_TEXT'));
    const design = slide.get('design') as Y.Map<unknown>;
    const objects = design.get('objects') as Y.Map<Y.Map<unknown>>;
    const removed = objects.get(readDesign(root, id)!.objects[2].id)!;
    removed.set('text', new Y.Text('PRIVATE_REMOVED_OBJECT')); removed.set('removed', true);
    addSlide(root, { title: 'PRIVATE_HIDDEN_SLIDE', body: 'Hidden', hidden: true });
    const output = audienceSlides(root);
    expect(output).toHaveLength(1);
    expect(output[0].design?.objects).toHaveLength(2);
    expect(JSON.stringify(output)).not.toContain('PRIVATE_');
    expect(output[0].body).toBe('');
    validateNative(root); doc.destroy();
});

test('duplicating a native slide assigns new object identities without losing public layout', () => {
    const { doc, root, id } = deck();
    const source = readSlides(root)[0], duplicate = addSlide(root, source, id);
    const before = readDesign(root, id)!, after = readDesign(root, duplicate)!;
    expect(after.theme).toBe(before.theme);
    expect(after.objects.map(object => object.text)).toEqual(before.objects.map(object => object.text));
    expect(after.objects.every(object => !before.objects.some(original => original.id === object.id))).toBe(true);
    doc.destroy();
});

test('changing a native object after audience preview invalidates the approval', () => {
    const { doc, root, id } = deck();
    const approved = prepareEdition(audienceSlides(root), 16 / 9, id);
    const design = collection(root).get(id)!.get('design') as Y.Map<unknown>;
    const objects = design.get('objects') as Y.Map<Y.Map<unknown>>;
    const object = objects.get(readDesign(root, id)!.objects[1].id)!;
    (object.get('text') as Y.Text).insert(0, 'UNAPPROVED ');
    expect(() => verifyEdition(approved, audienceSlides(root), 16 / 9, id)).toThrow('changed after');
    expect(JSON.stringify(approved)).not.toContain('UNAPPROVED');
    doc.destroy();
});

test('object references contain stable identities and become missing instead of jumping to another object', () => {
    const { doc, root, id } = deck(), objectId = readDesign(root, id)!.objects[1].id;
    const anchor = objectAnchor(id, objectId, 'PRIVATE_LABEL');
    expect(parseAnchor(anchor)?.kind).toBe('object');
    expect(describeAnchor(doc, anchor).missing).toBe(false);
    expect(linkAnchor(anchor)).not.toContain('PRIVATE_LABEL');
    const objects = (collection(root).get(id)!.get('design') as Y.Map<unknown>).get('objects') as Y.Map<Y.Map<unknown>>;
    objects.get(objectId)!.set('removed', true);
    expect(describeAnchor(doc, anchor).missing).toBe(true);
    doc.destroy();
});

test('native PPTX charts export only pinned values and shapes, without embedded workbooks or notes', async () => {
    const pptx = new PptxGenJS(); pptx.layout = 'LAYOUT_WIDE';
    const design = presetDesign('chart', 'Pinned public chart', '');
    await addDesignToPptx(pptx, pptx.addSlide(), design, 10, 5.625);
    const bytes = await pptx.write({ outputType: 'nodebuffer' });
    const zip = await JSZip.loadAsync(bytes);
    const names = Object.keys(zip.files);
    expect(names.some(name => name.startsWith('ppt/embeddings/') && !zip.files[name].dir)).toBe(false);
    const slide = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(slide).toContain('Pinned public chart'); expect(slide).toContain('First');
    expect(slide).not.toContain('PRIVATE_');
    for (const name of names.filter(name => name.endsWith('.xml'))) {
        expect(await zip.file(name)!.async('string')).not.toContain('PRIVATE_');
    }
});
