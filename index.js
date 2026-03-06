// ============================================
// index.js - Bot de WhatsApp para Motel (Chile)
// ============================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const { procesarMensaje, limpiarConversacion } = require('./ia');
const { iniciarRecordatorios } = require('./recordatorios');

// ── Servidor Express (necesario para Railway/Render) ─────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    status: '✅ Bot activo',
    motel: process.env.MOTEL_NOMBRE,
    timestamp: new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🌐 Servidor web activo en puerto ${PORT}`);
});

// ── Cliente de WhatsApp ───────────────────────────────────────
const cliente = new Client({
  authStrategy: new LocalAuth({
    dataPath: './session',
  }),
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

// ── Eventos del Cliente ───────────────────────────────────────

// Mostrar QR para conectar WhatsApp
cliente.on('qr', (qr) => {
  console.log('\n📱 Escanea este QR con tu WhatsApp:');
  console.log('   (WhatsApp > Dispositivos vinculados > Vincular dispositivo)\n');
  qrcode.generate(qr, { small: true });
});

// Autenticación exitosa
cliente.on('authenticated', () => {
  console.log('✅ WhatsApp autenticado correctamente');
});

// Bot listo
cliente.on('ready', () => {
  console.log(`\n🏨 ${process.env.MOTEL_NOMBRE || 'Bot Motel'} - LISTO PARA RECIBIR MENSAJES`);
  console.log('━'.repeat(50));
  iniciarRecordatorios(cliente);
});

// Error de autenticación
cliente.on('auth_failure', (msg) => {
  console.error('❌ Error de autenticación:', msg);
});

// Desconexión
cliente.on('disconnected', (reason) => {
  console.log('📵 WhatsApp desconectado:', reason);
  console.log('🔄 Reiniciando en 10 segundos...');
  setTimeout(() => cliente.initialize(), 10000);
});

// ── Procesamiento de Mensajes ─────────────────────────────────
cliente.on('message', async (mensaje) => {
  // Ignorar mensajes de grupos
  if (mensaje.from.includes('@g.us')) return;

  // Ignorar mensajes del propio bot
  if (mensaje.fromMe) return;

  // Ignorar mensajes de estado
  if (mensaje.from === 'status@broadcast') return;

  const telefono = mensaje.from.replace('@c.us', '');
  const texto = mensaje.body?.trim();

  if (!texto) return;

  console.log(`\n📩 [${new Date().toLocaleTimeString('es-CL')}] De ${telefono}: ${texto}`);

  // Comandos especiales (solo para admins)
  const ADMIN_NUMERO = process.env.ADMIN_NUMERO || '';
  if (telefono === ADMIN_NUMERO) {
    if (texto === '/limpiar') {
      limpiarConversacion(telefono);
      await mensaje.reply('🧹 Conversación reiniciada.');
      return;
    }
    if (texto === '/estado') {
      await mensaje.reply(`✅ Bot activo\n🏨 ${process.env.MOTEL_NOMBRE}\n⏰ ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}`);
      return;
    }
  }

  // Mostrar indicador de escritura
  const chat = await mensaje.getChat();
  await chat.sendStateTyping();

  try {
    // Procesar mensaje con IA
    const respuesta = await procesarMensaje(telefono, texto);

    // Pequeña pausa para parecer más natural (1-2 segundos)
    const pausa = Math.floor(Math.random() * 1000) + 800;
    await new Promise(r => setTimeout(r, pausa));

    await mensaje.reply(respuesta);
    console.log(`📤 Respuesta enviada a ${telefono}`);

  } catch (error) {
    console.error('Error procesando mensaje:', error);
    await mensaje.reply(
      '😔 Lo sentimos, ocurrió un error. Por favor intenta nuevamente o contáctanos al ' +
      (process.env.MOTEL_TELEFONO || 'teléfono directo') + '.'
    );
  } finally {
    await chat.clearState();
  }
});

// ── Iniciar Cliente ───────────────────────────────────────────
console.log('🚀 Iniciando bot...');
console.log(`🏨 Motel: ${process.env.MOTEL_NOMBRE || 'Sin configurar'}`);
console.log('━'.repeat(50));

cliente.initialize().catch(err => {
  console.error('Error al iniciar:', err);
  process.exit(1);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason) => {
  console.error('Error no manejado:', reason);
});
