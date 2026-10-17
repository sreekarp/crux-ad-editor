// Left panel: Templates · References · Brand kit.
import { useMemo, useState } from 'react';
import { assetUrl, BLOOM_SHAPES, CORE_COLOURS, PALETTE, SIZES } from '../brand';
import { withPhotoFocus } from '../lib/photoFocus';
import { DesignStage } from '../canvas/DesignStage';
import { buildDesign } from '../design';
import type { BloomShape, CharmColour, ColourToken, Design, LogoColour } from '../types';
import { addLayer, applyBankPhoto, aspectOf, centred, recolourSelected, setBackground } from './actions';
import { createDesignFromSlots, recreateReference, runConcepts } from './copilot';
import { SafeBoundary } from './SafeBoundary';
import { useActiveDesign, useEditor, uid, type LeftTab } from './store';
import { TEMPLATE_PRESETS } from './templates';
import { Icon, Section, Swatch } from './ui';

const COLOUR_TOKENS = Object.keys(PALETTE) as ColourToken[];
const CHARM_COLOURS: { c: CharmColour; hex: string }[] = [
  { c: 'blue', hex: '#1F65D6' },
  { c: 'green', hex: '#2DB879' },
  { c: 'yellow', hex: '#FDCC08' },
  { c: 'pink', hex: '#FF719B' },
  { c: 'purple', hex: '#9B6BFF' },
];
const FALLBACK_CHARMS = 'sparkle heart check checkbox hourglass percent coin money mug gift bulb pie bars chat plane thumbs calendar bell clock shield trophy lock magnifier card bank globe folder laptop phone'.split(' ');
const FALLBACK_DEVICES = [
  'device_phone_hand_payments',
  'device_phone_hand_balance',
  'device_laptop_overview',
  'device_laptop_welcome',
  'device_tablet_hands_account',
  'device_tablet_hands_payments',
  'device_tablet_kitchen',
];
const FALLBACK_ILLUS = [
  'illus_infinity_phone_blue',
  'illus_loop_bell_blue',
  'illus_loop_coins_blue',
  'illus_wave_bulb_blue',
  'illus_wave_coin_blue',
  'illus_infinity_phone_sky',
  'illus_loop_bell_sky',
  'illus_wave_invoice_blue',
];

function Thumb({ src, title, onClick, className = '', bg = 'bg-slate-50' }: { src: string; title: string; onClick: () => void; className?: string; bg?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`group relative grid aspect-square place-items-center overflow-hidden rounded-lg border border-slate-200 p-1.5 transition hover:border-sky hover:shadow-sm ${bg} ${className}`}
    >
      {failed ? (
        <span className="px-1 text-center text-[9px] leading-tight text-slate-400">{title}</span>
      ) : (
        <img src={src} alt={title} loading="lazy" className="h-full w-full object-contain transition group-hover:scale-105" onError={() => setFailed(true)} />
      )}
    </button>
  );
}

function TemplatesTab() {
  const manifest = useEditor((s) => s.manifest);
  const photos = useEditor((s) => s.photos);
  const thumbs = useMemo(
    () =>
      TEMPLATE_PRESETS.map((p) => {
        const hero = { ...p.slots.hero };
        if (hero.type === 'photo') hero.photoUrl = (photos.find((x) => x.tag === hero.photoTag) ?? photos[0])?.url ?? null;
        let d: Design | null = null;
        try {
          d = withPhotoFocus(buildDesign({ ...p.slots, hero }, SIZES['4:5'], manifest, { id: `tpl-${p.key}`, name: p.label }), photos);
        } catch (e) {
          console.warn('[template preview]', p.key, e);
        }
        return { p, d };
      }),
    [manifest, photos],
  );
  const TW = 128;
  return (
    <div className="p-3">
      <p className="mb-3 px-1 text-xs text-slate-500">One click starts an editable design with placeholder copy. Then ask the copilot to rewrite it.</p>
      <div className="grid grid-cols-2 gap-3">
        {thumbs.map(({ p, d }) => (
          <button
            key={p.key}
            type="button"
            onClick={() => createDesignFromSlots(p.slots, p.label)}
            className="group overflow-hidden rounded-xl border border-slate-200 bg-white text-left transition hover:border-sky hover:shadow-md"
          >
            <div className="grid place-items-center bg-slate-50" style={{ height: TW * 1.25 }}>
              {d ? (
                <SafeBoundary fallback={<span className="text-[10px] text-slate-400">preview unavailable</span>}>
                  <DesignStage design={d} scale={TW / d.width} detail="thumb" />
                </SafeBoundary>
              ) : (
                <span className="text-[10px] text-slate-400">preview unavailable</span>
              )}
            </div>
            <div className="flex items-center justify-between px-2.5 py-1.5">
              <span className="text-xs font-semibold text-navy">{p.label}</span>
              <Icon name="plus" size={13} className="text-slate-400 group-hover:text-navy" />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function ReferencesTab() {
  const refs = useEditor((s) => s.references);
  const selected = useEditor((s) => s.selectedRefId);
  const busy = useEditor((s) => s.busy);
  const set = useEditor((s) => s.set);
  const pushMsg = useEditor((s) => s.pushMsg);
  if (!refs.length) {
    return <div className="p-6 text-center text-sm text-slate-400">References load from the backend (GET /api/references). Waiting for it…</div>;
  }
  return (
    <div className="p-3">
      <p className="mb-3 px-1 text-xs text-slate-500">Select a reference: recreate it as editable layers, or get on-brand variations of it.</p>
      <div className="grid grid-cols-2 gap-3">
        {refs.map((r) => {
          const on = r.id === selected;
          return (
            <div
              key={r.id}
              className={`group relative overflow-hidden rounded-xl border bg-white transition ${on ? 'border-sky ring-2 ring-sky/40' : 'border-slate-200 hover:border-slate-300'}`}
            >
              <button type="button" className="block w-full" onClick={() => set({ selectedRefId: on ? null : r.id })} title={r.notes ?? r.id}>
                <img src={r.url} alt={r.id} loading="lazy" className="aspect-[4/5] w-full object-cover" />
              </button>
              <div className="flex items-center justify-between px-2 py-1">
                <span className="truncate text-[11px] font-medium text-slate-600">{r.id.replace(/^ref_/, '#')}</span>
                <span className="text-[10px] uppercase text-slate-400">{r.slots?.template}</span>
              </div>
              {on ? (
                <div className="absolute inset-x-1.5 bottom-8 flex flex-col gap-1">
                  <button
                    type="button"
                    className="rounded-md bg-white/95 py-1 text-[11px] font-semibold text-navy shadow hover:bg-white"
                    onClick={() => recreateReference(r)}
                  >
                    Recreate
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="rounded-md bg-navy py-1 text-[11px] font-semibold text-white shadow hover:bg-[#0b1878] disabled:opacity-50"
                    onClick={() => {
                      pushMsg({ role: 'user', text: `4 like ${r.id}` });
                      void runConcepts('Variations like this', 3, { referenceId: r.id });
                    }}
                  >
                    Variations
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BrandTab() {
  const manifest = useEditor((s) => s.manifest);
  const photos = useEditor((s) => s.photos);
  const showToast = useEditor((s) => s.showToast);
  const design = useActiveDesign();
  const [bloomColour, setBloomColour] = useState<ColourToken>('blue');
  const [charmColour, setCharmColour] = useState<CharmColour>('yellow');

  const bloomAspect = (shape: BloomShape) => {
    const b = manifest?.blooms.find((x) => x.shape === shape);
    return aspectOf(b?.w, b?.h, 1.15);
  };
  const charms = manifest?.charms.length ? manifest.charms.map((c) => c.type) : FALLBACK_CHARMS;
  const devices = manifest?.devices.length
    ? manifest.devices.map((d) => ({ id: d.id, src: d.src, a: aspectOf(d.w, d.h, 0.8) }))
    : FALLBACK_DEVICES.map((id) => ({ id, src: `/static/brand/devices/${id}.png`, a: 0.8 }));
  const illus = manifest?.illustrations.length
    ? manifest.illustrations.map((d) => ({ id: d.id, src: d.src, a: aspectOf(d.w, d.h, 1) }))
    : FALLBACK_ILLUS.map((id) => ({ id, src: `/static/brand/illus/${id}.png`, a: 1 }));
  const logoAspect = manifest ? aspectOf(manifest.logo.w, manifest.logo.h, 3.5) : 3.5;

  const addLogo = (colour: LogoColour, pill: LogoColour | null) => {
    const existing = design?.layers.find((l) => l.kind === 'logo');
    if (existing) {
      useEditor.getState().apply([{ op: 'update', id: existing.id, props: { colour, pill } }]);
      useEditor.getState().set({ selection: [existing.id] });
      return;
    }
    addLayer((d) => {
      const w = d.width * 0.28;
      const h = pill ? w / (0.56 * logoAspect + 0.8) : w / logoAspect;
      return { id: uid(), kind: 'logo', role: 'logo', name: 'Logo', x: d.width * 0.06, y: d.height - d.width * 0.06 - h, width: w, height: h, colour, pill };
    });
  };

  return (
    <div>
      <Section title="Background">
        <div className="flex gap-2">
          {CORE_COLOURS.map((c) => (
            <Swatch key={c} colour={PALETTE[c]} title={c} active={design?.background === c} onClick={() => setBackground(c)} />
          ))}
        </div>
      </Section>
      <Section title="Palette" right={<span className="text-[10px] text-slate-400">recolours selection</span>}>
        <div className="flex flex-wrap gap-2">
          {COLOUR_TOKENS.map((c) => (
            <Swatch
              key={c}
              colour={PALETTE[c]}
              title={`${c} ${PALETTE[c]}`}
              onClick={() => {
                const err = recolourSelected(c);
                if (err) showToast(err);
              }}
            />
          ))}
        </div>
      </Section>
      <Section
        title="Blooms"
        right={
          <div className="flex gap-1">
            {COLOUR_TOKENS.map((c) => (
              <Swatch key={c} size={14} colour={PALETTE[c]} title={c} active={bloomColour === c} onClick={() => setBloomColour(c)} />
            ))}
          </div>
        }
      >
        <div className="grid grid-cols-4 gap-1.5">
          {BLOOM_SHAPES.map((shape) => (
            <Thumb
              key={shape}
              src={assetUrl.bloom(shape, bloomColour)}
              title={shape}
              bg={bloomColour === 'white' ? 'bg-slate-200' : 'bg-slate-50'}
              onClick={() =>
                addLayer((d) => {
                  const w = d.width * 0.5;
                  return { id: uid(), kind: 'bloom', role: 'bloom', name: `Bloom ${shape}`, ...centred(d, w, w / bloomAspect(shape)), shape, colour: bloomColour };
                })
              }
            />
          ))}
        </div>
      </Section>
      <Section
        title="Charms"
        right={
          <div className="flex gap-1">
            {CHARM_COLOURS.map(({ c, hex }) => (
              <Swatch key={c} size={14} colour={hex} title={c} active={charmColour === c} onClick={() => setCharmColour(c)} />
            ))}
          </div>
        }
      >
        <div className="grid max-h-56 grid-cols-5 gap-1.5 overflow-y-auto pr-1">
          {charms.map((type) => (
            <Thumb
              key={type}
              src={assetUrl.charm(type, charmColour)}
              title={type}
              onClick={() =>
                addLayer((d) => {
                  const m = manifest?.charms.find((c) => c.type === type);
                  const w = d.width * 0.16;
                  return { id: uid(), kind: 'charm', role: 'charm', name: `Charm ${type}`, ...centred(d, w, w / aspectOf(m?.w, m?.h, 1)), charm: type, colour: charmColour };
                })
              }
            />
          ))}
        </div>
      </Section>
      <Section title="Illustrations">
        <div className="grid grid-cols-3 gap-1.5">
          {illus.map((it) => (
            <Thumb
              key={it.id}
              src={it.src}
              title={it.id}
              bg="bg-navy/90"
              onClick={() =>
                addLayer((d) => {
                  const w = d.width * 0.6;
                  return { id: uid(), kind: 'image', role: 'illustration', name: it.id, assetId: it.id, src: it.src, ...centred(d, w, w / it.a) };
                })
              }
            />
          ))}
        </div>
      </Section>
      <Section title="Devices">
        <div className="grid grid-cols-3 gap-1.5">
          {devices.map((it) => (
            <Thumb
              key={it.id}
              src={it.src}
              title={it.id}
              onClick={() =>
                addLayer((d) => {
                  const w = d.width * 0.55;
                  return { id: uid(), kind: 'image', role: 'device', name: it.id, assetId: it.id, src: it.src, ...centred(d, w, w / it.a) };
                })
              }
            />
          ))}
        </div>
      </Section>
      <Section title="Photos" right={<span className="text-[10px] text-slate-400">{photos.length} in bank</span>}>
        {photos.length ? (
          <div className="grid max-h-64 grid-cols-3 gap-1.5 overflow-y-auto pr-1">
            {photos.map((p) => (
              <button
                key={p.url}
                type="button"
                title={`${p.tag}: ${p.prompt}`}
                onClick={() => applyBankPhoto(p.url)}
                className="group relative aspect-[3/4] overflow-hidden rounded-lg border border-slate-200 hover:border-sky"
              >
                <img src={p.url} alt={p.tag} loading="lazy" className="h-full w-full object-cover transition group-hover:scale-105" />
                <span className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] font-medium text-white">
                  {p.tag}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400">Photo bank is empty or the backend is offline.</p>
        )}
      </Section>
      <Section title="Logo">
        <div className="grid grid-cols-3 gap-1.5">
          {(['navy', 'sky', 'white'] as LogoColour[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => addLogo(c, null)}
              className={`grid h-12 place-items-center rounded-lg border border-slate-200 hover:border-sky ${c === 'navy' ? 'bg-sky' : c === 'sky' ? 'bg-navy' : 'bg-xblue'}`}
              title={`${c} wordmark`}
            >
              <img src={assetUrl.logo(c)} alt={c} className="h-5 object-contain" />
            </button>
          ))}
          {[
            { pill: 'white' as LogoColour, colour: 'navy' as LogoColour },
            { pill: 'navy' as LogoColour, colour: 'sky' as LogoColour },
            { pill: 'sky' as LogoColour, colour: 'navy' as LogoColour },
          ].map((p) => (
            <button
              key={p.pill}
              type="button"
              onClick={() => addLogo(p.colour, p.pill)}
              className="grid h-12 place-items-center rounded-lg border border-slate-200 bg-slate-100 hover:border-sky"
              title={`${p.colour} on ${p.pill} pill`}
            >
              <span className="grid h-7 place-items-center rounded-full px-3" style={{ background: PALETTE[p.pill] }}>
                <img src={assetUrl.logo(p.colour)} alt="" className="h-3.5 object-contain" />
              </span>
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}

const TABS: { id: LeftTab; label: string }[] = [
  { id: 'templates', label: 'Templates' },
  { id: 'references', label: 'References' },
  { id: 'brand', label: 'Brand kit' },
];

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab);
  const set = useEditor((s) => s.set);
  return (
    <aside className="flex w-[300px] shrink-0 flex-col border-r border-slate-200 bg-white">
      <div className="flex gap-1 border-b border-slate-200 px-3 pt-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => set({ leftTab: t.id })}
            className={`-mb-px border-b-2 px-2.5 pb-2 pt-1 text-[13px] font-semibold transition ${
              tab === t.id ? 'border-navy text-navy' : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'templates' ? <TemplatesTab /> : tab === 'references' ? <ReferencesTab /> : <BrandTab />}
      </div>
    </aside>
  );
}
