// Structured chat output for Agent Mode: the review message text, word-boundary shortening, plain-words op
// descriptions and the cards' "thinking" (Brand Kit / Strategist / Producer / Art Director).
import { describe, expect, it } from 'vitest';
import { askedLines, brandKitThinking, lookOf, normalizePlan, producerSection, producerThinking, strategistThinking } from '../agent';
import { clipWords, describeOp, describeOps, lookLines, reviewSummary, scoreLine, sentenceCase, type SummaryInput } from '../review';
import type { CritiqueResponse } from '../types';
import type { Design, Manifest } from '../../types';

const design = {
  id: 'd1',
  name: 'Test',
  width: 1080,
  height: 1350,
  background: 'sky',
  slots: { template: 'split', colourway: 'light', headline: 'Get paid faster', cta: 'Try Xero', hero: { type: 'photo' } },
  layers: [
    { id: 'charm-1', kind: 'charm', role: 'charm', charm: 'sparkle', colour: 'pink', x: 0, y: 0, width: 80, height: 80 },
    { id: 'headline', kind: 'text', role: 'headline', text: 'Get paid faster', x: 0, y: 0, width: 600, height: 120 },
    { id: 'sub', kind: 'text', role: 'sub', text: 'Less admin', x: 0, y: 0, width: 600, height: 60 },
    { id: 'photo', kind: 'photo', role: 'photo', src: null, mask: 'harmony', zoom: 1, focusX: 0.5, focusY: 0.5, x: 0, y: 0, width: 500, height: 600 },
    { id: 'cta', kind: 'button', role: 'cta', text: 'Try Xero', x: 0, y: 0, width: 300, height: 90 },
  ],
} as unknown as Design;

const noEllipsis = (s: string) => expect(s).not.toContain('…');

describe('clipWords: shorten at a word boundary, never "…"', () => {
  it('leaves short text alone (minus the trailing period)', () => {
    expect(clipWords('Headline is 11 words (limit 10).')).toBe('Headline is 11 words (limit 10)');
  });

  it('cuts at the last whole word and drops dangling joiners', () => {
    const s = "sub copy in the design layer doesn't match the rendered text on the canvas and the button";
    expect(clipWords(s)).toBe("sub copy in the design layer doesn't match the rendered text");
  });

  it('prefers a clause break in the back half', () => {
    expect(clipWords('Sparkle charm sits on the card edge near the button, which makes the CTA hard to read')).toBe(
      'Sparkle charm sits on the card edge near the button',
    );
  });

  it('drops an unclosed bracket', () => {
    expect(clipWords('Headline runs long at eleven words (the brand limit is ten words for headlines)', 50)).toBe('Headline runs long at eleven words');
  });

  it('always fits the limit and never ends mid-word', () => {
    const samples = [
      'The bloom crops the top of the florist head and the sparkle charm overlaps the button label badly',
      'Photo subject is too small; the headline competes with the stat card, and the logo pill is off-brand',
      'a b c d e f g h i j k l m n o p q r s t u v w x y z a b c d e f g h i j k l m n o p q r s t u v w x y z',
    ];
    for (const s of samples) {
      const t = clipWords(s, 60);
      expect(t.length).toBeLessThanOrEqual(60);
      noEllipsis(t);
      expect(s.startsWith(t)).toBe(true);
      expect([' ', ',', ';', '(', undefined]).toContain(s[t.length]); // the next char is a boundary
    }
    expect(sentenceCase('headline is clipped')).toBe('Headline is clipped');
  });
});

describe('describeOp: ops in plain words', () => {
  it('names the layer and the change', () => {
    expect(describeOp({ op: 'update', id: 'charm-1', props: { x: 10, y: 20 } }, design)).toBe('Moved sparkle charm');
    expect(describeOp({ op: 'update', id: 'charm-1', props: { x: 10, width: 60 } }, design)).toBe('Resized and moved sparkle charm');
    expect(describeOp({ op: 'update', id: 'headline', props: { text: 'Paid faster' } as never }, design)).toBe('Rewrote headline');
    expect(describeOp({ op: 'update', id: 'sub', props: { fill: 'navy' } as never }, design)).toBe('Recoloured sub copy');
    expect(describeOp({ op: 'update', id: 'photo', props: { mask: 'peace' } as never }, design)).toBe('Changed photo bloom to peace');
    expect(describeOp({ op: 'update', id: 'cta', props: { hidden: true } }, design)).toBe('Hid button');
    expect(describeOp({ op: 'update', id: 'ghost_2', props: { opacity: 0.5 } })).toBe('Faded ghost');
    expect(describeOp({ op: 'delete', id: 'charm-1' }, design)).toBe('Removed sparkle charm');
    expect(describeOp({ op: 'reorder', id: 'charm-1', to: 'back' }, design)).toBe('Sent sparkle charm to the back');
    expect(describeOp({ op: 'reframe', id: 'photo' }, design)).toBe('Reframed photo');
    expect(describeOp({ op: 'resize', width: 1080, height: 1920 })).toBe('Resized to 1080×1920');
  });

  it('describes rebuilds by what they change', () => {
    expect(describeOp({ op: 'rebuild', slots: { template: 'card', colourway: 'light' } }, design)).toBe('Rebuilt as Card · light');
    expect(describeOp({ op: 'rebuild', slots: { colourway: 'dark' } }, design)).toBe('Rebuilt as Split · dark');
    expect(describeOp({ op: 'rebuild', slots: { headline: 'A', sub: 'B' } }, design)).toBe('Rewrote headline and sub copy');
    expect(describeOp({ op: 'rebuild', slots: { bloom: 'peace' } }, design)).toBe('Switched bloom to peace');
    expect(describeOp({ op: 'rebuild', slots: { charms: [] } }, design)).toBe('Removed charms');
    expect(describeOp({ op: 'rebuild', slots: { template: 'card', headline: 'A' } }, design)).toBe('Rebuilt as Card · light with new headline');
  });

  it('joins a round of fixes without repeats', () => {
    const ops = [
      { op: 'reframe' as const, id: 'photo' },
      { op: 'reframe' as const, id: 'photo' },
      { op: 'rebuild' as const, slots: { template: 'card' as const, colourway: 'light' as const } },
      { op: 'update' as const, id: 'charm-1', props: { x: 5 } },
    ];
    expect(describeOps(ops, design).join('; ')).toBe('Reframed photo; Rebuilt as Card · light; Moved sparkle charm');
  });
});

describe('reviewSummary: the structured review message', () => {
  it('one design: header, then Fixed and Still open bullets', () => {
    const text = reviewSummary([
      {
        before: 72,
        after: 78,
        status: 'warn',
        fixedItems: ['New photo composed for the visible area', 'Moved sparkle charm', 'Moved sparkle charm'],
        openIssues: ['Headline is 11 words (limit 10).', 'sparkle charm sits on the card edge near the button'],
        briefMisses: [],
      },
    ]);
    expect(text).toBe(
      [
        'Reviewed 1 design · 72 → 78 · ⚠ needs work',
        '## Fixed',
        '• New photo composed for the visible area',
        '• Moved sparkle charm',
        '## Still open',
        '• Headline is 11 words (limit 10)',
        '• Sparkle charm sits on the card edge near the button',
      ].join('\n'),
    );
  });

  it('one design: ✓ with nothing open, brief misses first, a bare ⚠ says why', () => {
    expect(reviewSummary([{ before: 80, after: 88, status: 'done', fixedItems: [] }])).toBe('Reviewed 1 design · 80 → 88 · ✓ ready');
    expect(reviewSummary([{ before: 78, after: 78, status: 'warn' }])).toBe('Reviewed 1 design · 78 · ⚠ needs work\n## Still open\n• Score 78 is below the 85 bar');
    const miss = reviewSummary([{ before: 60, after: 70, status: 'warn', briefMisses: ['Photo shows a florist'], openIssues: ['Logo too small'] }]);
    expect(miss.split('\n').slice(-2)).toEqual(['• Brief not met: Photo shows a florist', '• Logo too small']);
    expect(reviewSummary([{ before: 90, after: 90, status: 'done', brandOnly: true }])).toBe('Reviewed 1 design · 90 (brand rules only) · ✓ ready');
  });

  it('shortens long issues at word boundaries (never "…" mid-word)', () => {
    const long = "Sub copy in the design layer doesn't match the rendered text on the canvas, so the critic can't read it";
    const text = reviewSummary([{ before: 70, after: 78, status: 'warn', openIssues: [long, 'x'.repeat(30)] }]);
    noEllipsis(text);
    for (const line of text.split('\n').filter((l) => l.startsWith('• '))) expect(line.length).toBeLessThanOrEqual(72);
    expect(text).toContain("• Sub copy in the design layer doesn't match the rendered text");
  });

  it('a review that never scored says why', () => {
    expect(reviewSummary([{ before: null, after: null, status: 'skipped', note: 'skipped — you edited it' }])).toBe('Review stopped · you edited it');
    expect(reviewSummary([{ before: null, after: null, status: 'failed', note: '' }])).toBe('Review could not score the design (critique unavailable).');
  });

  it('several designs: average header, then "#k — issue" lines, max 6, every ⚠ design gets one', () => {
    const three: SummaryInput[] = [
      { before: 70, after: 88, status: 'done' },
      { before: 72, after: 80, status: 'warn', openIssues: ['Headline is 11 words', 'Logo too small', 'Charm crowds the button'] },
      { before: 80, after: 82, status: 'warn', briefMisses: ['Christmas theme visible'], openIssues: ['Photo is too dark'] },
    ];
    expect(reviewSummary(three)).toBe(
      [
        'Reviewed 3 designs · average 74 → 83 · 2 need work',
        '## Still open',
        '• #2 — headline is 11 words',
        '• #2 — logo too small',
        '• #2 — charm crowds the button',
        '• #3 — brief not met: Christmas theme visible',
        '• #3 — photo is too dark',
      ].join('\n'),
    );
    const four: SummaryInput[] = [1, 2, 3, 4].map((k) => ({ before: 70, after: 75, status: 'warn', openIssues: [`Issue a${k}`, `Issue b${k}`, `Issue c${k}`] }));
    const lines = reviewSummary(four).split('\n').filter((l) => l.startsWith('• '));
    expect(lines).toHaveLength(6);
    for (const k of [1, 2, 3, 4]) expect(lines.some((l) => l.startsWith(`• #${k} — `))).toBe(true);
  });

  it('several designs: all ready, or some not reviewed', () => {
    expect(reviewSummary([{ before: 80, after: 88, status: 'done' }, { before: 80, after: 88, status: 'done' }])).toBe(
      'Reviewed 2 designs · average 80 → 88 · ✓ all ready',
    );
    expect(
      reviewSummary([
        { before: 80, after: 88, status: 'done' },
        { before: null, after: null, status: 'skipped', note: 'skipped — you edited it' },
      ]),
    ).toBe('Reviewed 1 of 2 designs · average 80 → 88\n## Not reviewed\n• #2 — you edited it');
  });
});

describe('Art Director thinking lines', () => {
  const critique: CritiqueResponse = {
    visionScore: 80,
    verdict: 'fix',
    issues: ['head cut by the bloom'],
    ops: [],
    briefMisses: ['Christmas theme visible'],
    suggestions: [],
    summary: 'Warm festive ad, but the charms crowd the headline.',
    usedVision: true,
  };
  it('scores, issues, misses, brand findings and the take', () => {
    expect(lookLines({ score: 72, critique, brandErrors: 1, brandWarnings: 0 })).toEqual([
      'Score 72 · vision 80, brand rules −8',
      'Head cut by the bloom',
      'Missed: Christmas theme visible',
      'Brand rules: 1 error',
      'Take: Warm festive ad, but the charms crowd the headline',
    ]);
    expect(lookLines({ score: 90, critique: null })).toEqual(['Score 90 (brand rules only, vision unavailable)']);
    expect(scoreLine(72, 72)).toBe('Score 72');
  });
});

describe('Brand Kit / Strategist / Producer thinking', () => {
  it('Brand Kit: palette, fonts, rules, asset counts', () => {
    const [kit] = brandKitThinking(null);
    expect(kit.lines).toEqual(['Palette: navy, blue, sky, white + 4 bloom accents', 'Fonts: Barlow Condensed / Inter', 'Rules: 18 brand rules, checked on every design']);
    const m = { charms: [{ type: 'sparkle' }, { type: 'heart' }, { type: 'sparkle' }], blooms: [{ shape: 'harmony' }, { shape: 'peace' }] } as unknown as Manifest;
    expect(brandKitThinking(m, 40)[0].lines[3]).toBe('Assets: 2 charms, 2 blooms, 40 photos');
  });

  it('Strategist: brief, requirements, the question round and the hand-off', () => {
    const plan = normalizePlan(
      {
        action: 'create',
        count: 3,
        size: '9:16',
        understanding: 'Christmas ads for three local businesses',
        prompt: 'Christmas ads for a bakery, a florist and a restaurant',
        brief: 'Light colourway, warm and festive',
        subjects: ['bakery owner', 'florist', 'restaurant owner'],
        theme: 'Christmas',
        requirements: ['Christmas theme visible'],
      },
      { message: 'Christmas campaign', hasDesign: false, askedAlready: true },
    );
    const t = strategistThinking(plan, { message: 'Christmas campaign', answers: { 'Who is it for?': 'Tradies' }, questions: [{ id: 'audience', q: 'Who is it for?', options: ['Tradies', 'Cafés'] }] });
    expect(t.map((s) => s.title)).toEqual(['Brief', 'Requirements', 'Questions', 'Hand-off']);
    expect(t[0].lines).toEqual([
      'Understood: Christmas ads for three local businesses',
      'Action: create · 3 designs · 9:16',
      'Look: light colourway',
      'Theme: Christmas',
      'Subjects: bakery owner, florist, restaurant owner',
    ]);
    expect(t[2].lines).toEqual(['Asked: Who is it for? → Tradies']);
    expect(t[3].lines[0]).toBe('Brief to Producer: Christmas ads for a bakery, a florist and a restaurant');
  });

  it('records typed and "just go" answers', () => {
    const qs = [
      { id: 'audience', q: 'Who is it for?', options: ['Tradies', 'Cafés'] },
      { id: 'count', q: 'How many?', options: ['1', '3'] },
    ];
    expect(askedLines({ Reply: 'Tradies, 3' }, qs)).toEqual(['Asked: Who is it for? / How many? → Tradies, 3']);
    expect(askedLines({}, qs)[0]).toMatch(/^Asked: Who is it for\? \/ How many\? → you said "just go"/);
    expect(askedLines(null, [])).toEqual([]);
    expect(lookOf('make it dark')).toBe('dark');
    expect(lookOf('a dark chocolate bakery')).toBeNull();
  });

  it('Producer: one section per design with copy, photo source and bloom swap', () => {
    const built = {
      ...design,
      layers: design.layers.map((l) => (l.kind === 'photo' ? { ...l, src: '/static/gen/abc.png', mask: 'peace' } : l)),
    } as Design;
    const slots = { ...design.slots!, template: 'card' as const, sub: 'Less admin, more baking', bloom: 'harmony' as const };
    const s = producerSection(0, built, { slots, subject: 'bakery owner' });
    expect(s.title).toBe('#1 Card · light');
    expect(s.lines).toEqual([
      'Headline "Get paid faster"',
      'Sub "Less admin, more baking"',
      'Button "Try Xero"',
      'Written for: bakery owner',
      'Photo: generated, composed for the bloom',
      'Bloom: harmony → peace (better fit)',
    ]);
    const bank = { ...built, layers: built.layers.map((l) => (l.kind === 'photo' ? { ...l, src: '/static/gen/bank/florist_1.png' } : l)) } as Design;
    const fromBank = producerSection(1, bank, undefined, { bank: [{ url: '/static/gen/bank/florist_1.png', tag: 'florist', prompt: '', w: 1, h: 1 }] });
    expect(fromBank.lines).toContain('Photo: bank (florist)');
    const all = producerThinking({ ids: ['d1'], made: [], fallback: [], errors: ['Backend timed out'], chunks: [3, 3] }, [built]);
    expect(all.map((x) => x.title)).toEqual(['#1 Split · light', 'Notes']);
    expect(all[1].lines).toEqual(["Batches: 3 + 3, later batches avoid the first batch's ideas", 'A batch failed: Backend timed out']);
  });
});
