// Inspector column (between the canvas and the copilot chat): Properties / Layers for the active design.
// Collapses to a slim rail so the canvas can take the space; the chat keeps the full right column.
import { useEffect, useState } from 'react';
import { assetUrl, BLOOM_SHAPES, CORE_COLOURS, CTA_STYLES, PALETTE, PHOTO_MASKS, TEXT_COLOURS } from '../brand';
import type {
  BloomShape,
  CharmColour,
  ColourToken,
  CoreColour,
  Design,
  Layer,
  LogoColour,
  PhotoLayer,
  StatLayer,
} from '../types';
import { commitLive, deleteSelected, duplicateSelected, liveUpdate, updateLayer } from './actions';
import { flatImageOf, fourLikeUpload, importPreviewOf, newPhoto, recreateUpload } from './copilot';
import { useActiveDesign, useEditor, useSelectedLayer, type RightTab } from './store';
import { Button, Icon, IconButton, Section, Segmented, Slider, Spinner, Swatch } from './ui';

// ---------------------------------------------------------------------------------------------
// Properties

const KIND_LABEL: Record<Layer['kind'], string> = {
  rect: 'Shape',
  text: 'Text',
  button: 'Button',
  logo: 'Logo',
  bloom: 'Bloom',
  bgshape: 'Background shape',
  charm: 'Charm',
  image: 'Image',
  photo: 'Photo',
  tags: 'Tags',
  stat: 'Stat card',
};

export function layerLabel(l: Layer): string {
  if (l.name) return l.name;
  if (l.role) return l.role.charAt(0).toUpperCase() + l.role.slice(1).replace('-', ' ');
  return KIND_LABEL[l.kind] ?? l.kind;
}

function TextField({ value, onCommit, multiline, placeholder }: { value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = () => {
    if (v !== value) onCommit(v);
  };
  const cls = 'w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-[13px] text-slate-700 focus:border-sky focus:outline-none';
  return multiline ? (
    <textarea value={v} rows={3} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={commit} className={`${cls} resize-none`} />
  ) : (
    <input
      value={v}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={cls}
    />
  );
}

const CHARM_HEX: Record<CharmColour, string> = { blue: '#1F65D6', green: '#2DB879', yellow: '#FDCC08', pink: '#FF719B', purple: '#9B6BFF' };
const FALLBACK_CHARMS = 'sparkle heart check checkbox hourglass percent coin money mug gift bulb pie bars chat plane thumbs calendar bell clock shield trophy lock magnifier card bank globe folder laptop phone'.split(' ');

function PhotoProps({ layer }: { layer: PhotoLayer }) {
  const [prompt, setPrompt] = useState(layer.prompt ?? '');
  useEffect(() => setPrompt(layer.prompt ?? ''), [layer.id, layer.prompt]);
  const generating = layer.status === 'loading';
  return (
    <>
      <Section title="Crop">
        <div className="space-y-2.5">
          <Slider label="Zoom" value={layer.zoom ?? 1} min={1} max={3} step={0.01} format={(v) => `${v.toFixed(2)}×`} onChange={(v) => liveUpdate(layer.id, { zoom: v } as Partial<Layer>)} onCommit={commitLive} />
          <Slider label="Focus X" value={layer.focusX ?? 0.5} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => liveUpdate(layer.id, { focusX: v } as Partial<Layer>)} onCommit={commitLive} />
          <Slider label="Focus Y" value={layer.focusY ?? 0.5} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}%`} onChange={(v) => liveUpdate(layer.id, { focusY: v } as Partial<Layer>)} onCommit={commitLive} />
        </div>
      </Section>
      <Section title="Mask">
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => updateLayer(layer.id, { mask: null } as Partial<Layer>)}
            className={`h-10 w-10 rounded-lg border text-[10px] font-medium ${!layer.mask ? 'border-sky bg-sky/10 text-navy' : 'border-slate-200 text-slate-500'}`}
            title="Rounded rectangle"
          >
            Rect
          </button>
          {PHOTO_MASKS.map((m) => (
            <button
              key={m}
              type="button"
              title={m}
              onClick={() => updateLayer(layer.id, { mask: m } as Partial<Layer>)}
              className={`grid h-10 w-10 place-items-center rounded-lg border bg-slate-50 p-1 ${layer.mask === m ? 'border-sky ring-1 ring-sky' : 'border-slate-200'}`}
            >
              <img src={assetUrl.bloom(m, 'navy')} alt={m} className="h-full w-full object-contain" />
            </button>
          ))}
        </div>
      </Section>
      <Section title="New photo">
        <TextField value={prompt} onCommit={setPrompt} multiline placeholder="e.g. smiling baker holding fresh bread, warm daylight" />
        <div className="mt-2 flex gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={generating}
            onClick={() => {
              useEditor.getState().set({ selection: [layer.id] });
              void newPhoto(prompt.trim() || undefined);
            }}
          >
            {generating ? <Spinner /> : <Icon name="sparkle" size={13} />} Generate
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              useEditor.getState().set({ selection: [layer.id] });
              void newPhoto();
            }}
          >
            <Icon name="refresh" size={13} /> Swap
          </Button>
        </div>
      </Section>
    </>
  );
}

function KindProps({ layer, design }: { layer: Layer; design: Design }) {
  const showToast = useEditor((s) => s.showToast);
  const manifest = useEditor((s) => s.manifest);
  switch (layer.kind) {
    case 'text':
      return (
        <>
          <Section title="Text">
            <TextField value={layer.text} multiline onCommit={(v) => updateLayer(layer.id, { text: v } as Partial<Layer>)} />
          </Section>
          <Section title="Style">
            <div className="space-y-3">
              <Slider
                label="Size"
                value={Math.round(layer.fontSize)}
                min={12}
                max={Math.round(design.width * 0.2)}
                step={1}
                format={(v) => `${v}px`}
                onChange={(v) => liveUpdate(layer.id, { fontSize: v } as Partial<Layer>)}
                onCommit={commitLive}
              />
              <Segmented<string>
                value={String(layer.fontWeight)}
                onChange={(v) => updateLayer(layer.id, { fontWeight: Number(v) } as Partial<Layer>)}
                options={(layer.font === 'headline' ? ['600', '700', '800'] : ['400', '500', '600', '700']).map((w) => ({ value: w, label: w }))}
              />
              <div className="flex items-center justify-between">
                <div className="flex gap-2">
                  {TEXT_COLOURS.map((c) => (
                    <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.fill === c} onClick={() => updateLayer(layer.id, { fill: c } as Partial<Layer>)} />
                  ))}
                </div>
                <Segmented<'left' | 'center' | 'right'>
                  value={layer.align}
                  onChange={(v) => updateLayer(layer.id, { align: v } as Partial<Layer>)}
                  options={[
                    { value: 'left', label: 'Left' },
                    { value: 'center', label: 'Centre' },
                    { value: 'right', label: 'Right' },
                  ]}
                />
              </div>
              <p className="text-[11px] text-slate-400">Text colours are limited to navy and white (WCAG AAA brand rule).</p>
            </div>
          </Section>
        </>
      );
    case 'button':
      return (
        <>
          <Section title="Label">
            <TextField value={layer.text} onCommit={(v) => updateLayer(layer.id, { text: v } as Partial<Layer>)} />
          </Section>
          <Section title="CTA style">
            <div className="flex gap-2">
              {(Object.keys(CTA_STYLES) as (keyof typeof CTA_STYLES)[]).map((k) => {
                const st = CTA_STYLES[k];
                const on = layer.fill === st.fill && layer.textFill === st.textFill;
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => updateLayer(layer.id, { fill: st.fill, textFill: st.textFill } as Partial<Layer>)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-bold ${on ? 'ring-2 ring-sky ring-offset-1' : ''}`}
                    style={{ background: PALETTE[st.fill], color: PALETTE[st.textFill], borderColor: k === 'white' ? '#cbd5e1' : 'transparent' }}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
          </Section>
        </>
      );
    case 'photo':
      return <PhotoProps layer={layer} />;
    case 'bloom':
      return (
        <>
          <Section title="Shape">
            <div className="grid grid-cols-6 gap-1">
              {BLOOM_SHAPES.map((s: BloomShape) => (
                <button
                  key={s}
                  type="button"
                  title={s}
                  onClick={() => updateLayer(layer.id, { shape: s } as Partial<Layer>)}
                  className={`grid aspect-square place-items-center rounded-md border bg-slate-50 p-0.5 ${layer.shape === s ? 'border-sky ring-1 ring-sky' : 'border-slate-200'}`}
                >
                  <img src={assetUrl.bloom(s, 'navy')} alt={s} className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          </Section>
          <Section title="Colour">
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(PALETTE) as ColourToken[]).map((c) => (
                <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.colour === c} onClick={() => updateLayer(layer.id, { colour: c } as Partial<Layer>)} />
              ))}
            </div>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant={layer.flipX ? 'primary' : 'outline'} onClick={() => updateLayer(layer.id, { flipX: !layer.flipX } as Partial<Layer>)}>
                <Icon name="flip" size={13} /> Flip H
              </Button>
              <Button size="sm" variant={layer.flipY ? 'primary' : 'outline'} onClick={() => updateLayer(layer.id, { flipY: !layer.flipY } as Partial<Layer>)}>
                <Icon name="flip" size={13} className="rotate-90" /> Flip V
              </Button>
            </div>
          </Section>
        </>
      );
    case 'bgshape':
      return (
        <Section title="Colour">
          <div className="flex gap-2">
            {CORE_COLOURS.map((c: CoreColour) => (
              <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.colour === c} onClick={() => updateLayer(layer.id, { colour: c } as Partial<Layer>)} />
            ))}
          </div>
        </Section>
      );
    case 'charm': {
      const types = manifest?.charms.length ? manifest.charms.map((c) => c.type) : FALLBACK_CHARMS;
      return (
        <>
          <Section title="Charm">
            <div className="grid max-h-40 grid-cols-6 gap-1 overflow-y-auto pr-1">
              {types.map((t) => (
                <button
                  key={t}
                  type="button"
                  title={t}
                  onClick={() => updateLayer(layer.id, { charm: t } as Partial<Layer>)}
                  className={`grid aspect-square place-items-center rounded-md border bg-slate-50 p-0.5 ${layer.charm === t ? 'border-sky ring-1 ring-sky' : 'border-slate-200'}`}
                >
                  <img src={assetUrl.charm(t, layer.colour)} alt={t} loading="lazy" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          </Section>
          <Section title="Colour">
            <div className="flex gap-2">
              {(Object.keys(CHARM_HEX) as CharmColour[]).map((c) => (
                <Swatch key={c} colour={CHARM_HEX[c]} title={c} active={layer.colour === c} onClick={() => updateLayer(layer.id, { colour: c } as Partial<Layer>)} />
              ))}
            </div>
          </Section>
        </>
      );
    }
    case 'logo':
      return (
        <Section title="Logo">
          <div className="space-y-2.5">
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-xs text-slate-500">Colour</span>
              {(['navy', 'sky', 'white'] as LogoColour[]).map((c) => (
                <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.colour === c} onClick={() => updateLayer(layer.id, { colour: c } as Partial<Layer>)} />
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="w-12 shrink-0 text-xs text-slate-500">Pill</span>
              <Segmented<string>
                className="*:px-1.5"
                value={layer.pill ?? 'none'}
                onChange={(v) => {
                  const pill = v === 'none' ? null : (v as LogoColour);
                  // Keep allowed pairs: navy pill -> sky logo, white/sky pill -> navy logo.
                  const colour: LogoColour = pill === 'navy' ? 'sky' : pill ? 'navy' : layer.colour;
                  updateLayer(layer.id, { pill, colour } as Partial<Layer>);
                }}
                options={[
                  { value: 'none', label: 'None' },
                  { value: 'white', label: 'White' },
                  { value: 'navy', label: 'Navy' },
                  { value: 'sky', label: 'Sky' },
                ]}
              />
            </div>
            <p className="text-[11px] text-slate-400">Use a pill when the logo sits on a photo or busy area.</p>
          </div>
        </Section>
      );
    case 'rect':
      return (
        <Section title="Fill">
          <div className="flex flex-wrap gap-2">
            {(Object.keys(PALETTE) as ColourToken[]).map((c) => (
              <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.fill === c} onClick={() => updateLayer(layer.id, { fill: c } as Partial<Layer>)} />
            ))}
          </div>
          <div className="mt-3">
            <Slider
              label="Corner radius"
              value={Math.round(layer.cornerRadius ?? 0)}
              min={0}
              max={Math.round(Math.min(layer.width, layer.height) / 2)}
              step={1}
              onChange={(v) => liveUpdate(layer.id, { cornerRadius: v } as Partial<Layer>)}
              onCommit={commitLive}
            />
          </div>
        </Section>
      );
    case 'tags':
      return (
        <Section title="Tags">
          <TextField value={(layer.items ?? []).join(', ')} onCommit={(v) => updateLayer(layer.id, { items: v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 4) } as Partial<Layer>)} />
          <div className="mt-2.5 flex items-center justify-between">
            <div className="flex gap-2">
              {TEXT_COLOURS.map((c) => (
                <Swatch key={c} colour={PALETTE[c]} title={c} active={layer.fill === c} onClick={() => updateLayer(layer.id, { fill: c } as Partial<Layer>)} />
              ))}
            </div>
            <Segmented<string>
              value={String(layer.columns)}
              onChange={(v) => updateLayer(layer.id, { columns: Number(v) as 1 | 2 | 4 } as Partial<Layer>)}
              options={[
                { value: '1', label: '1 col' },
                { value: '2', label: '2 col' },
                { value: '4', label: 'Row' },
              ]}
            />
          </div>
        </Section>
      );
    case 'stat':
      return (
        <Section title="Stat card">
          <div className="space-y-2">
            <TextField value={layer.label} placeholder="Label" onCommit={(v) => updateLayer(layer.id, { label: v } as Partial<Layer>)} />
            <TextField value={layer.value} placeholder="Value" onCommit={(v) => updateLayer(layer.id, { value: v } as Partial<Layer>)} />
            <Segmented<StatLayer['variant']>
              value={layer.variant}
              onChange={(v) => updateLayer(layer.id, { variant: v } as Partial<Layer>)}
              options={[
                { value: 'sparkline', label: 'Spark' },
                { value: 'check', label: 'Check' },
                { value: 'area', label: 'Area' },
                { value: 'bars', label: 'Bars' },
              ]}
            />
          </div>
        </Section>
      );
    case 'image':
      if (layer.role === 'flat-image') {
        const preview = importPreviewOf(design) ?? layer.src;
        const flat = flatImageOf(design);
        return (
          <Section title="Imported image">
            <p className="mb-2 text-xs text-slate-500">
              {flat
                ? 'Flat image (locked). Rebuild it as an editable on-brand design, or describe pixel edits in the chat.'
                : 'Background of an imported file (locked). Its text and images above are editable layers.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" size="sm" onClick={() => void recreateUpload(preview)}>
                <Icon name="layers" size={13} /> Analyze &amp; recreate
              </Button>
              <Button variant="outline" size="sm" onClick={() => void fourLikeUpload(preview)}>
                <Icon name="grid" size={13} /> Variations like this
              </Button>
            </div>
          </Section>
        );
      }
      return (
        <Section title={layer.role === 'device' ? 'Device' : layer.role === 'illustration' ? 'Illustration' : 'Image'}>
          <p className="truncate text-xs text-slate-500" title={layer.src}>
            {layer.assetId ?? layer.src}
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => showToast('Drag the corners to resize — aspect ratio is locked.')}>
            Aspect locked
          </Button>
        </Section>
      );
    default:
      return null;
  }
}

function DesignProps({ design }: { design: Design }) {
  const issues = useEditor((s) => s.issues);
  return (
    <div>
      <Section title="Design">
        <dl className="grid grid-cols-2 gap-y-1 text-xs">
          <dt className="text-slate-400">Size</dt>
          <dd className="text-slate-700">
            {design.width}×{design.height}
          </dd>
          <dt className="text-slate-400">Template</dt>
          <dd className="capitalize text-slate-700">{design.template ?? '—'}</dd>
          <dt className="text-slate-400">Colourway</dt>
          <dd className="capitalize text-slate-700">{design.colourway ?? '—'}</dd>
          <dt className="text-slate-400">Layers</dt>
          <dd className="text-slate-700">{design.layers.length}</dd>
          <dt className="text-slate-400">Brand issues</dt>
          <dd className="text-slate-700">{issues.length}</dd>
        </dl>
      </Section>
      <div className="px-4 py-6 text-center text-xs text-slate-400">Select a layer on the canvas to edit it. Double-click text to type.</div>
    </div>
  );
}

function Properties() {
  const design = useActiveDesign();
  const layer = useSelectedLayer();
  const selection = useEditor((s) => s.selection);
  if (!design) return <div className="p-6 text-center text-xs text-slate-400">No design yet.</div>;
  if (!layer) {
    if (selection.length > 1) return <div className="p-6 text-center text-xs text-slate-400">{selection.length} layers selected</div>;
    return <DesignProps design={design} />;
  }
  return (
    <div>
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-navy">{layerLabel(layer)}</div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">{KIND_LABEL[layer.kind]}</div>
        </div>
        <IconButton icon={layer.locked ? 'lock' : 'unlock'} title={layer.locked ? 'Unlock' : 'Lock'} active={layer.locked} onClick={() => updateLayer(layer.id, { locked: !layer.locked })} />
        <IconButton icon="copy" title="Duplicate (Ctrl+D)" onClick={duplicateSelected} />
        <IconButton icon="trash" title="Delete (Del)" onClick={deleteSelected} disabled={layer.locked} />
      </div>
      <KindProps layer={layer} design={design} />
      <Section title="Layer">
        <Slider
          label="Opacity"
          value={Math.round((layer.opacity ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          format={(v) => `${v}%`}
          onChange={(v) => liveUpdate(layer.id, { opacity: v / 100 })}
          onCommit={commitLive}
        />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Layers list

const KIND_ICON: Record<Layer['kind'], string> = {
  rect: 'grid',
  text: 'layers',
  button: 'check',
  logo: 'shield',
  bloom: 'sparkle',
  bgshape: 'sparkle',
  charm: 'sparkle',
  image: 'image',
  photo: 'image',
  tags: 'check',
  stat: 'grid',
};

function LayersList() {
  const design = useActiveDesign();
  const selection = useEditor((s) => s.selection);
  const { select, apply, set } = useEditor.getState();
  if (!design) return <div className="p-6 text-center text-xs text-slate-400">No design yet.</div>;
  const rows = [...design.layers].reverse();
  return (
    <div className="py-1">
      {rows.map((l) => {
        const on = selection.includes(l.id);
        const preview = 'text' in l && typeof l.text === 'string' ? l.text : '';
        return (
          <div
            key={l.id}
            onClick={() => select([l.id])}
            onMouseEnter={() => set({ hoverLayerId: l.id })}
            onMouseLeave={() => set({ hoverLayerId: null })}
            className={`group flex cursor-pointer items-center gap-2 px-3 py-1.5 ${on ? 'bg-sky/15' : 'hover:bg-slate-50'}`}
          >
            <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${on ? 'bg-navy text-sky' : 'bg-slate-100 text-slate-500'}`}>
              <Icon name={KIND_ICON[l.kind]} size={12} />
            </span>
            <div className={`min-w-0 flex-1 ${l.hidden ? 'opacity-40' : ''}`}>
              <div className="truncate text-xs font-medium text-slate-700">{layerLabel(l)}</div>
              {preview ? <div className="truncate text-[10px] text-slate-400">{preview}</div> : null}
            </div>
            <div className={`flex items-center ${on ? '' : 'opacity-0 group-hover:opacity-100'} ${l.hidden || l.locked ? 'opacity-100' : ''}`}>
              <button type="button" title="Bring forward" className="p-1 text-slate-400 hover:text-navy" onClick={(e) => (e.stopPropagation(), apply([{ op: 'reorder', id: l.id, to: 'forward' }]))}>
                <Icon name="up" size={13} />
              </button>
              <button type="button" title="Send backward" className="p-1 text-slate-400 hover:text-navy" onClick={(e) => (e.stopPropagation(), apply([{ op: 'reorder', id: l.id, to: 'backward' }]))}>
                <Icon name="down" size={13} />
              </button>
              <button
                type="button"
                title={l.hidden ? 'Show' : 'Hide'}
                className={`p-1 hover:text-navy ${l.hidden ? 'text-navy' : 'text-slate-400'}`}
                onClick={(e) => (e.stopPropagation(), apply([{ op: 'update', id: l.id, props: { hidden: !l.hidden } }]))}
              >
                <Icon name={l.hidden ? 'eyeOff' : 'eye'} size={13} />
              </button>
              <button
                type="button"
                title={l.locked ? 'Unlock' : 'Lock'}
                className={`p-1 hover:text-navy ${l.locked ? 'text-navy' : 'text-slate-400'}`}
                onClick={(e) => (e.stopPropagation(), apply([{ op: 'update', id: l.id, props: { locked: !l.locked } }]))}
              >
                <Icon name={l.locked ? 'lock' : 'unlock'} size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TABS: { id: RightTab; label: string; icon: string }[] = [
  { id: 'properties', label: 'Properties', icon: 'sliders' },
  { id: 'layers', label: 'Layers', icon: 'layers' },
];

/** Collapsed inspector: an icon rail. A dot marks a selected layer waiting to be edited. */
function InspectorRail({ count }: { count: number }) {
  const hasSelection = useEditor((s) => s.selection.length > 0);
  const { set, setInspectorOpen } = useEditor.getState();
  return (
    <aside className="flex w-11 shrink-0 flex-col items-center gap-1 border-l border-slate-200 bg-white py-2">
      <IconButton icon="panelOpen" title="Show properties & layers" onClick={() => setInspectorOpen(true)} />
      <div className="my-1 h-px w-6 bg-slate-200" />
      {TABS.map((t) => (
        <div key={t.id} className="relative">
          <IconButton
            icon={t.icon}
            title={t.label}
            onClick={() => {
              set({ rightTab: t.id });
              setInspectorOpen(true);
            }}
          />
          {t.id === 'properties' && hasSelection ? <span className="pointer-events-none absolute right-1 top-1 h-2 w-2 rounded-full bg-sky ring-2 ring-white" /> : null}
          {t.id === 'layers' && count ? (
            <span className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-slate-100 px-1 text-[9px] font-semibold tabular-nums text-slate-500">{count}</span>
          ) : null}
        </div>
      ))}
    </aside>
  );
}

export function Inspector() {
  const design = useActiveDesign();
  const open = useEditor((s) => s.inspectorOpen);
  const tab = useEditor((s) => s.rightTab);
  const { set, setInspectorOpen } = useEditor.getState();
  // No design yet: nothing to inspect, give the empty state the room.
  if (!design) return null;
  const count = design.layers.length;
  if (!open) return <InspectorRail count={count} />;
  return (
    <aside className="flex w-[272px] shrink-0 flex-col border-l border-slate-200 bg-white">
      <div className="flex items-center gap-1 border-b border-slate-200 pl-3 pr-1.5 pt-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => set({ rightTab: t.id })}
            className={`-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-semibold transition ${
              tab === t.id ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {t.label}
            {t.id === 'layers' && count ? <span className="ml-1 text-[10px] text-slate-400">{count}</span> : null}
          </button>
        ))}
        <IconButton icon="panelClose" title="Hide panel" className="mb-1 ml-auto" onClick={() => setInspectorOpen(false)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === 'properties' ? <Properties /> : <LayersList />}</div>
    </aside>
  );
}
