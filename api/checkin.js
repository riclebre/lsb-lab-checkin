export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    nome,
    email,
    turma,
    equipamento,
    nomeProjeto,
    descricao,
    dataCheckin
  } = req.body;

  if (!nome || !email || !equipamento || !nomeProjeto) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const NOTION_TOKEN   = process.env.NOTION_TOKEN;
  const NOTION_DB_ID   = process.env.NOTION_DB_ID;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ error: 'Variáveis de ambiente não configuradas.' });
  }

  // Monta o card do Notion
  const body = {
    parent: { database_id: NOTION_DB_ID },
    properties: {
      // Título principal
      "Nome do Projeto": {
        title: [{ text: { content: nomeProjeto } }]
      },
      // Status inicial sempre "Agendada"
      "Status": {
        status: { name: "Agendada" }
      },
      // Nome do aluno
      "Nome do Aluno": {
        rich_text: [{ text: { content: nome } }]
      },
      // E-mail
      "Contato": {
        email: email
      },
      // Descrição como materiais/notas
      "Materiais": {
        rich_text: [{ text: { content: descricao || '' } }]
      },
      // Equipamento
      "Machine Type": {
        select: { name: equipamento }
      },
      // Data do check-in
      "Data Start": {
        date: { start: dataCheckin }
      }
    }
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
      console.error('Notion error:', data);
      return res.status(500).json({ error: 'Erro ao criar card no Notion.', detail: data });
    }

    return res.status(200).json({
      success: true,
      notionPageId: data.id,
      notionUrl: data.url
    });

  } catch (err) {
    console.error('Server error:', err);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
}
