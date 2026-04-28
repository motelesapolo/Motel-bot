// ============================================
// setup-sheets-web.js
// Agrega al proyecto, despliega, abre la URL
// del bot + /auth y sigue los pasos
// ============================================
require('dotenv').config();
const { google } = require('googleapis');
const express = require('express');
const app = express();

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : 'http://localhost:3001'}/auth/callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/spreadsheets'
];

app.get('/auth', (req, res) => {
  const url = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff">
        <h2>✅ Autorización exitosa</h2>
        <p>Copia este valor y actualízalo en Railway como <strong>GOOGLE_REFRESH_TOKEN</strong>:</p>
        <textarea style="width:100%;height:80px;background:#222;color:#0f0;padding:10px;font-size:14px">${tokens.refresh_token}</textarea>
        <p style="color:#ff9">Una vez actualizado en Railway, elimina setup-sheets-web.js del proyecto.</p>
      </body></html>
    `);
  } catch (err) {
    res.send(`<html><body style="padding:40px"><h2>❌ Error: ${err.message}</h2></body></html>`);
  }
});

app.get('/', (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
      <h2>🔑 Setup Google Sheets</h2>
      <a href="/auth" style="background:#4CAF50;color:#fff;padding:15px 30px;text-decoration:none;border-radius:8px;font-size:18px">
        Autorizar Google Calendar + Sheets
      </a>
    </body></html>
  `);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🔑 Setup corriendo en puerto ${PORT}`));
