import { expect, test } from 'bun:test';
import * as Y from 'yjs';
import { initialize, collection, readSlides, addSlide, moveSlide } from './model';
import { setDesign, presetDesign, readDesign } from './nativeScene';
import { slideAnchor, objectAnchor } from '../anchors';
import { resolveSlideSelection } from './selection';

test('slide and object links resolve after slide reorder without positional guessing', () => {
    const doc = new Y.Doc(), root = doc.getMap('data'); initialize(root);
    const first = readSlides(root)[0].id;
    const second = addSlide(root, { title: 'Target' }, first);
    setDesign(root, second, presetDesign('body', 'Target', 'Original'));
    const object = readDesign(root, second)!.objects[1].id;
    moveSlide(root, second, -1);
    expect(resolveSlideSelection(root, slideAnchor(second, 'Target'))).toEqual({ slideId: second, objectId: null });
    expect(resolveSlideSelection(root, objectAnchor(second, object, 'Text'))).toEqual({ slideId: second, objectId: object });
    const design = collection(root).get(second)!.get('design') as Y.Map<unknown>;
    const objects = design.get('objects') as Y.Map<Y.Map<unknown>>;
    objects.get(object)!.set('removed', true);
    expect(() => resolveSlideSelection(root, objectAnchor(second, object, 'Text'))).toThrow('object was removed');
    collection(root).get(second)!.set('removed', true);
    expect(() => resolveSlideSelection(root, slideAnchor(second, 'Target'))).toThrow('slide was removed');
    expect(resolveSlideSelection(root)).toBeNull();
    doc.destroy();
});
