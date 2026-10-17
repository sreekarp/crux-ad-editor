import { describe, expect, it } from 'vitest';
import {
  avoidBrief,
  chunkCounts,
  clampCount,
  describeAnalysis,
  designRequirements,
  formatAnswers,
  normalizePlan,
  normalizeQuestions,
  normalizeSteps,
  sizeKeyIn,
  withAnswers,
} from '../agent';
import {
  average,
  combineScore,
  designPrompt,
  finalStatus,
  fixChip,
  missLabel,
  parseDesignPrompt,
  photoOpOf,
  pickSuggestions,
  PASS_SCORE,
  resolvedIssues,
  sameIssue,
  scoreDetail,
  shortIssue,
  shouldKeep,
  withTimeout,
} from '../review';
import type { PlanResponse } from '../types';

const Q = [
  { id: 'audience', q: 'Who is this ad for?', options: ['Cafés', 'Tradies'] },
  { id: 'how_many', q: 'How many options?', options: ['1', '2', '4'] },
];

describe('review scoring', () => {
  it('scores vision minus brand penalties (8 per error, 3 per warning), clamped', () => {
    expect(combineScore(90)).toBe(90);
    expect(combineScore(90, 0, 0)).toBe(90);
    expect(combineScore(90, 1, 0)).toBe(82);
    expect(combineScore(90, 0, 2)).toBe(84);
    expect(combineScore(88, 1, 1)).toBe(77);
    expect(combineScore(20, 3, 0)).toBe(0);
    expect(combineScore(150, 0, 0)).toBe(100);
    expect(combineScore(NaN, 0, 0)).toBe(0);
  });

  it('labels brief misses and picks the one allowed photo op', () => {
    expect(missLabel('Photo shows a restaurant owner')).toBe('restaurant owner missing');
    expect(missLabel('Christmas theme visible.')).toBe('Christmas theme visible missing');
    const ops = [
      { op: 'update' as const, id: 'h', props: {} },
      { op: 'photo' as const, id: 'p1', prompt: 'restaurant owner, fairy lights' },
    ];
    expect(photoOpOf(ops, true)).toEqual({ op: 'photo', id: 'p1', prompt: 'restaurant owner, fairy lights' });
    expect(photoOpOf(ops, false)).toBeNull();
    expect(photoOpOf([{ op: 'photo', id: 'p1', prompt: '' }], true)).toBeNull();
  });

  it('keeps a fix unless the score dropped', () => {
    expect(shouldKeep(72, 88)).toBe(true);
    expect(shouldKeep(80, 80)).toBe(true);
    expect(shouldKeep(80, 79)).toBe(false);
  });

  it('formats trace details and averages', () => {
    expect(scoreDetail(72, 88)).toBe('72 → 88');
    expect(scoreDetail(88, 88)).toBe('88');
    expect(average([71, 86])).toBe(79);
    expect(average([])).toBe(0);
    expect(PASS_SCORE).toBe(85);
  });

  it('tags a next-step chip with its design and reads plain chips unchanged', () => {
    expect(parseDesignPrompt(designPrompt('d_Ab-9_x', 'Try the dark colourway'))).toEqual({ designId: 'd_Ab-9_x', text: 'Try the dark colourway' });
    expect(parseDesignPrompt('Make a square version')).toEqual({ designId: null, text: 'Make a square version' });
  });

  it('picks up to 3 unique suggestions', () => {
    expect(pickSuggestions([['Make a 9:16 story version', 'Try dark'], ['try dark', 'Shorter headline', 'New photo'], ['']])).toEqual([
      'Make a 9:16 story version',
      'Try dark',
      'Shorter headline',
    ]);
  });

  it('times out slow promises', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'Slow')).rejects.toThrow('Slow timed out');
    await expect(withTimeout(Promise.resolve(5), 1000, 'Fast')).resolves.toBe(5);
  });
});

describe('review outcome (✓ vs ⚠, edits vs fixed)', () => {
  it('shows ✓ only at PASS_SCORE+ with no brief miss left', () => {
    expect(finalStatus(85)).toBe('done');
    expect(finalStatus(92, [])).toBe('done');
    expect(finalStatus(77)).toBe('warn');
    expect(finalStatus(90, ['Photo shows a florist'])).toBe('warn');
    expect(finalStatus(null)).toBe('warn');
  });

  it('counts only first-look issues that are gone as fixed (rewording is still open)', () => {
    const first = ['Headline is clipped by the bloom', "Photo crop hides the maker's face", 'Logo too small'];
    const last = ['The headline looks clipped', "Crop still hides the maker's face"];
    expect(sameIssue('Headline is clipped by the bloom', 'The headline looks clipped')).toBe(true);
    expect(sameIssue('Logo too small', 'The headline looks clipped')).toBe(false);
    expect(resolvedIssues(first, last)).toEqual(['Logo too small']);
    expect(resolvedIssues(first, [])).toHaveLength(3);
    expect(resolvedIssues([], last)).toEqual([]);
  });

  it('shortens issues for the summary line', () => {
    expect(shortIssue('Headline is clipped.')).toBe('headline is clipped');
    expect(shortIssue('XERO logo too small')).toBe('XERO logo too small');
    expect(shortIssue('x'.repeat(80))).toHaveLength(60);
  });

  it('builds a design-tagged "Fix remaining issues" chip asking for exactly the open issues', () => {
    const one = fixChip({ id: 'd1', after: 77, openIssues: ['Headline is clipped.', "Photo crop hides the maker's face"] }, 0, false);
    expect(one.label).toBe('Fix remaining issues');
    expect(one.kind).toBe('agent-prompt');
    expect(parseDesignPrompt(one.payload ?? '')).toEqual({
      designId: 'd1',
      text: "Edit this design to fix: Headline is clipped; Photo crop hides the maker's face",
    });
    const two = fixChip({ id: 'd2', after: 70, openIssues: [], briefMisses: ['Christmas theme visible'] }, 1, true);
    expect(two.label).toBe("Fix #2's issues");
    expect(parseDesignPrompt(two.payload ?? '').text).toBe('Edit this design to fix: requirement not met: Christmas theme visible');
    expect(parseDesignPrompt(fixChip({ id: 'd3', after: 80 }, 2, true).payload ?? '').text).toMatch(/below 85 \(it scored 80\)/);
  });
});

describe('creation counts', () => {
  it('clamps to 1-8', () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(12)).toBe(8);
    expect(clampCount('3')).toBe(3);
    expect(clampCount(undefined)).toBe(1);
  });

  it('splits counts above 4 into balanced chunks of at most 4', () => {
    expect(chunkCounts(1)).toEqual([1]);
    expect(chunkCounts(4)).toEqual([4]);
    expect(chunkCounts(5)).toEqual([3, 2]);
    expect(chunkCounts(6)).toEqual([3, 3]);
    expect(chunkCounts(7)).toEqual([4, 3]);
    expect(chunkCounts(8)).toEqual([4, 4]);
    expect(chunkCounts(20)).toEqual([4, 4]);
    for (let n = 1; n <= 8; n++) {
      const c = chunkCounts(n);
      expect(c.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...c)).toBeLessThanOrEqual(4);
    }
  });

  it('builds an avoid-list for later chunks', () => {
    expect(avoidBrief([{ template: 'card', headline: 'Get paid faster' }, { template: 'split', headline: 'Less admin' }])).toContain(
      'card "Get paid faster"; split "Less admin"',
    );
    expect(avoidBrief([])).toBe('');
  });
});

describe('plan guard', () => {
  const base = (p: Partial<PlanResponse>): Partial<PlanResponse> => ({ understanding: 'u', prompt: 'p', ...p });

  it('never asks twice', () => {
    const p = normalizePlan(base({ action: 'ask', questions: Q }), { message: 'make an ad', hasDesign: false, askedAlready: true });
    expect(p.action).toBe('create');
    expect(p.questions).toEqual([]);
    const e = normalizePlan(base({ action: 'ask', questions: Q }), { message: 'shorter headline', hasDesign: true, askedAlready: true });
    expect(e.action).toBe('edit');
  });

  it('asks only with valid questions', () => {
    expect(normalizePlan(base({ action: 'ask', questions: [] }), { message: 'make an ad', hasDesign: false, askedAlready: false }).action).toBe('create');
    const ok = normalizePlan(base({ action: 'ask', questions: Q }), { message: 'make an ad', hasDesign: false, askedAlready: false });
    expect(ok.action).toBe('ask');
    expect(ok.questions).toHaveLength(2);
  });

  it('falls back for unknown actions and missing fields', () => {
    const p = normalizePlan({ action: 'dance' as never }, { message: 'make it pop', hasDesign: true, askedAlready: false });
    expect(p).toMatchObject({ action: 'edit', prompt: 'make it pop', understanding: 'make it pop', count: 1, size: null, brief: null, steps: [] });
    expect(normalizePlan(null, { message: 'an ad for florists', hasDesign: false, askedAlready: false }).action).toBe('create');
  });

  it('needs a design for edits and 2+ steps for steps', () => {
    expect(normalizePlan(base({ action: 'edit' }), { message: 'x', hasDesign: false, askedAlready: false }).action).toBe('create');
    const one = normalizePlan(base({ action: 'steps', steps: [{ action: 'edit', prompt: 'make it dark', label: 'Dark' }] }), {
      message: 'm',
      hasDesign: true,
      askedAlready: false,
    });
    expect(one).toMatchObject({ action: 'edit', prompt: 'make it dark', steps: [] });
    const two = normalizePlan(
      base({
        action: 'steps',
        steps: [
          { action: 'edit', prompt: 'make it dark', label: '' },
          { action: 'resize', prompt: 'make it 9:16', label: 'Story' },
          { action: 'bogus' as never, prompt: 'x', label: 'x' },
        ],
      }),
      { message: 'm', hasDesign: true, askedAlready: false },
    );
    expect(two.action).toBe('steps');
    expect(two.steps).toEqual([
      { action: 'edit', prompt: 'make it dark', label: 'make it dark' },
      { action: 'resize', prompt: 'make it 9:16', label: 'Story' },
    ]);
  });

  it('clamps count and validates size', () => {
    expect(normalizePlan(base({ action: 'create', count: 12, size: '9:16' }), { message: 'm', hasDesign: false, askedAlready: false })).toMatchObject({
      count: 8,
      size: '9:16',
    });
    expect(normalizePlan(base({ action: 'create', size: '16:9' as never }), { message: 'm', hasDesign: false, askedAlready: false }).size).toBeNull();
    expect(normalizePlan(base({ action: 'resize', size: null }), { message: 'make it a story', hasDesign: true, askedAlready: false })).toMatchObject({
      action: 'resize',
      size: '9:16',
    });
    expect(normalizePlan(base({ action: 'resize', size: null, prompt: 'bigger' }), { message: 'bigger', hasDesign: true, askedAlready: false }).action).toBe('edit');
  });

  it('normalises questions: max 3, 2-4 options, unique slug ids', () => {
    const qs = normalizeQuestions([
      { id: 'Audience Type', q: 'Who?', options: ['A', 'B', 'B', 'C', 'D', 'E'] },
      { id: 'audience type', q: 'Who else?', options: ['A', 'B'] },
      { id: 'x', q: 'One option only', options: ['A'] },
      { q: 'Offer?', options: ['50% off', 'Free trial'] },
      { id: 'more', q: 'Fourth?', options: ['a', 'b'] },
    ]);
    expect(qs.map((q) => q.id)).toEqual(['audience_type', 'audience_type_2', 'offer']);
    expect(qs[0].options).toEqual(['A', 'B', 'C', 'D']);
    expect(normalizeQuestions('nope')).toEqual([]);
  });

  it('keeps fix steps without a prompt and caps at 5', () => {
    const steps = normalizeSteps(Array.from({ length: 7 }, () => ({ action: 'fix', prompt: '', label: '' })));
    expect(steps).toHaveLength(5);
    expect(steps[0]).toEqual({ action: 'fix', prompt: 'Fix brand issues', label: 'Fix brand issues' });
  });
});

describe('brief fidelity (§9)', () => {
  const base = (p: Partial<PlanResponse>): Partial<PlanResponse> => ({ understanding: 'u', prompt: 'p', ...p });
  const ctx = { message: 'Christmas campaign for local businesses', hasDesign: false, askedAlready: false };

  it('keeps multi questions and plan subjects / theme / requirements', () => {
    const qs = normalizeQuestions([{ id: 'businesses', q: 'Which businesses?', options: ['Bakery', 'Florist', 'Restaurant'], multi: true }]);
    expect(qs[0].multi).toBe(true);
    expect(normalizeQuestions(Q)[0].multi).toBeUndefined();
    const p = normalizePlan(
      base({ action: 'create', count: 3, subjects: [' bakery owner ', 'florist', '', 'restaurant owner'], theme: ' Christmas ', requirements: ['Christmas theme visible'] }),
      ctx,
    );
    expect(p).toMatchObject({ count: 3, subjects: ['bakery owner', 'florist', 'restaurant owner'], theme: 'Christmas', requirements: ['Christmas theme visible'] });
  });

  it('keeps the backend count; without one, one design per subject', () => {
    expect(normalizePlan(base({ action: 'create', count: 2, subjects: ['a', 'b', 'c'] }), ctx)).toMatchObject({ count: 2, subjects: ['a', 'b'] });
    expect(normalizePlan(base({ action: 'create', subjects: ['bakery', 'florist', 'restaurant'] }), ctx).count).toBe(3);
    expect(normalizePlan(base({ action: 'create' }), ctx)).toMatchObject({ count: 1, subjects: [], theme: null, requirements: [] });
  });

  it('maps each created design to its subject and requirements, in creation order', () => {
    expect(designRequirements(['d1', 'd2', 'd3'], ['bakery owner', 'florist', 'ice cream shop owner'], ['Christmas theme visible'])).toEqual({
      d1: ['Christmas theme visible', 'Photo shows a bakery owner'],
      d2: ['Christmas theme visible', 'Photo shows a florist'],
      d3: ['Christmas theme visible', 'Photo shows an ice cream shop owner'],
    });
    // more designs than subjects: the rest get the shared requirements only
    expect(designRequirements(['d1', 'd2'], ['restaurant'], [])).toEqual({ d1: ['Photo shows a restaurant'], d2: [] });
  });

  it('formats a multi answer under a "Businesses" label', () => {
    const qs = [{ id: 'which_businesses', q: 'Which businesses?', options: ['Bakery', 'Florist', 'Restaurant'], multi: true }, ...Q];
    expect(formatAnswers({ 'Which businesses?': 'Bakery, Florist, Restaurant', 'Who is this ad for?': 'Cafés' }, qs)).toBe(
      'Businesses: Bakery, Florist, Restaurant · Audience: Cafés',
    );
  });
});

describe('answers and playback', () => {
  it('formats answers with question ids as labels', () => {
    expect(formatAnswers({ 'Who is this ad for?': 'Cafés', 'How many options?': '2', 'Offer?': ' 3 months free ', Empty: '' }, Q)).toBe(
      'Audience: Cafés · How many: 2 · Offer: 3 months free',
    );
  });

  it('appends answers for the classic fallback', () => {
    expect(withAnswers('make an ad.', { 'Who is this ad for?': 'Cafés' }, Q)).toBe('make an ad. Audience: Cafés');
    expect(withAnswers('make an ad', null)).toBe('make an ad');
    expect(withAnswers('make an ad', {})).toBe('make an ad');
    // a bare count gets a noun so the classic countFor() reads it
    expect(withAnswers('make an ad', { 'How many options?': '3' }, Q)).toBe('make an ad. How many: 3 designs');
  });

  it('describes only what the analysis found', () => {
    expect(
      describeAnalysis(
        { template: 'card', colourway: 'light', hero: { type: 'photo', photoTag: 'florist' }, headline: 'Bloom your books', charms: [{ charm: 'heart', colour: 'pink' as never }, { charm: 'sparkle', colour: 'pink' as never }] },
        [],
      ),
    ).toBe('I see: card layout, light colourway, florist photo, headline "Bloom your books", 2 charms (heart, sparkle).');
    expect(describeAnalysis({}, ['Hello'])).toBe('I see: headline "Hello".');
    expect(describeAnalysis({})).toMatch(/couldn't pick out/);
  });

  it('finds sizes in step text', () => {
    expect(sizeKeyIn('Make a 9:16 story')).toBe('9:16');
    expect(sizeKeyIn('square version')).toBe('1:1');
    expect(sizeKeyIn('bigger')).toBeNull();
  });
});
