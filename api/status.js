export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ error: 'Variáveis Notion não configuradas.' });
  }

  const today30 = new Date();
  today30.setDate(today30.getDate() - 30);
  const since = today30.toISOString().split('T')[0];
  const todayStr = new Date().toISOString().split('T')[0];

  // Fetch all pages from last 30 days (paginated)
  let pages = [];
  let cursor = undefined;
  do {
    const body = {
      filter: {
        property: 'Data Start',
        date: { on_or_after: since }
      },
      sorts: [{ property: 'Data Start', direction: 'descending' }],
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {})
    };

    const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(body)
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.message });

    pages = pages.concat(data.results);
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  // Parse pages
  const records = pages.map(p => {
    const props = p.properties;
    const status   = props['Status']?.select?.name || '';
    const machine  = props['Machine Type']?.select?.name || 'OUTROS';
    const aluno    = props['Nome do Aluno']?.rich_text?.[0]?.plain_text || '—';
    const projeto  = props['Name do Projeto']?.title?.[0]?.plain_text || '—';
    const dateStr  = props['Data Start']?.date?.start || '';
    return { status, machine, aluno, projeto, dateStr };
  });

  // Today's metrics
  const todayRecords = records.filter(r => r.dateStr === todayStr);
  const checkinHoje   = todayRecords.length;
  const naFila        = records.filter(r => r.status === 'Agendada').length;
  const emExecucao    = records.filter(r => r.status === 'Em execução').length;
  const concluidos    = records.filter(r => r.status === 'Concluída' && r.dateStr === todayStr).length;

  // Queue: Agendada + Em execução (most recent first, up to 20)
  const queue = records
    .filter(r => r.status === 'Agendada' || r.status === 'Em execução')
    .slice(0, 20)
    .map((r, i) => ({ pos: i + 1, ...r }));

  // Equipment usage last 30 days
  const usageMap = {};
  records.forEach(r => {
    usageMap[r.machine] = (usageMap[r.machine] || 0) + 1;
  });

  const ORDER = ['3D Huguinho', '3D Zezinho', '3D Luizinho', 'ROLAND', 'LASER', 'OUTROS'];
  const usage = ORDER
    .filter(k => usageMap[k] !== undefined)
    .map(k => ({ label: k, val: usageMap[k] }));

  // Include any machine not in ORDER
  Object.keys(usageMap).forEach(k => {
    if (!ORDER.includes(k)) usage.push({ label: k, val: usageMap[k] });
  });

  return res.status(200).json({
    metrics: { checkinHoje, naFila, emExecucao, concluidos },
    queue,
    usage
  });
}
