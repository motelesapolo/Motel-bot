// ============================================
// index.js - Bot de WhatsApp para Motel (Chile)
// ============================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { procesarMensaje, limpiarConversacion } = require('./ia');
const { iniciarRecordatorios } = require('./recordatorios');

// ── Servidor Express ─────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

let qrActual = null;
let botConectado = false;
let botPausado = false; // ← Control de pausa

app.get('/', (req, res) => {
  if (botConectado) {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>${botPausado ? '⏸️ Bot Pausado' : '✅ Bot Conectado'}</h1>
        <p>${botPausado ? 'El bot está pausado. Estás respondiendo manualmente.' : 'El bot está activo y recibiendo mensajes.'}</p>
        <p>${process.env.MOTEL_NOMBRE}</p>
      </body></html>
    `);
  } else if (qrActual) {
    res.send(`
      <html>
      <head>
        <title>Escanear QR - Bot Motel</title>
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
        <style>
          body { font-family:sans-serif; text-align:center; padding:30px; background:#111; color:#fff; }
          #qrcode { display:inline-block; background:#fff; padding:20px; border-radius:10px; margin:20px; }
          h2 { color:#25D366; }
        </style>
      </head>
      <body>
        <h2>📱 Escanea este QR con WhatsApp</h2>
        <p>WhatsApp → tres puntos → Dispositivos vinculados → Vincular dispositivo</p>
        <div id="qrcode"></div>
        <p style="color:#ff9800">⚠️ El QR expira en 60 segundos. Recarga si no funciona.</p>
        <script>
          new QRCode(document.getElementById("qrcode"), {
            text: "${qrActual}",
            width: 300,
            height: 300,
            colorDark: "#000000",
            colorLight: "#ffffff",
          });
        </script>
      </body></html>
    `);
  } else {
    res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
        <h1>⏳ Iniciando bot...</h1>
        <p>Espera unos segundos y recarga la página.</p>
        <script>setTimeout(()=>location.reload(), 3000)</script>
      </body></html>
    `);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, conectado: botConectado, pausado: botPausado }));

app.listen(PORT, () => {
  console.log(`🌐 Servidor web activo en puerto ${PORT}`);
});

// ── Cliente de WhatsApp ───────────────────────────────────────
const cliente = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
  },
});

// ── Eventos ───────────────────────────────────────────────────
cliente.on('qr', (qr) => {
  console.log('📱 QR generado - abre la URL del servicio en Railway para escanearlo');
  qrActual = qr;
  botConectado = false;
});

cliente.on('authenticated', () => {
  console.log('✅ WhatsApp autenticado correctamente');
  qrActual = null;
});

cliente.on('ready', () => {
  console.log(`\n🏨 ${process.env.MOTEL_NOMBRE || 'Bot Motel'} - LISTO`);
  botConectado = true;
  qrActual = null;
  iniciarRecordatorios(cliente);
});

cliente.on('auth_failure', (msg) => {
  console.error('❌ Error de autenticación:', msg);
});

cliente.on('disconnected', (reason) => {
  console.log('📵 Desconectado:', reason);
  botConectado = false;
  setTimeout(() => cliente.initialize(), 10000);
});

// ── Mensajes ──────────────────────────────────────────────────
cliente.on('message', async (mensaje) => {
  if (mensaje.from.includes('@g.us')) return;
  if (mensaje.fromMe) return;
  if (mensaje.from === 'status@broadcast') return;

  const telefono = mensaje.from.replace('@c.us', '');
  const texto = mensaje.body?.trim();
  if (!texto) return;

  console.log(`📩 [${new Date().toLocaleTimeString('es-CL')}] De ${telefono}: ${texto}`);

  // ── Comandos Admin ──────────────────────────────────────────
  const ADMIN_NUMERO = process.env.ADMIN_NUMERO || '';
  if (telefono === ADMIN_NUMERO) {
    if (texto === '/pause') {
      botPausado = true;
      await mensaje.reply('⏸️ *Bot pausado.* Ahora puedes responder tú manualmente.\nEscribe /resume para reactivarlo.');
      console.log('⏸️ Bot pausado por admin');
      return;
    }
    if (texto === '/resume') {
      botPausado = false;
      await mensaje.reply('▶️ *Bot reactivado.* Vuelve a responder automáticamente.');
      console.log('▶️ Bot reactivado por admin');
      return;
    }
    if (texto === '/estado') {
      const estado = botPausado ? '⏸️ PAUSADO' : '✅ ACTIVO';
      await mensaje.reply(`${estado}\n🏨 ${process.env.MOTEL_NOMBRE}\n⏰ ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}\n\nComandos:\n/pause - Pausar bot\n/resume - Reactivar bot\n/limpiar - Reiniciar conversación`);
      return;
    }
    if (texto === '/limpiar') {
      limpiarConversacion(telefono);
      await mensaje.reply('🧹 Conversación reiniciada.');
      return;
    }
  }

  // ── Si está pausado, no responder ───────────────────────────
  if (botPausado) {
    console.log(`⏸️ Bot pausado - mensaje de ${telefono} ignorado`);
    return;
  }

  // ── Responder con IA ────────────────────────────────────────
  const chat = await mensaje.getChat();
  await chat.sendStateTyping();

  try {
    const respuesta = await procesarMensaje(telefono, texto);
    const pausa = Math.floor(Math.random() * 1000) + 800;
    await new Promise(r => setTimeout(r, pausa));
    await mensaje.reply(respuesta);
    console.log(`📤 Respuesta enviada a ${telefono}`);
  } catch (error) {
    console.error('Error:', error);
    await mensaje.reply('😔 Error técnico. Contáctanos al ' + (process.env.MOTEL_TELEFONO || '') + '.');
  } finally {
    await chat.clearState();
  }
});

// ── Iniciar ───────────────────────────────────────────────────
console.log(`🚀 Iniciando bot...`);
console.log(`🏨 Motel: ${process.env.MOTEL_NOMBRE || 'Sin configurar'}`);
console.log('━'.repeat(50));

cliente.initialize().catch(err => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Error no manejado:', reason);
});
