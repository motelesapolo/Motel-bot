// ============================================
// setup-google.js - Configurar Google Calendar
// Ejecutar UNA VEZ: node setup-google.js
// ============================================
require('dotenv').config();
const { google } = require('googleapis');
const readline = require('readline');

const oAuth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'urn:ietf:wg:oauth:2.0:oob' // Para obtener código manualmente
);

const SCOPES = ['https://www.googleapis.com/auth/calendar'];

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n' + '═'.repeat(60));
console.log('🔑 CONFIGURACIÓN DE GOOGLE CALENDAR');
console.log('═'.repeat(60));
console.log('\n1. Abre este enlace en tu navegador:\n');
console.log(authUrl);
console.log('\n2. Inicia sesión con tu cuenta de Google');
console.log('3. Autoriza los permisos');
console.log('4. Copia el código que aparece en pantalla');
console.log('\n' + '─'.repeat(60));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question('\nPega el código aquí: ', async (code) => {
  rl.close();
  try {
    const { tokens } = await oAuth2Client.getToken(code.trim());
    console.log('\n' + '═'.repeat(60));
    console.log('✅ ¡ÉXITO! Agrega esto a tu archivo .env:');
    console.log('─'.repeat(60));
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('═'.repeat(60));
    console.log('\n⚠️  Guarda el REFRESH_TOKEN, solo se muestra una vez.');
  } catch (err) {
    console.error('\n❌ Error:', err.message);
    console.log('Verifica que GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET estén correctos en .env');
  }
});
