// Unit tests for the pure parts of the importer (the DOM/canvas paths are covered by the browser e2e test,
// see docs in src/import/__fixtures__/makeFixturePsd.ts and the task report).
import { describe, expect, it } from 'vitest';
import { ACCEPTED_FILES, importKindOf } from '../index';
import { colorToRgb } from '../psd';
import { cleanCss } from '../svg';
import {
  fontFamilyOnly,
  isBrandTextColour,
  isCondensedStretch,
  mapFont,
  nearestCore,
  nearestToken,
  ALL_TOKENS,
  parseWeight,
  prettyFontName,
  snapTextColour,
  weightFromName,
  type RGB,
} from '../util';

const NAVY: RGB = [0, 8, 86];
const WHITE: RGB = [255, 255, 255];

describe('font names', () => {
  it('reads weights from PostScript names', () => {
    expect(weightFromName('National2Condensed-Bold')).toBe(700);
    expect(weightFromName('Inter-SemiBold')).toBe(600);
    expect(weightFromName('Inter-ExtraBold')).toBe(800);
    expect(weightFromName('Helvetica-Light')).toBe(300);
    expect(weightFromName('Inter-ExtraLight')).toBe(200);
    expect(weightFromName('Brand-Black')).toBe(900);
    expect(weightFromName('ArialMT')).toBeUndefined();
  });
  it('prettifies names for notes', () => {
    expect(prettyFontName('National2Condensed-Bold')).toBe('National 2 Condensed Bold');
    expect(prettyFontName('"Inter", Arial, sans-serif')).toBe('Inter');
    expect(prettyFontName('ArialMT')).toBe('Arial');
    expect(fontFamilyOnly('National2Condensed-Bold')).toBe('National 2 Condensed');
    expect(fontFamilyOnly("'National 2 Condensed', 'Arial Narrow'")).toBe('National 2 Condensed');
  });
  it('parses CSS weights and stretches', () => {
    expect(parseWeight('700')).toBe(700);
    expect(parseWeight('bold')).toBe(700);
    expect(parseWeight('normal')).toBe(400);
    expect(isCondensedStretch('75%')).toBe(true);
    expect(isCondensedStretch('condensed')).toBe(true);
    expect(isCondensedStretch('100%')).toBe(false);
  });
});

describe('mapFont', () => {
  it('maps condensed faces to the headline font', () => {
    expect(mapFont('National2Condensed-Bold', undefined, 30)).toEqual({ font: 'headline', fontWeight: 700 });
    expect(mapFont('Roboto Narrow', undefined, 20).font).toBe('headline');
    expect(mapFont('Foo', 400, 30, '75%')).toEqual({ font: 'headline', fontWeight: 600 });
  });
  it('maps heavy + big text to the headline font, the rest to body', () => {
    expect(mapFont('Inter-Bold', undefined, 64)).toEqual({ font: 'headline', fontWeight: 700 });
    expect(mapFont('Inter-Bold', undefined, 30)).toEqual({ font: 'body', fontWeight: 700 });
    expect(mapFont('ArialMT', undefined, 20)).toEqual({ font: 'body', fontWeight: 400 });
    expect(mapFont('Inter', 300, 20)).toEqual({ font: 'body', fontWeight: 400 }); // clamped to loaded weights
    expect(mapFont('Inter', 900, 20)).toEqual({ font: 'body', fontWeight: 700 });
  });
});

describe('colours', () => {
  it('snaps text to navy / white', () => {
    expect(snapTextColour(WHITE)).toBe('white');
    expect(snapTextColour(NAVY)).toBe('navy');
    expect(snapTextColour([62, 204, 255])).toBe('white'); // sky
    expect(snapTextColour([30, 30, 30])).toBe('navy');
  });
  it('lets the background decide for mid tones and unreadable picks', () => {
    expect(snapTextColour([31, 101, 214], NAVY)).toBe('white'); // blue text on navy
    expect(snapTextColour([31, 101, 214], WHITE)).toBe('navy'); // blue text on white
    expect(snapTextColour([255, 113, 155], WHITE)).toBe('navy'); // pink on white would vanish as white
    expect(snapTextColour(null, NAVY)).toBe('white');
  });
  it('finds the nearest brand colours', () => {
    expect(nearestCore([0, 10, 90])).toBe('navy');
    expect(nearestCore([60, 200, 250])).toBe('sky');
    expect(nearestCore([250, 250, 250])).toBe('white');
    expect(nearestCore([30, 100, 210])).toBe('blue');
    expect(nearestToken([250, 205, 10], ALL_TOKENS)).toBe('yellow');
    expect(isBrandTextColour(WHITE)).toBe(true);
    expect(isBrandTextColour([255, 113, 155])).toBe(false);
  });
  it('converts Photoshop colours', () => {
    expect(colorToRgb({ r: 1, g: 2, b: 3 })).toEqual([1, 2, 3]);
    expect(colorToRgb({ fr: 1, fg: 0, fb: 0.5 })).toEqual([255, 0, 127.5]);
    expect(colorToRgb(undefined)).toBeNull();
    const red = colorToRgb({ h: 0, s: 1, b: 1 })!;
    expect(red.map(Math.round)).toEqual([255, 0, 0]);
  });
});

describe('SVG CSS sanitizing', () => {
  it('drops imports, external urls and script-ish CSS, keeps fragments and embedded data', () => {
    const css = cleanCss(
      "@import url(https://evil.example/x.css); a{fill:url(#g)} b{background:url('https://evil.example/t.png')} " +
        '@font-face{src:url(data:font/woff2;base64,AAAA)} c{width:expression(alert(1))} d{x:url(javascript:alert(1))}',
    );
    expect(css).not.toMatch(/@import|evil\.example|expression\(|javascript:/);
    expect(css).toContain('url(#g)');
    expect(css).toContain('url(data:font/woff2;base64,AAAA)');
  });
});

describe('importKindOf', () => {
  const f = (name: string, type = '') => new File(['x'], name, { type });
  it('detects kinds by extension or MIME type', () => {
    expect(importKindOf(f('ad.PSD'))).toBe('psd');
    expect(importKindOf(f('ad', 'image/vnd.adobe.photoshop'))).toBe('psd');
    expect(importKindOf(f('ad', 'application/x-photoshop'))).toBe('psd');
    expect(importKindOf(f('ad.svg'))).toBe('svg');
    expect(importKindOf(f('ad.jpeg'))).toBe('raster');
    expect(importKindOf(f('ad.webp'))).toBe('raster');
    expect(importKindOf(f('ad.gif', 'image/gif'))).toBeNull();
    expect(ACCEPTED_FILES).toContain('.psd');
  });
});
