const TEMPO_MAP = {
  '30 min': 0.5,
  '1 hora': 1,
  '2 horas': 2,
  '3 horas': 3,
  '4 horas': 4,
  '5 horas': 5,
  '6 horas': 6,
  '7 horas': 7,
  '15 horas': 15,
};

function parseTempo(raw) {
  if (!raw) return null;
  return TEMPO_MAP[raw.toLowerCase()] ?? null;
}

function emailType(email) {
  const d = (email || '').toLowerCase();
  if (d.includes('@aluno.')) return 'aluno';
  return 'staff';
}

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

  const { year, month } = req.query;

  // ── Fetch all pages (paginated) ─────────────────────────────────────────
  let pages = [];
  let cursor;
  do {
    const body = {
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

  // ── Parse all records ───────────────────────────────────────────────────
  const records = pages.map(p => {
    const props = p.properties;
    const dateStr = props['Data Start']?.date?.start || '';
    return {
      status:  props['Status']?.select?.name || '',
      machine: props['Machine Type']?.select?.name || 'OUTROS',
      email:   props['Contato']?.email || '',
      aluno:   props['Nome do Aluno']?.rich_text?.[0]?.plain_text || '—',
      projeto: props['Name do Projeto']?.title?.[0]?.plain_text || '—',
      tempo:   parseTempo(props['Tempo Previsto']?.select?.name),
      dateStr,
      yearMonth: dateStr.slice(0, 7), // "2026-04"
    };
  }).filter(r => r.dateStr);

  // ── Available months (for dropdown) ────────────────────────────────────
  const monthSet = [...new Set(records.map(r => r.yearMonth))].sort().reverse();

  // ── If no month requested, return just the months list ──────────────────
  if (!year || !month) {
    return res.status(200).json({ availableMonths: monthSet, data: null });
  }

  const targetYM = `${year}-${String(month).padStart(2, '0')}`;
  const filtered = records.filter(r => r.yearMonth === targetYM);

  // ── Metrics ─────────────────────────────────────────────────────────────
  const total = filtered.length;

  // By equipment
  const byEquip = {};
  filtered.forEach(r => {
    if (!byEquip[r.machine]) byEquip[r.machine] = { count: 0, totalTempo: 0, tempoCount: 0 };
    byEquip[r.machine].count++;
    if (r.tempo !== null) {
      byEquip[r.machine].totalTempo += r.tempo;
      byEquip[r.machine].tempoCount++;
    }
  });
  const equipList = Object.entries(byEquip)
    .map(([machine, d]) => ({
      machine,
      count: d.count,
      avgTempo: d.tempoCount > 0 ? Math.round((d.totalTempo / d.tempoCount) * 10) / 10 : null,
      totalTempo: d.totalTempo,
    }))
    .sort((a, b) => b.count - a.count);

  // Alunos vs Staff
  let alunos = 0, staff = 0;
  const alunosSet = new Set(), staffSet = new Set();
  filtered.forEach(r => {
    if (emailType(r.email) === 'aluno') { alunos++; alunosSet.add(r.email); }
    else                                 { staff++;  staffSet.add(r.email); }
  });

  // Avg tempo overall
  const withTempo = filtered.filter(r => r.tempo !== null);
  const avgTempoGeral = withTempo.length > 0
    ? Math.round((withTempo.reduce((s, r) => s + r.tempo, 0) / withTempo.length) * 10) / 10
    : null;
  const totalHoras = withTempo.reduce((s, r) => s + r.tempo, 0);

  // Sessions list
  const sessions = filtered.map(r => ({
    aluno: r.aluno,
    email: r.email,
    machine: r.machine,
    projeto: r.projeto,
    tempo: r.tempo,
    status: r.status,
    date: r.dateStr,
    tipo: emailType(r.email),
  }));

  return res.status(200).json({
    availableMonths: monthSet,
    data: {
      yearMonth: targetYM,
      total,
      totalHoras,
      avgTempoGeral,
      equipList,
      alunos,
      staff,
      alunosUnicos: alunosSet.size,
      staffUnicos: staffSet.size,
      sessions,
    }
  });
}
