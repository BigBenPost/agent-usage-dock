import { Pricing, Rate, rateScope, ResolvedRate } from './pricing';
import type { ModelRow } from './summary';
import { SOURCE_LABELS } from './types';
import { compareCodeUnits } from './validation';

/** Blank fields and values matching the inherited rate continue to follow that rate. */
export function rateOverride(answers: Partial<Record<keyof Rate, string>>, builtin: Partial<Rate> | undefined): Partial<Rate> {
  const out: Partial<Rate> = {};
  for (const [key, raw] of Object.entries(answers) as [keyof Rate, string][]) {
    if (raw.trim() === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 0 && value !== builtin?.[key]) out[key] = value;
  }
  return out;
}

export interface RateChoice {
  label: string;
  description: string;
  detail: string;
  key: string;
  model: ModelRow;
  provider?: string;
  rate?: ResolvedRate;
  unpriced: boolean;
}

export function rateChoices(models: ModelRow[], pricing: Pricing): RateChoice[] {
  const choices = models.flatMap(model => {
    const routes = new Set((model.pricingParts ?? []).map(part => part.provider));
    if (!routes.size) routes.add(undefined);
    return Array.from(routes, provider => {
      const rate = pricing.rateFor(model.model, model.source, provider);
      const unpriced = !rate || (model.pricingParts ?? []).some(part => part.provider === provider && part.unpriced);
      return {
        label: model.model,
        description: [SOURCE_LABELS[model.source], provider, unpriced ? 'Has unpriced usage' : undefined].filter(Boolean).join(' · '),
        detail: rate ? `USD/M · input ${rate.missing?.includes('input') ? 'unknown' : rate.input} · output ${rate.missing?.includes('output') ? 'unknown' : rate.output} · ${rate.overridden ? 'user override' : rate.note ?? 'built-in reference'}` : 'Add a rate for this model',
        key: rateScope(model.source, provider) + model.model, provider, model, rate, unpriced,
      };
    });
  });
  return choices.sort((a, b) => Number(b.unpriced) - Number(a.unpriced) || compareCodeUnits(a.label, b.label) || compareCodeUnits(a.key, b.key));
}
