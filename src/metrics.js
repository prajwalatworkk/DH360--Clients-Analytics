// What each metric means when it moves, and what kind of number it is.
//
// Direction alone cannot colour a change: spend rising is neither good nor bad, cost
// per closure rising is bad, and closures rising is good. Deciding this at each call
// site — a boolean passed by hand — is how a metric ends up coloured by whoever wrote
// that line rather than by what it measures. One map, read by every badge.

export const POLARITY = {
  leads: 'up-good',
  qualified: 'up-good',
  closed: 'up-good',
  impressions: 'up-good',
  clicks: 'up-good',
  ctr: 'up-good',

  costPerLead: 'up-bad',
  costPerQualified: 'up-bad',
  costPerClosure: 'up-bad',
  notQualified: 'up-bad',

  // Spending more is a decision, not an outcome. Colouring it green or red asserts a
  // judgement the number cannot support.
  spend: 'neutral',
};

export const KIND = {
  leads: 'count',
  qualified: 'count',
  closed: 'count',
  impressions: 'count',
  clicks: 'count',
  notQualified: 'count',

  spend: 'currency',
  costPerLead: 'currency',
  costPerQualified: 'currency',
  costPerClosure: 'currency',

  ctr: 'rate',
};

export const polarityOf = (metric) => POLARITY[metric] || 'neutral';
export const kindOf = (metric) => KIND[metric] || 'count';

// Percentages lie about small numbers: 2 closures becoming 1 is "-50%", which reads
// as a collapse rather than one deal. Below ten on both sides, the absolute change is
// the honest figure, and it carries no good/bad colour because one event rarely is one.
export const SMALL_COUNT = 10;

export function changeOf(metric, cur, prev) {
  if (prev == null || cur == null) return null;
  const a = Number(cur) || 0;
  const b = Number(prev) || 0;
  if (!a && !b) return null;

  const kind = kindOf(metric);
  if (kind === 'count' && b < SMALL_COUNT && a < SMALL_COUNT) {
    // Google Ads reports conversions as a fraction, so a count can arrive as 9.5.
    // "+9.5 leads" is not a thing anyone counted; round before showing a difference.
    const diff = Math.round(a) - Math.round(b);
    if (diff === 0) return { mode: 'absolute', text: 'same', tone: 'flat' };
    return {
      mode: 'absolute',
      text: `${diff > 0 ? '+' : '−'}${Math.abs(diff)}`,
      tone: 'flat',
    };
  }

  if (!b) return { mode: 'new', text: 'new', tone: 'flat' };

  const pct = ((a - b) / b) * 100;
  if (Math.abs(pct) < 0.5) return { mode: 'percent', text: '0%', tone: 'flat' };

  const up = pct > 0;
  const polarity = polarityOf(metric);
  const tone = polarity === 'neutral' ? 'flat' : (polarity === 'up-good') === up ? 'good' : 'bad';
  const size = Math.abs(pct);
  const rounded = size >= 100 ? Math.round(size) : size.toFixed(size < 10 ? 1 : 0);

  return { mode: 'percent', text: `${up ? '▲' : '▼'} ${rounded}%`, tone };
}
