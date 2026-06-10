export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nome, email, turma, equipamento, nomeProjeto, descricao, dataCheckin, fileBase64, fileName, fileMime } = req.body;

  if (!nome || !email || !equipamento || !nomeProjeto) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes.' });
  }

  const NOTION_TOKEN    = process.env.NOTION_TOKEN;
  const NOTION_DB_ID    = process.env.NOTION_DB_ID;
  const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
  const DRIVE_SA_EMAIL  = process.env.DRIVE_SA_EMAIL;
  const DRIVE_SA_KEY    = process.env.DRIVE_SA_KEY;

  if (!NOTION_TOKEN || !NOTION_DB_ID) {
    return res.status(500).json({ error: 'Variáveis Notion não configuradas.' });
  }

  // ── 1. GOOGLE DRIVE UPLOAD ──────────────────────────────────────────────
  let driveFileUrl = null;

  if (fileBase64 && fileName && DRIVE_SA_EMAIL && DRIVE_SA_KEY && DRIVE_FOLDER_ID) {
    try {
      // Get OAuth token via JWT
      const token = await getGoogleToken(DRIVE_SA_EMAIL, DRIVE_SA_KEY);

      // Build folder path: DRIVE_FOLDER_ID/2026.06/ana.lima/Equipamento/
      const now = new Date(dataCheckin || Date.now());
      const monthFolder = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}`;
      const userFolder  = email.split('@')[0].toLowerCase();
      const equipFolder = equipamento;

      const folderId = await ensureFolderPath(token, DRIVE_FOLDER_ID, [monthFolder, userFolder, equipFolder]);

      // Upload file
      const fileBuffer = Buffer.from(fileBase64, 'base64');
      const boundary   = 'lsb_boundary_' + Date.now();
      const mimeType   = fileMime || 'application/octet-stream';

      const metadata = JSON.stringify({ name: fileName, parents: [folderId] });

      const multipart = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
        Buffer.from(metadata),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n`),
        Buffer.from(fileBase64),
        Buffer.from(`\r\n--${boundary}--`)
      ]);

      const uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': multipart.length
          },
          body: multipart
        }
      );

      const uploadData = await uploadRes.json();
      if (uploadRes.ok) {
        driveFileUrl = uploadData.webViewLink;
      } else {
        console.error('Drive upload error:', JSON.stringify(uploadData));
      }
    } catch (driveErr) {
      console.error('Drive error:', driveErr.message);
      // Don't fail the whole request if Drive fails
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
    properties["Arquivos"] = {
      url: driveFileUrl
    };
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
      driveFileUrl
    });

  } catch (err) {
    return res.status(500).json({ error: 'Erro interno: ' + err.message });
  }
}

// ── GOOGLE AUTH (JWT → access token) ──────────────────────────────────────
async function getGoogleToken(clientEmail, privateKeyPem) {
  const now  = Math.floor(Date.now() / 1000);
  const claim = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  };

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const sigInput = `${header}.${payload}`;

  // Import private key and sign
  const keyData = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');

  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(sigInput)
  );

  const signature = b64url(sigBuffer);
  const jwt = `${sigInput}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Falha ao obter token Google: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── ENSURE FOLDER PATH ─────────────────────────────────────────────────────
async function ensureFolderPath(token, rootId, parts) {
  let parentId = rootId;
  for (const part of parts) {
    parentId = await findOrCreateFolder(token, parentId, part);
  }
  return parentId;
}

async function findOrCreateFolder(token, parentId, name) {
  // Search for existing folder
  const q = encodeURIComponent(`name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`);
  const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  const searchData = await searchRes.json();

  if (searchData.files && searchData.files.length > 0) {
    return searchData.files[0].id;
  }

  // Create folder
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const createData = await createRes.json();
  return createData.id;
}

// ── BASE64URL ──────────────────────────────────────────────────────────────
function b64url(data) {
  const str = typeof data === 'string' ? data : String.fromCharCode(...new Uint8Array(data));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
