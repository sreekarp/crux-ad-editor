import { describe, expect, it } from 'vitest';
import { countFor, isAcceptedFile, isQuestion, isSmallTalk, sizeCommand, wantsNewDesigns } from './copilot';

describe('chat intent heuristics', () => {
  it('detects requests for new designs', () => {
    for (const t of [
      'Create 4 like this',
      'make an ad for a bakery',
      'Create a Facebook ad for florists',
      'give me a new design',
      'I need an ad for Black Friday',
      'show me 3 options',
      'two more versions please',
      'more variations',
    ]) {
      expect(wantsNewDesigns(t), t).toBe(true);
    }
  });

  it('treats edits of the current design as edits', () => {
    for (const t of [
      'Make it dark',
      'make the ad dark',
      'Make the headline shorter and punchier',
      'make the headline 20% bigger',
      'Make 9:16',
      'make the photo square',
      'fix the typo in the headline',
      'swap the photo for a baker',
    ]) {
      expect(wantsNewDesigns(t), t).toBe(false);
    }
  });

  it('treats small talk and plain questions on an empty canvas as chat, briefs as briefs', () => {
    for (const t of ['hey', 'Hi there!', 'thanks', 'what can you do', 'help', 'How does this work?']) expect(isSmallTalk(t), t).toBe(true);
    for (const t of ['Instagram ad for cafe owners about getting paid faster', 'make an ad for a bakery', 'hey, make me an ad'])
      expect(isSmallTalk(t), t).toBe(false);
    expect(isQuestion('which colours are on-brand?')).toBe(true);
    expect(isQuestion('can you make an ad for florists?')).toBe(false);
    expect(isQuestion('Christmas campaign for a bakery')).toBe(false);
  });

  it('counts requested variations', () => {
    expect(countFor('Create 4 like this')).toBe(4);
    expect(countFor('some variations please')).toBe(3);
    expect(countFor('show me options')).toBe(3);
    expect(countFor('give me two')).toBe(2);
    expect(countFor('make an ad for a bakery')).toBe(1);
    expect(countFor('give me 6')).toBe(6);
    expect(countFor('make 2 ads for a cafe')).toBe(2);
    expect(countFor('five variations for florists')).toBe(5);
    expect(countFor('Variations like this')).toBe(3);
    expect(countFor('Story ad: 50% off Xero for 3 months for UK small businesses')).toBe(1);
  });

  it('recognises resize commands but not layer edits', () => {
    expect(sizeCommand('Make 9:16')).toBe('9:16');
    expect(sizeCommand('make it a story')).toBe('9:16');
    expect(sizeCommand('resize to square')).toBe('1:1');
    expect(sizeCommand('switch back to 4:5')).toBe('4:5');
    expect(sizeCommand('make the photo square')).toBeNull();
    expect(sizeCommand('Make it dark')).toBeNull();
  });

  it('accepts the importer file types only', () => {
    const f = (name: string, type: string) => new File(['x'], name, { type });
    expect(isAcceptedFile(f('ad.png', 'image/png'))).toBe(true);
    expect(isAcceptedFile(f('ad.svg', 'image/svg+xml'))).toBe(true);
    expect(isAcceptedFile(f('Layout.PSD', ''))).toBe(true);
    expect(isAcceptedFile(f('notes.pdf', 'application/pdf'))).toBe(false);
  });
});
