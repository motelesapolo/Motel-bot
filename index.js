// ============================================
// index.js - Bot de WhatsApp para Motel (Chile)
// ============================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente } = require('./ia');
const { iniciarRecordatorios } = require('./recordatorios');

const app = express();
const PORT = process.env.PORT || 3000;

let qrActual = null;
let botConectado = false;
let botPausado = false;
let numeroPrueba = null; // Cuando está activo, solo responde a este número

app.get('/', (req, res) => {
  if (botConectado) {
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
      <h1>${botPausado ? '⏸️ Bot Pausado' : '✅ Bot Conectado'}</h1>
      <p>${botPausado ? 'Respondiendo manualmente.' : 'El bot está activo.'}</p>
      <p>${process.env.MOTEL_NOMBRE}</p>
    </body></html>`);
  } else if (qrActual) {
    res.send(`<html><head><title>QR Bot Motel</title>
      <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      <style>body{font-family:sans-serif;text-align:center;padding:30px;background:#111;color:#fff}
      #qrcode{display:inline-block;background:#fff;padding:20px;border-radius:10px;margin:20px}</style>
      </head><body>
      <h2>📱 Escanea este QR con WhatsApp</h2>
      <p>WhatsApp → tres puntos → Dispositivos vinculados → Vincular dispositivo</p>
      <div id="qrcode"></div>
      <p style="color:#ff9800">⚠️ El QR expira en 60 segundos. Recarga si no funciona.</p>
      <script>new QRCode(document.getElementById("qrcode"),{text:"${qrActual}",width:300,height:300,colorDark:"#000",colorLight:"#fff"});</script>
    </body></html>`);
  } else {
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;background:#111;color:#fff">
      <h1>⏳ Iniciando bot...</h1><p>Recarga en unos segundos.</p>
      <script>setTimeout(()=>location.reload(),3000)</script>
    </body></html>`);
  }
});

app.get('/health', (req, res) => res.json({ ok: true, conectado: botConectado, pausado: botPausado }));
app.listen(PORT, () => console.log(`🌐 Servidor web activo en puerto ${PORT}`));

// ── Cliente WhatsApp ──────────────────────────────────────────
const cliente = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process','--disable-gpu'],
  },
});

cliente.on('qr', (qr) => { qrActual = qr; botConectado = false; console.log('📱 QR generado - abre la URL de Railway'); });
cliente.on('authenticated', () => { qrActual = null; console.log('✅ WhatsApp autenticado'); });
cliente.on('ready', () => {
  console.log(`🏨 ${process.env.MOTEL_NOMBRE} - LISTO`);
  botConectado = true; qrActual = null;
  setClienteWhatsApp(cliente);
  iniciarRecordatorios(cliente);
});
cliente.on('auth_failure', (msg) => console.error('❌ Auth failure:', msg));
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

  const ADMINS = [process.env.ADMINS[0], '56991655665'].filter(Boolean);

  // ── Comandos Admin ────────────────────────────────────────
  if (ADMINS.includes(telefono)) {
    if (texto === '/desactivar') {
      botPausado = true;
      await mensaje.reply('⏸️ *Bot pausado globalmente.* Responde tú manualmente.\nEscribe /activar para reactivar.');
      return;
    }
    if (texto === '/activar') {
      botPausado = false;
      await mensaje.reply('▶️ *Bot reactivado.* Vuelve a responder automáticamente.');
      return;
    }
    // Modo prueba - solo responde al número especificado
    if (texto.startsWith('/prueba')) {
      const num = texto.split(' ')[1];
      if (num) {
        numeroPrueba = num.replace('+', '').replace(/\s/g, '');
        await mensaje.reply(`🧪 *Modo prueba activado*\nSolo responderé al número: +${numeroPrueba}\nPara desactivar escribe /prueba_off`);
      } else {
        await mensaje.reply('❌ Debes indicar el número. Ejemplo: /prueba +56912345678');
      }
      return;
    }

    if (texto === '/prueba_off') {
      numeroPrueba = null;
      await mensaje.reply('✅ *Modo prueba desactivado*\nEl bot responde a todos normalmente.');
      return;
    }

    if (texto === '/estado') {
      await mensaje.reply(`${botPausado ? '⏸️ PAUSADO' : '✅ ACTIVO'}${numeroPrueba ? `\n🧪 MODO PRUEBA: solo +${numeroPrueba}` : ''}\n🏨 ${process.env.MOTEL_NOMBRE}\n⏰ ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}\n\nComandos disponibles:\n/desactivar - Pausar bot\n/activar - Reactivar bot\n/limpiar - Reiniciar tu conversación\n/activar_cliente NUMERO - Reactivar bot para un cliente`);
      return;
    }
    if (texto === '/limpiar') {
      limpiarConversacion(telefono);
      await mensaje.reply('🧹 Conversación reiniciada.');
      return;
    }
    // Reactivar bot para cliente específico
    if (texto.startsWith('/activar_cliente')) {
      const numeroCliente = texto.split(' ')[1];
      if (numeroCliente) {
        reactivarCliente(numeroCliente);
        await mensaje.reply(`✅ Bot reactivado para el cliente ${numeroCliente}. Volverá a responder automáticamente.`);
      } else {
        await mensaje.reply('⚠️ Uso: /resume_cliente 56912345678');
      }
      return;
    }
  }

  // Si está pausado globalmente, no responder
  if (botPausado) {
    console.log(`⏸️ Bot pausado - mensaje de ${telefono} ignorado`);
    return;
  }

  const chat = await mensaje.getChat();
  await chat.sendStateTyping();

  try {
    const respuesta = await procesarMensaje(telefono, texto);
    
    // Si es null, el cliente está esperando agente - no responder
    if (respuesta === null) {
      await chat.clearState();
      return;
    }

    const pausa = Math.floor(Math.random() * 1000) + 800;
    await new Promise(r => setTimeout(r, pausa));
    await mensaje.reply(respuesta);
    console.log(`📤 Respuesta enviada a ${telefono}`);
  } catch (error) {
    console.error('Error:', error);
    await mensaje.reply('😔 Estamos teniendo un problema técnico. Te conectamos con un agente en breve 😊');
  } finally {
    await chat.clearState();
  }
});

console.log(`🚀 Iniciando bot...`);
console.log(`🏨 Motel: ${process.env.MOTEL_NOMBRE || 'Sin configurar'}`);
console.log('━'.repeat(50));

cliente.initialize().catch(err => { console.error('Error al iniciar:', err); process.exit(1); });
process.on('unhandledRejection', (reason) => console.error('Error no manejado:', reason));
