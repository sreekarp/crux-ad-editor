// Brand constants (from assets/Brand Kit). Everything brand-related reads from here.
import type { BloomShape, ColourToken, CoreColour, LogoColour } from './types';

export const PALETTE: Record<ColourToken, string> = {
  navy: '#000856',
  blue: '#1F65D6',
  sky: '#3ECCFF',
  white: '#FFFFFF',
  mint: '#6AEAAA',
  yellow: '#FDCC08',
  pink: '#FF719B',
  lilac: '#CF89FE',
};

/** Backgrounds may only use these (true for all 20 reference ads). */
export const CORE_COLOURS: CoreColour[] = ['navy', 'blue', 'sky', 'white'];
/** Bloom/charm/illustration accents only. */
export const ACCENT_COLOURS: ColourToken[] = ['mint', 'yellow', 'pink', 'lilac'];
/** Text is navy or white only (WCAG AAA per the accessibility slide). */
export const TEXT_COLOURS: ColourToken[] = ['navy', 'white'];
export const DARK_COLOURS: ColourToken[] = ['navy', 'blue'];

export const FONTS = { headline: 'Barlow Condensed', body: 'Inter' } as const;

export const BLOOM_SHAPES: BloomShape[] = [
  'peace', 'energy', 'x', 'spark', 'grow', 'pulse',
  'harmony', 'motion', 'balance', 'ease', 'surge', 'stride',
];
/** Chunky blooms that work as photo masks. The thin ones are decoration only. */
export const PHOTO_MASKS: BloomShape[] = ['harmony', 'peace', 'balance', 'x', 'energy'];

/** Allowed logo colours per background (05_Logo_Guidelines). First entry = preferred. */
export const LOGO_ON: Record<CoreColour, LogoColour[]> = {
  navy: ['sky', 'white'],
  blue: ['white'],
  sky: ['navy'],
  white: ['navy'],
};
/** Allowed pill + wordmark pairs when the logo sits on a photo or busy area. */
export const LOGO_PILLS: { pill: LogoColour; colour: LogoColour }[] = [
  { pill: 'white', colour: 'navy' },
  { pill: 'navy', colour: 'sky' },
  { pill: 'sky', colour: 'navy' },
];

export const CTA_STYLES = {
  sky: { fill: 'sky', textFill: 'navy' },
  navy: { fill: 'navy', textFill: 'white' },
  white: { fill: 'white', textFill: 'navy' },
} as const satisfies Record<string, { fill: ColourToken; textFill: ColourToken }>;

export const SIZES = {
  '4:5': { width: 1080, height: 1350 },
  '1:1': { width: 1080, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
} as const;
export type SizeKey = keyof typeof SIZES;

/** Fractions of width/height. story = Meta 9:16 safe zone (17_Meta_Asset_Safe_Zones). */
export const SAFE = {
  margin: 0.06,
  story: { top: 0.14, bottom: 0.35, side: 0.06, bottomRightW: 0.21, bottomRightH: 0.4 },
} as const;

/** Minimum body text size at 1080px wide (scale linearly with width). */
export const MIN_FONT_PX_AT_1080 = 24;

export const assetUrl = {
  bloom: (shape: BloomShape, colour: ColourToken) => `/static/brand/blooms/${shape}_${colour}.png`,
  mask: (shape: BloomShape) => `/static/brand/masks/${shape}.png`,
  charm: (type: string, colour: string) => `/static/brand/charms/${type}_${colour}.png`,
  logo: (colour: LogoColour) => `/static/brand/logo/logo_${colour}.png`,
  bg: (id: string, colour: CoreColour) => `/static/brand/bg/${id}_${colour}.png`,
  manifest: '/static/brand/manifest.json',
};

export const DEFAULT_TAGS = ['ACCOUNTING', 'PAYMENTS', 'PAYROLL', 'ANALYTICS'];
