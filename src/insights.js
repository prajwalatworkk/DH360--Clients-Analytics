// Turns the raw numbers into things to actually do, plus an honest projection of what
// doing them would be worth.
//
// Every rule here is deliberately simple and inspectable — no black box. The projection
// is arithmetic on your own numbers under assumptions that are printed alongside it, not
// a forecast model. Treat it as "what the same money would have bought at your better
// campaigns' efficiency", not a promise.

const pct = (a, b) => (b ? (a / b) * 100 : 0);
const num0 = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');

// Reallocated budget rarely performs as well as the campaign it came from: more budget
// on the same audience means reaching less responsive people. We discount the winner's
// efficiency rather than assume it holds.
const SCALING_PENALTY = 0.25;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function analyseChannel(channel, platform, client) {
  if (!channel || channel.error || !channel.campaigns?.length) return { findings: [], projection: null };

  const rows = channel.campaigns;
  const t = channel.totals;
  const findings = [];

  // --- Tracking integrity comes first: every other number depends on it. ---
  if (t.pixelLeads > Math.max(t.clicks, 1) * 1.5) {
    findings.push({
      severity: 'critical',
      title: 'Conversion tracking is broken',
      detail: `The pixel recorded ${Math.round(t.pixelLeads).toLocaleString('en-IN')} lead events against only ${t.clicks.toLocaleString('en-IN')} clicks. It is almost certainly firing on page load instead of form submit.`,
      action: 'Fix the Lead event to fire only on form submit. Until then Meta is optimising toward page views, so bidding is being trained on noise.',
    });
  }

  // --- Money going nowhere ---
  const dead = rows.filter((r) => r.leads === 0 && r.spend > t.spend * 0.05);
  const deadSpend = dead.reduce((s, r) => s + r.spend, 0);
  if (dead.length) {
    findings.push({
      severity: 'high',
      title: `${dead.length} ${dead.length > 1 ? 'campaigns are' : 'campaign is'} spending with zero leads`,
      detail: `₹${Math.round(deadSpend).toLocaleString('en-IN')} (${pct(deadSpend, t.spend).toFixed(0)}% of spend) produced no leads: ${dead.map((d) => d.name).join(', ')}.`,
      action: 'Pause these and move the budget to the lowest-CPL campaign, or fix their targeting/creative before spending more.',
    });
  }

  // --- Efficiency spread between campaigns ---
  const earners = rows.filter((r) => r.leads > 0);
  if (earners.length > 1) {
    const best = earners.reduce((a, b) => (a.spend / a.leads <= b.spend / b.leads ? a : b));
    const worst = earners.reduce((a, b) => (a.spend / a.leads >= b.spend / b.leads ? a : b));
    const bestCpl = best.spend / best.leads;
    const worstCpl = worst.spend / worst.leads;
    if (worstCpl > bestCpl * 1.5) {
      findings.push({
        severity: 'high',
        title: 'Wide gap in cost per lead between campaigns',
        detail: `"${best.name}" brings leads at ₹${Math.round(bestCpl).toLocaleString('en-IN')}, while "${worst.name}" costs ₹${Math.round(worstCpl).toLocaleString('en-IN')} — ${(worstCpl / bestCpl).toFixed(1)}× more.`,
        action: `Shift budget toward "${best.name}" and rebuild or retire the expensive one.`,
      });
    }
  }

  // --- Creative fatigue signal ---
  const weakCtr = rows.filter((r) => r.impressions > 5000 && r.ctr < 0.8);
  if (weakCtr.length) {
    findings.push({
      severity: 'medium',
      title: 'Creative is not earning attention',
      detail: `${weakCtr.length} ${weakCtr.length > 1 ? 'campaigns have' : 'campaign has'} a click-through rate under 0.8% with meaningful reach: ${weakCtr.map((r) => `${r.name} (${r.ctr.toFixed(2)}%)`).join(', ')}.`,
      action: 'Refresh the hook and first frame. Below 0.8% CTR you are paying more per click for the same audience.',
    });
  }

  // --- Lead quality, when the sheet provides it ---
  const withQuality = rows.filter((r) => r.qualified != null && (r.hasCrm || r.sheetLeads));
  if (withQuality.length) {
    const qualified = withQuality.reduce((s, r) => s + (r.qualified || 0), 0);
    const leads = withQuality.reduce((s, r) => s + r.leads, 0);
    const rate = pct(qualified, leads);
    if (leads > 0 && rate < 30) {
      findings.push({
        severity: 'high',
        title: `Only ${rate.toFixed(0)}% of leads are qualifying`,
        detail: `${qualified} of ${leads} leads were marked qualified. Cheap leads that never qualify cost more than expensive ones that do.`,
        action: client?.goals?.goals?.[0]?.label === 'Maximise qualified leads'
          ? 'The campaign is already optimising for qualified leads — feed conversions back to Meta so it learns which leads were good.'
          : 'Switch the ad set optimisation goal to Maximise qualified leads, and send your qualified status back to Meta via the Conversions API.',
      });
    }

    // Which campaign actually produces closures, not just leads
    const closers = withQuality.filter((r) => r.closed > 0);
    if (closers.length) {
      const bestCloser = closers.reduce((a, b) =>
        a.spend / a.closed <= b.spend / b.closed ? a : b,
      );
      findings.push({
        severity: 'info',
        title: 'Cheapest campaign per closed deal',
        detail: `"${bestCloser.name}" closes at ₹${Math.round(bestCloser.spend / bestCloser.closed).toLocaleString('en-IN')} per deal.`,
        action: 'Judge budget by this number, not by cost per lead.',
      });
    }
  } else if (!t.hasCrm) {
    findings.push({
      severity: 'medium',
      title: 'Lead quality is not being tracked',
      detail: 'No qualified/closed status is reaching this report, so cost per qualified lead and cost per closure cannot be calculated.',
      action: 'Sync lead status back to Meta from your CRM, or add Status and Campaign columns to this client\'s lead sheet.',
    });
  }

  // --- How much of the lead volume never even gets reached ---
  if (t.hasCrm) {
    const statusedLeads = t.crmTotal || 0;
    const wasted = (t.junk || 0) + (t.disqualified || 0);
    const cold = t.unreached || 0;

    if (statusedLeads && wasted / statusedLeads > 0.35) {
      findings.push({
        severity: 'high',
        title: `${pct(wasted, statusedLeads).toFixed(0)}% of leads are junk or disqualified`,
        detail: `${wasted} of ${statusedLeads} statused leads went nowhere. At ₹${Math.round(t.cpl).toLocaleString('en-IN')} per lead that is roughly ₹${Math.round(wasted * t.cpl).toLocaleString('en-IN')} of spend on leads your team could not use.`,
        action: 'Tighten targeting and add a qualifying question to the lead form. Higher CPL with better qualification usually beats cheap volume.',
      });
    }

    if (statusedLeads && cold / statusedLeads > 0.2) {
      findings.push({
        severity: 'medium',
        title: `${pct(cold, statusedLeads).toFixed(0)}% of leads were never reached`,
        detail: `${cold} leads are sitting at "no response" or "RNR" — they were paid for but never spoken to.`,
        action: 'Speed up first-call time and add a WhatsApp follow-up. This is the cheapest lead source you already own.',
      });
    }

    if (statusedLeads && t.leads > statusedLeads * 1.3) {
      findings.push({
        severity: 'medium',
        title: 'Some leads never get a status',
        detail: `Meta recorded ${num0(t.leads)} leads but only ${num0(statusedLeads)} came back with a CRM status — ${num0(t.leads - statusedLeads)} are unaccounted for.`,
        action: 'Every lead without a status is invisible to both you and Meta\'s bidding. Make status mandatory in the CRM.',
      });
    }
  }

  // --- Projection: what the same spend buys at your better efficiency ---
  let projection = null;
  if (earners.length) {
    const cpls = earners.map((r) => r.spend / r.leads);
    const bestCpl = Math.min(...cpls);
    const medianCpl = median(cpls);
    const targetCpl = bestCpl * (1 + SCALING_PENALTY);

    // Spend currently sitting in campaigns worse than the median, plus everything
    // producing nothing at all, is what could realistically be moved.
    const movable =
      deadSpend +
      earners
        .filter((r) => r.spend / r.leads > medianCpl)
        .reduce((s, r) => s + (r.spend - r.leads * medianCpl), 0);

    if (movable > 0 && targetCpl > 0) {
      const keptLeads = t.leads - 0;
      const extraLeads = movable / targetCpl;
      const projectedLeads = keptLeads + extraLeads;
      projection = {
        movable,
        currentLeads: t.leads,
        currentCpl: t.cpl,
        projectedLeads,
        projectedCpl: projectedLeads ? t.spend / projectedLeads : 0,
        upliftPct: pct(projectedLeads - t.leads, t.leads || 1),
        assumptions: [
          `Same total spend of ₹${Math.round(t.spend).toLocaleString('en-IN')} — nothing extra invested.`,
          `₹${Math.round(movable).toLocaleString('en-IN')} moved out of below-median campaigns and zero-lead campaigns.`,
          `Reallocated budget performs at ₹${Math.round(targetCpl).toLocaleString('en-IN')} per lead — your best campaign's ₹${Math.round(bestCpl).toLocaleString('en-IN')} plus a ${SCALING_PENALTY * 100}% penalty for scaling.`,
          'Creative, offer and landing page stay as they are.',
          'Campaigns are treated as interchangeable. They often are not — a cheap hiring or awareness campaign is not a substitute for customer acquisition, so check the winner is chasing the same outcome before moving budget into it.',
        ],
      };
    }
  }

  return { findings, projection, platform };
}

export function analyse(client) {
  const meta = analyseChannel(client.meta, 'Meta Ads', client);
  const google = analyseChannel(client.googleAds, 'Google Ads', client);

  const findings = [...meta.findings, ...google.findings];
  const order = { critical: 0, high: 1, medium: 2, info: 3 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return {
    findings,
    projections: [meta, google]
      .filter((c) => c.projection)
      .map((c) => ({ platform: c.platform, ...c.projection })),
  };
}
