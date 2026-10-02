import { expect, test } from 'bun:test';
import { publicDesign } from '../scene';
import { presetDesign } from './nativeScene';

test('unfinalized image crops cannot be published as audience data', () => {
    const design = presetDesign('caption', 'Title', 'Caption');
    const image = design.objects.find(object => object.kind === 'image')!;
    image.image = 'data:image/png;base64,aGVsbG8=';
    image.fit = 'cover';
    expect(() => publicDesign(design)).toThrow('Finalize');
    image.fit = 'contain';
    expect(publicDesign(design).objects.find(object => object.kind === 'image')?.fit).toBe('contain');
});
