export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nome, email, turma, equipamento, nomeProjeto, descricao, dataCheckin } = req.body;

  if (!nome || !email || !equipamento || !nomeProjeto) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const NOTION_DB_ID = process.env.NOTION_DB_ID;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas.' });
  }

  const properties = {
    "Name do Projeto": {
      title: [{ text: { content: nomeProjeto } }]
    },
    "Nome do Aluno": {
      rich_text: [{ text: { content: nome } }]
    },
    "Contato": {
      email: email
    },
    "Machine Type": {
      select: { name: equipamento }
    },
    "Status": {
      select: { name: "Agendada" }
    }
  };

  if (descricao) {
    properties["Materiais"] = {
      rich_text: [{ text: { content: descricao } }]
    };
  }

  if (dataCheckin) {
    properties["Data Start"] = {
      date: { start: dataCheckin }
    };
  }

  const body = {
    parent: { database_id: NOTION_DB_ID },
    properties
  };

  try {
    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify(body)
    });

    const data = await notionRes.json();

    if (!notionRes.ok) {
      console.error('Notion API error:', JSON.stringify(data, null, 2));
      return res.status(500).json({
        error: data.message || 'Erro ao criar card no Notion.',
        code: data.code,
        detail: data
      });
    }

    return res.status(200).json({ success: true, notionPageId: data.id });

  } catch (err) {
    console.error('Fetch error:', err.message);
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}
