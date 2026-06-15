export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body;
  const REPORT_PASSWORD = process.env.REPORT_PASSWORD;

  if (!REPORT_PASSWORD) return res.status(500).json({ error: 'Senha não configurada no servidor.' });
  if (!password || password !== REPORT_PASSWORD) {
    return res.status(401).json({ error: 'Senha incorreta.' });
  }

  return res.status(200).json({ ok: true });
}
