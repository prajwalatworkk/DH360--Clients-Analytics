// What the campaigns are actually told to optimise for. This is the difference between
// "maximise leads" and "maximise qualified leads", and it changes how the numbers below
// should be read — so the report states it at the top instead of leaving it implicit.

const OPTIMIZATION_GOALS = {
  LEAD_GENERATION: 'Maximise leads',
  QUALITY_LEAD: 'Maximise qualified leads',
  QUALITY_CALL: 'Maximise quality calls',
  OFFSITE_CONVERSIONS: 'Maximise website conversions',
  CONVERSATIONS: 'Maximise conversations',
  LINK_CLICKS: 'Maximise link clicks',
  LANDING_PAGE_VIEWS: 'Maximise landing page views',
  IMPRESSIONS: 'Maximise impressions',
  REACH: 'Maximise reach',
  THRUPLAY: 'Maximise video plays',
  POST_ENGAGEMENT: 'Maximise engagement',
};

const OBJECTIVES = {
  OUTCOME_LEADS: 'Leads',
  OUTCOME_SALES: 'Sales',
  OUTCOME_TRAFFIC: 'Traffic',
  OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_AWARENESS: 'Awareness',
  OUTCOME_APP_PROMOTION: 'App promotion',
};

export async function fetchMetaGoals(accountId, campaignIds = []) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return null;
  const version = process.env.META_API_VERSION || 'v21.0';

  async function get(edge, fields) {
    const url = new URL(`https://graph.facebook.com/${version}/${accountId}/${edge}`);
    url.searchParams.set('fields', fields);
    url.searchParams.set('limit', '500');
    url.searchParams.set('access_token', token);
    const res = await fetch(url);
    const body = await res.json();
    return res.ok ? body.data || [] : [];
  }

  const [campaigns, adsets] = await Promise.all([
    get('campaigns', 'id,name,objective,effective_status'),
    get('adsets', 'id,campaign_id,optimization_goal,effective_status'),
  ]);

  const wanted = new Set(campaignIds);
  const inScope = (id) => !wanted.size || wanted.has(String(id));

  // Count each goal by how many ad sets carry it, so the headline reflects the
  // dominant setting rather than one stray ad set.
  const goalCounts = {};
  for (const set of adsets) {
    if (!inScope(set.campaign_id)) continue;
    if (set.effective_status !== 'ACTIVE') continue;
    const label = OPTIMIZATION_GOALS[set.optimization_goal] || set.optimization_goal;
    if (label) goalCounts[label] = (goalCounts[label] || 0) + 1;
  }

  // If nothing is live right now, fall back to every ad set so the report still
  // explains what these campaigns were set up to do.
  if (!Object.keys(goalCounts).length) {
    for (const set of adsets) {
      if (!inScope(set.campaign_id)) continue;
      const label = OPTIMIZATION_GOALS[set.optimization_goal] || set.optimization_goal;
      if (label) goalCounts[label] = (goalCounts[label] || 0) + 1;
    }
  }

  const objectives = new Set();
  for (const c of campaigns) {
    if (!inScope(c.id)) continue;
    const label = OBJECTIVES[c.objective] || c.objective;
    if (label) objectives.add(label);
  }

  const goals = Object.entries(goalCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => ({ label, count }));

  if (!goals.length && !objectives.size) return null;
  return { goals, objectives: [...objectives] };
}
