// Flat CSV of every selected account's campaigns — for when a client wants the raw rows.

const cell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv({ clients, since, until }) {
  const header = [
    'Client', 'Platform', 'Name', 'Belongs to', 'Spend', 'Impressions',
    'Clicks', 'CTR %', 'CPC', 'Leads', 'Cost per lead',
    'Qualified', 'Cost per qualified lead', 'Closed', 'Cost per closure',
    'Pixel events', 'Since', 'Until',
  ];
  const lines = [header.join(',')];

  for (const client of clients) {
    for (const [platform, data] of [['Meta Ads', client.meta], ['Google Ads', client.googleAds]]) {
      if (!data || data.error) continue;
      for (const c of data.campaigns) {
        lines.push(
          [
            client.name, platform, c.name, c.parent || '',
            c.spend.toFixed(2), c.impressions, c.clicks,
            c.ctr.toFixed(2), c.cpc.toFixed(2),
            c.leads, c.leads ? (c.spend / c.leads).toFixed(2) : '',
            c.qualified ?? '', c.qualified ? (c.spend / c.qualified).toFixed(2) : '',
            c.closed ?? '', c.closed ? (c.spend / c.closed).toFixed(2) : '',
            c.pixelLeads ?? '',
            since, until,
          ].map(cell).join(','),
        );
      }
    }
    if (client.leads && !client.leads.error) {
      const t = client.leads.tally || {};
      lines.push(
        [
          client.name, 'Website leads', 'All forms', '', '', '', '', '', '',
          client.leads.count, '', t.qualified ?? '', '', t.closed ?? '', '', '',
          since, until,
        ].map(cell).join(','),
      );
    }
  }

  return lines.join('\n');
}
