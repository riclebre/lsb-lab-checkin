export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nome, email, turma, equipamento, nomeProjeto, descricao, dataCheckin, driveFileId, fileName } = req.body;

  if (!nome || !email || !equipamento || !nomeProjeto) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const NOTION_TOKEN   = process.env.NOTION_TOKEN;
  const NOTION_DB_ID   = process.env.NOTION_DB_ID;
  const DRIVE_SA_EMAIL = process.env.DRIVE_SA_EMAIL;
  const DRIVE_SA_KEY   = (process.env.DRIVE_SA_KEY || '').replace(/\\n/g, '\n');

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ error: 'Variáveis Notion não configuradas.' });
  }

  // ── 1. GOOGLE DRIVE — set public permission on already-uploaded file ────
  let driveFileUrl = null;
  let driveError   = null;

  if (driveFileId && DRIVE_SA_EMAIL && DRIVE_SA_KEY) {
    try {
      const token = await getGoogleToken(DRIVE_SA_EMAIL, DRIVE_SA_KEY);
      await fetch(`https://www.googleapis.com/drive/v3/files/${driveFileId}/permissions?supportsAllDrives=true`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' })
      });
      driveFileUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
      console.log('Drive permission OK:', driveFileUrl);
    } catch (driveErr) {
      driveError = driveErr.message;
      console.error('Drive permission exception:', driveErr.message);
    }
  }

  // ── 2. NOTION CARD ──────────────────────────────────────────────────────
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
    properties["Materiais"] = { rich_text: [{ text: { content: descricao } }] };
  }
  if (dataCheckin) {
    properties["Data Start"] = { date: { start: dataCheckin } };
  }
  if (driveFileUrl) {
    properties["Arquivos"] = { url: driveFileUrl };
  }

  try {
    const notionRes = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      },
      body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties })
    });

    const data = await notionRes.json();

    if (!notionRes.ok) {
      console.error('Notion error:', JSON.stringify(data, null, 2));
      return res.status(500).json({ error: data.message, code: data.code, detail: data });
    }

    return res.status(200).json({
      success: true,
      notionPageId: data.id,
      driveFileUrl,
      driveError
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}

// ── GOOGLE AUTH ────────────────────────────────────────────────────────────
async function getGoogleToken(clientEmail, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const header   = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload  = b64url(JSON.stringify(claim));
  const sigInput = `${header}.${payload}`;

  const keyData = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${b64url(sigBuffer)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error('Token Google falhou: ' + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

// ── FOLDER HELPERS ─────────────────────────────────────────────────────────
async function ensureFolderPath(token, rootId, parts) {
  let parentId = rootId;
  for (const part of parts) {
    parentId = await findOrCreateFolder(token, parentId, part);
  }
  return parentId;
}

async function findOrCreateFolder(token, parentId, name) {
  const q = encodeURIComponent(
    `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
  );
  const searchRes = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const searchData = await searchRes.json();
  if (searchData.files && searchData.files.length > 0) return searchData.files[0].id;

  const createRes = await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    })
  });
  const createData = await createRes.json();
  if (!createData.id) throw new Error('Falha ao criar pasta: ' + JSON.stringify(createData));
  return createData.id;
}

// ── BASE64URL ──────────────────────────────────────────────────────────────
function b64url(data) {
  const str = typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
