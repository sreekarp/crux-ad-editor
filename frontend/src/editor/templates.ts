// One-click starting points: template x colourway with placeholder copy (layout comes from the design engine).
import type { Colourway, Slots, TemplateId } from '../types';

export interface TemplatePreset {
  key: string;
  label: string;
  template: TemplateId;
  colourway: Colourway;
  slots: Slots;
}

const card = (colourway: Colourway): Slots => ({
  template: 'card',
  colourway,
  headline: 'Run your business, not your books.',
  sub: colourway === 'light' ? "See what's coming in. Plan what's going out." : null,
  cta: 'Find out more',
  hero: { type: 'photo', photoTag: colourway === 'blue' ? 'foodtruck' : 'florist' },
  charms: [{ charm: 'sparkle', colour: 'yellow' }],
  tags: colourway !== 'light',
  stat: colourway === 'light' ? { label: 'Cash flow', value: '£12,500', variant: 'sparkline' } : null,
});

const bold = (colourway: Colourway): Slots => ({
  template: 'bold',
  colourway,
  headline: colourway === 'dark' ? 'Data in. Doubt out.' : 'Up and running in under 4 hours.',
  cta: colourway === 'dark' ? 'Try Xero today' : 'Make the switch',
  hero: { type: 'photo', photoTag: colourway === 'dark' ? 'maker' : 'homeoffice' },
  bloom: 'harmony',
  stat: colourway === 'dark' ? { label: 'Cash flow', value: '£12,500', variant: 'sparkline' } : null,
  charms: [{ charm: colourway === 'dark' ? 'coin' : 'check', colour: colourway === 'dark' ? 'yellow' : 'green' }],
});

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { key: 'card-light', label: 'Card · Light', template: 'card', colourway: 'light', slots: card('light') },
  { key: 'card-dark', label: 'Card · Dark', template: 'card', colourway: 'dark', slots: card('dark') },
  { key: 'card-blue', label: 'Card · Blue', template: 'card', colourway: 'blue', slots: card('blue') },
  { key: 'bold-dark', label: 'Bold · Dark', template: 'bold', colourway: 'dark', slots: bold('dark') },
  { key: 'bold-blue', label: 'Bold · Blue', template: 'bold', colourway: 'blue', slots: bold('blue') },
  {
    key: 'checklist-dark',
    label: 'Checklist · Dark',
    template: 'checklist',
    colourway: 'dark',
    slots: {
      template: 'checklist',
      colourway: 'dark',
      headline: 'Payroll? Automated. Super? Sorted.',
      items: ['Payroll', 'Super', 'Me time'],
      cta: 'Try Xero',
      hero: { type: 'none' },
      charms: [
        { charm: 'sparkle', colour: 'yellow' },
        { charm: 'mug', colour: 'blue' },
      ],
    },
  },
  {
    key: 'split-light',
    label: 'Split',
    template: 'split',
    colourway: 'light',
    slots: {
      template: 'split',
      colourway: 'light',
      headline: 'Other software holds you back.',
      headline2: 'Xero holds your hand.',
      cta: 'Switch to Xero',
      ctaStyle: 'white',
      hero: { type: 'device', deviceId: 'device_phone_hand_payments' },
      tags: true,
      charms: [{ charm: 'heart', colour: 'pink' }],
    },
  },
  {
    key: 'offer-light',
    label: 'Offer · Light',
    template: 'offer',
    colourway: 'light',
    slots: {
      template: 'offer',
      colourway: 'light',
      headline: 'Get your first month free.',
      sub: 'Switch today and see why small businesses love Xero.',
      disclaimer: 'Terms apply.',
      cta: 'Get started',
      ctaStyle: 'navy',
      hero: { type: 'photo', photoTag: 'cafe' },
      bloom: 'peace',
      charms: [
        { charm: 'gift', colour: 'yellow' },
        { charm: 'sparkle', colour: 'pink' },
      ],
    },
  },
];
