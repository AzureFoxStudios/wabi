import { describe, expect, test } from 'bun:test';
import { CREATOR_PRESETS, DEFAULT_NAME_DESIGN, normalizeNameDesign, nameDesignPlateStyle, parseProfileDesignFile, serializeProfileDesignFile, type EditableUsernameFont } from './profileDesign';
import { PROFILE_ART_EXAMPLES } from './profileArtExamples';

const fileFor = (usernameFont: unknown, patch: Record<string, unknown> = {}) => JSON.stringify({ format: 'wabi-profile-design', version: 1, title: 'A shared design', usernameFont, ...patch });
const font: EditableUsernameFont = { family: 'Georgia', size: '1.2em', weight: '700', style: 'italic', preset: 'none', design: { ...DEFAULT_NAME_DESIGN, effect: 'shimmer', glow: 4, plate: 'gradient' } };

describe('portable profile designs', () => {
 test('downloadable example files import the same name and plate shown in the artist guide', async () => {
  for (const example of PROFILE_ART_EXAMPLES) {
   const file = Bun.file(new URL('../../static' + example.nameFile, import.meta.url));
   expect(file.size).toBeLessThanOrEqual(16 * 1024);
   expect(parseProfileDesignFile(await file.text())).toEqual({ title: example.title, usernameFont: example.usernameFont });
  }
 });
 test('round trips editable values while stripping account, media and executable extras', () => {
  const source = { ...font, dbUserId: 991, username: 'Private account', bannerUrl: 'https://private.example/banner.gif', callback: 'alert(1)', assets: ['private.png'], design: { ...font.design!, customCss: 'background:url(https://tracking.example)', profilePicture: 'private.png' } } as EditableUsernameFont;
  const serialized = serializeProfileDesignFile('  Aurora remix  ', source);
  const payload = JSON.parse(serialized);
  expect(Object.keys(payload).sort()).toEqual(['format', 'title', 'usernameFont', 'version']);
  expect(payload.usernameFont).toEqual(font);
  expect(parseProfileDesignFile(serialized)).toEqual({ title: 'Aurora remix', usernameFont: font });
  for (const privateValue of ['991', 'Private account', 'private.example', 'alert(1)', 'tracking.example', 'private.png']) expect(serialized).not.toContain(privateValue);
 });
 test('bundled starting designs are valid and survive export/import', () => {
  for (const preset of CREATOR_PRESETS) {
   expect(normalizeNameDesign(preset.design)).toEqual(preset.design);
   expect(parseProfileDesignFile(serializeProfileDesignFile(preset.label, { design: preset.design })).usernameFont.design).toEqual(preset.design);
  }
 });
 test('legacy typography and preset files stay portable without gaining a custom design', () => {
  const legacy = { family: 'Comic Sans MS', size: '0.9em', weight: '400', style: 'normal', preset: 'ocean' };
  expect(parseProfileDesignFile(serializeProfileDesignFile('Legacy', legacy)).usernameFont).toEqual(legacy);
 });
 test('malformed files, unsupported versions and missing styles are rejected', () => {
  for (const raw of ['{broken', 'null', '[]', '42', '{}', fileFor(font, { version: 2 }), fileFor(font, { version: '1' }), fileFor(font, { format: 'another-app' }), fileFor({}), fileFor(null)]) expect(() => parseProfileDesignFile(raw)).toThrow();
 });
 test('16 KiB limit counts encoded bytes, including multibyte metadata', () => {
  expect(() => parseProfileDesignFile(fileFor(font, { ignored: 'x'.repeat(16 * 1024) }))).toThrow(/16 KiB/);
  expect(() => parseProfileDesignFile(fileFor(font, { ignored: '🌈'.repeat(5000) }))).toThrow(/16 KiB/);
 });
 test('import rejects CSS injection through colors and typography', () => {
  for (const key of ['color', 'color2', 'plateColor', 'plateColor2']) for (const value of ['#fff', 'red', '#abcdef; background:url(https://tracking.example)', 'url(javascript:alert(1))']) expect(() => parseProfileDesignFile(fileFor({ design: { ...DEFAULT_NAME_DESIGN, [key]: value } }))).toThrow();
  for (const key of ['family', 'size', 'weight', 'style', 'preset']) expect(() => parseProfileDesignFile(fileFor({ ...font, [key]: 'inherit; background:url(https://tracking.example)' }))).toThrow();
 });
 test('numeric controls reject out of range, nonnumeric and nonfinite values', () => {
  const invalid: Record<string, unknown[]> = { angle: [-1, 361, '95', NaN, Infinity], glow: [-1, 13, '4', NaN, Infinity], animationSeconds: [3.9, 20.1, '8', NaN, Infinity], plateOpacity: [-0.01, 1.01, '0.5', NaN, Infinity] };
  for (const [key, values] of Object.entries(invalid)) for (const value of values) {
   expect(normalizeNameDesign({ ...DEFAULT_NAME_DESIGN, [key]: value })).toBeNull();
   expect(() => parseProfileDesignFile(fileFor({ design: { ...DEFAULT_NAME_DESIGN, [key]: value } }))).toThrow();
  }
  for (const boundary of [{ angle: 0, glow: 0, animationSeconds: 4, plateOpacity: 0 }, { angle: 360, glow: 12, animationSeconds: 20, plateOpacity: 1 }]) expect(normalizeNameDesign({ ...DEFAULT_NAME_DESIGN, ...boundary })).not.toBeNull();
 });
 test('unknown or malformed stored designs normalize to plain rendering', () => {
  for (const invalid of [null, false, 'gradient', [], {}, { ...DEFAULT_NAME_DESIGN, effect: 'fireworks' }, { ...DEFAULT_NAME_DESIGN, plate: 'remote-image' }, { ...DEFAULT_NAME_DESIGN, color: 'var(--injected)' }]) {
   const normalized = normalizeNameDesign(invalid); expect(normalized).toBeNull(); expect(nameDesignPlateStyle(normalized)).toBe('');
  }
 });
 test('effect and plate enums must be strings, not coercible JSON arrays', () => {
  for (const invalid of [{ ...DEFAULT_NAME_DESIGN, effect: ['gradient'] }, { ...DEFAULT_NAME_DESIGN, plate: ['gradient'] }]) {
   expect(normalizeNameDesign(invalid)).toBeNull(); expect(() => parseProfileDesignFile(fileFor({ design: invalid }))).toThrow();
  }
 });
});
