// Shared design model. Single source of truth for frontend + backend contract (see docs/CONTRACT.md).
// A Design is plain JSON: the canvas only renders it, the copilot only edits it via Ops.

export type ColourToken = 'navy' | 'blue' | 'sky' | 'white' | 'mint' | 'yellow' | 'pink' | 'lilac';
export type CoreColour = 'navy' | 'blue' | 'sky' | 'white';
export type CharmColour = 'blue' | 'green' | 'yellow' | 'pink' | 'purple';
export type LogoColour = 'navy' | 'sky' | 'white';

export type BloomShape =
  | 'peace' | 'energy' | 'x' | 'spark' | 'grow' | 'pulse'
  | 'harmony' | 'motion' | 'balance' | 'ease' | 'surge' | 'stride';

export type TemplateId = 'card' | 'bold' | 'checklist' | 'split' | 'offer';
export type Colourway = 'light' | 'dark' | 'blue';

export type Role =
  | 'bg-shape' | 'bloom' | 'card' | 'headline' | 'headline2' | 'sub' | 'cta' | 'disclaimer'
  | 'logo' | 'tags' | 'stat' | 'charm' | 'photo' | 'device' | 'illustration' | 'row' | 'row-text'
  | 'flat-image' | 'decor';

interface LayerBase {
  id: string;
  role?: Role;
  name?: string;
  /** Top-left position and box size in design pixels (design.width x design.height space). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the top-left corner (Konva convention). */
  rotation?: number;
  opacity?: number;
  locked?: boolean;
  hidden?: boolean;
}

export interface RectLayer extends LayerBase {
  kind: 'rect';
  fill: ColourToken;
  cornerRadius?: number;
}

export interface TextLayer extends LayerBase {
  kind: 'text';
  text: string;
  /** 'headline' = Barlow Condensed, 'body' = Inter (see src/brand.ts FONTS). */
  font: 'headline' | 'body';
  fontSize: number;
  fontWeight: number;
  fill: ColourToken;
  align: 'left' | 'center' | 'right';
  lineHeight: number;
  /** Pixels. */
  letterSpacing?: number;
  uppercase?: boolean;
}

/** Call-to-action button: rounded rect + centred label, one layer so it moves as a unit. */
export interface ButtonLayer extends LayerBase {
  kind: 'button';
  text: string;
  fill: ColourToken;
  textFill: ColourToken;
  fontSize: number;
  cornerRadius: number;
}

/** Xero wordmark. pill != null draws a rounded pill of that colour behind the wordmark. */
export interface LogoLayer extends LayerBase {
  kind: 'logo';
  colour: LogoColour;
  pill?: LogoColour | null;
}

/** Brand bloom shape, pre-tinted PNG at /static/brand/blooms/{shape}_{colour}.png, drawn stretched to its box. */
export interface BloomLayer extends LayerBase {
  kind: 'bloom';
  shape: BloomShape;
  colour: ColourToken;
  flipX?: boolean;
  flipY?: boolean;
}

/** Brand background template shape, pre-tinted PNG at /static/brand/bg/{bgId}_{colour}.png, drawn stretched to its box. */
export interface BgShapeLayer extends LayerBase {
  kind: 'bgshape';
  bgId: string;
  colour: CoreColour;
  flipX?: boolean;
  flipY?: boolean;
}

/** 3D charm at /static/brand/charms/{charm}_{colour}.png. */
export interface CharmLayer extends LayerBase {
  kind: 'charm';
  charm: string;
  colour: CharmColour;
}

/** Plain image (illustration, device cut-out, uploaded flat design). */
export interface ImageLayer extends LayerBase {
  kind: 'image';
  src: string;
  assetId?: string;
}

/**
 * Photo cropped into a bloom mask (mask != null) or into a rounded rectangle (mask == null).
 * Photo is cover-fitted into the box, then scaled by zoom (>=1) and positioned by focus (0..1).
 */
export interface PhotoLayer extends LayerBase {
  kind: 'photo';
  src: string | null;
  mask: BloomShape | null;
  cornerRadius?: number;
  zoom: number;
  focusX: number;
  focusY: number;
  prompt?: string;
  status?: 'loading' | 'ready' | 'error';
  /** Where the person (main face) is in the source image, as [x, y] fractions — lets code re-aim the crop for any
   *  box (template switch, resize, move, "reframe"). Set for photo-bank images. */
  subject?: [number, number] | null;
  /** Source image size in px (needed with `subject` to compute the crop). */
  srcW?: number;
  srcH?: number;
  /** Essential region of the main subject: what must stay visible for the crop to look good (always the whole head and
   *  hair; a close-up may be just head and shoulders; a product = its full extent), as [x0, y0, x1, y1] fractions of the
   *  SOURCE image. When set, framing keeps the whole box visible (design/frame.ts, design/photoFit.ts). */
  subjectBox?: [number, number, number, number] | null;
}

/** "✓ ACCOUNTING ✓ PAYMENTS ✓ PAYROLL ✓ ANALYTICS" strip: green check bullets + condensed caps. */
export interface TagsLayer extends LayerBase {
  kind: 'tags';
  items: string[];
  fill: ColourToken;
  columns: 1 | 2 | 4;
  fontSize: number;
}

/** White stat card, e.g. "Cash flow / R12,500" with a sparkline. */
export interface StatLayer extends LayerBase {
  kind: 'stat';
  label: string;
  value: string;
  variant: 'sparkline' | 'check' | 'area' | 'bars';
}

export type Layer =
  | RectLayer | TextLayer | ButtonLayer | LogoLayer | BloomLayer | BgShapeLayer
  | CharmLayer | ImageLayer | PhotoLayer | TagsLayer | StatLayer;

export type LayerKind = Layer['kind'];

export interface Design {
  id: string;
  name: string;
  width: number;
  height: number;
  background: CoreColour;
  template?: TemplateId;
  colourway?: Colourway;
  /** The slots this design was built from (kept so the copilot can rebuild/reflow it). */
  slots?: Slots;
  /** Bottom to top. */
  layers: Layer[];
}

// ---------------------------------------------------------------------------------------------
// Slots: what the LLM fills in. The template engine turns Slots into a Design (layout is code).

export interface Hero {
  type: 'photo' | 'device' | 'illustration' | 'none';
  /** Photo bank tag, e.g. 'florist' (see CONTRACT.md PHOTO_TAGS). */
  photoTag?: string;
  /** Prompt used when generating a fresh photo. */
  photoPrompt?: string;
  /** Resolved photo URL (filled by the frontend before/after buildDesign). */
  photoUrl?: string | null;
  deviceId?: string;
  illustrationId?: string;
}

export interface StatSpec {
  label: string;
  value: string;
  variant: 'sparkline' | 'check' | 'area' | 'bars';
}

export interface CharmSpec {
  charm: string;
  colour: CharmColour;
}

export interface Slots {
  template: TemplateId;
  colourway: Colourway;
  headline: string;
  /** split template only: second headline on the light side. */
  headline2?: string | null;
  sub?: string | null;
  cta: string;
  ctaStyle?: 'sky' | 'navy' | 'white';
  disclaimer?: string | null;
  /** checklist rows (max 3). For 'comparison' style use items for the Xero column. */
  items?: string[] | null;
  tags?: boolean;
  stat?: StatSpec | null;
  hero: Hero;
  /** Photo mask / main bloom shape. Photo masks must be chunky: harmony | peace | balance | x | energy. */
  bloom?: BloomShape;
  /** 0-3 charms. */
  charms?: CharmSpec[];
  /** Free-text market, e.g. 'UK' | 'AU' | 'NZ' | 'ZA' | 'US' (affects currency in copy only). */
  market?: string;
}

// ---------------------------------------------------------------------------------------------
// Ops: the only way the copilot changes a design.

export type Op =
  | { op: 'update'; id: string; props: Partial<Layer> }
  | { op: 'add'; layer: Layer; index?: number }
  | { op: 'delete'; id: string }
  | { op: 'reorder'; id: string; to: 'front' | 'back' | 'forward' | 'backward' }
  | { op: 'rebuild'; slots: Partial<Slots> }
  | { op: 'resize'; width: number; height: number }
  | { op: 'photo'; id: string; prompt: string }
  | { op: 'pixel_edit'; id: string; prompt: string }
  /** Re-aim a photo's crop at its subject (code does the maths; the LLM never guesses focus values). */
  | { op: 'reframe'; id?: string };

/** Ops that need a network round trip; applyOps returns them for the caller to run. */
export type AsyncOp = Extract<Op, { op: 'photo' } | { op: 'pixel_edit' }>;

// ---------------------------------------------------------------------------------------------
// Brand checker.

export type RuleId =
  | 'palette' | 'text-colour' | 'contrast' | 'logo-count' | 'logo-colour' | 'logo-pill' | 'logo-aspect'
  | 'cta-count' | 'headline-length' | 'headline-punctuation' | 'safe-margin' | 'safe-zone-916'
  | 'min-font-size' | 'disclaimer' | 'photo-treatment' | 'bloom-colours' | 'aspect' | 'off-canvas';

export interface Issue {
  id: string;
  rule: RuleId;
  severity: 'error' | 'warning';
  message: string;
  layerId?: string;
  /** Ops that fix it (empty/undefined = manual fix needed). */
  fix?: Op[];
}

// ---------------------------------------------------------------------------------------------
// Asset manifest (backend/static/brand/manifest.json, produced by backend/scripts/prep_assets.py).

export interface Manifest {
  palette: Record<ColourToken, string>;
  blooms: {
    shape: BloomShape;
    w: number;
    h: number;
    photoMask: boolean;
    mask: string;
    colours: Partial<Record<ColourToken, string>>;
  }[];
  backgrounds: {
    id: string;
    aspect: '1:1' | '9:16';
    w: number;
    h: number;
    colours: Partial<Record<CoreColour, string>>;
  }[];
  charms: {
    type: string;
    w: number;
    h: number;
    colours: Partial<Record<CharmColour, string>>;
  }[];
  illustrations: { id: string; src: string; w: number; h: number; tags: string[]; ribbon?: 'sky' | 'blue' | 'pink' }[];
  devices: { id: string; src: string; w: number; h: number; tags: string[]; cutout: boolean }[];
  logo: { mask: string; navy: string; sky: string; white: string; w: number; h: number };
}

/** One of the 20 reference ads, recreated as Slots (backend/data/references.json). */
export interface Reference {
  id: string;
  url: string;
  slots: Slots;
  notes?: string;
}

export interface PhotoBankItem {
  url: string;
  tag: string;
  prompt: string;
  w: number;
  h: number;
  /** Subject (main face) position as [x, y] fractions — crops aim here so the person stays in view. */
  focus?: [number, number];
  /** Whole main subject as [x0, y0, x1, y1] source fractions (see PhotoLayer.subjectBox). */
  box?: [number, number, number, number];
}
