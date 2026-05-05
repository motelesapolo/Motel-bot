// ============================================
// index.js - Bot de WhatsApp para Motel (Chile)
// ============================================
require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente, bloquearHabitacion, liberarHabitacion, getEstadoBloqueos } = require('./ia');
const { iniciarRecordatorios } = require('./recordatorios');

const app = express();
const PORT = process.env.PORT || 3000;

let qrActual = null;
let botConectado = false;
let botPausado = false;
let numeroPrueba = null; // Cuando está activo, solo responde a este número
const pausasPorAdmin = new Map(); // telefono → timestamp de pausa por respuesta admin

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
  if (reason === 'LOGOUT') {
    console.log('🔄 LOGOUT detectado — limpiando sesión...');
    const fs = require('fs');
    const path = require('path');
    try {
      fs.rmSync(path.join(__dirname, 'session'), { recursive: true, force: true });
      console.log('🗑️ Sesión eliminada');
    } catch (e) { console.error('Error eliminando sesión:', e.message); }
  }
  setTimeout(() => cliente.initialize(), 10000);
});

// ── Mensajes ──────────────────────────────────────────────────
cliente.on('message', async (mensaje) => {
  if (mensaje.from.includes('@g.us')) return;
  if (mensaje.fromMe) {
    // Si el admin responde a un cliente, pausar el bot para ese cliente 10 minutos
    const destinatario = (mensaje.to || '').replace('@c.us', '').replace('@lid', '');
    if (destinatario && !destinatario.includes('@g.us')) {
      pausasPorAdmin.set(destinatario, Date.now());
      console.log(`⏸️ Bot pausado 10min para ${destinatario} — admin respondió`);
    }
    return;
  }
  if (mensaje.from === 'status@broadcast') return;
  // Filtrar newsletters, canales y mensajes de sistema que no tienen estructura normal
  if (mensaje.from.includes('@newsletter')) return;
  if (mensaje.type === 'e2e_notification' || mensaje.type === 'notification_template') return;
  if (!mensaje.from || !mensaje.body === undefined) return;

  const rawFrom = mensaje.from || '';
  let telefono = rawFrom.replace('@c.us', '').replace('@lid', '');
  // Ignorar mensajes del número del motel
  const NUMERO_MOTEL = (process.env.EMPRESA_NUMERO || '56945676410');
  if (telefono === NUMERO_MOTEL) return;
  // Mapear LIDs conocidos al número real
  const LID_MAP = { '202902928908358': '56991655665', '217274023702535': process.env.ADMIN_NUMERO || '56949716039' };
  if (LID_MAP[telefono]) telefono = LID_MAP[telefono];
  // Detectar mensaje de voz (ptt = push-to-talk) o audio
  if (mensaje.type === 'ptt' || mensaje.type === 'audio') {
    console.log(`🎤 Mensaje de voz de ${telefono} - respondiendo automáticamente`);
    await mensaje.reply('Hola 👋 Lo sentimos, no podemos atender mensajes de voz. Por favor escríbenos tu consulta y con gusto te ayudamos 😊');
    return;
  }

  // Ignorar mensajes que son solo imagen/video/sticker sin texto
  if ((mensaje.type === 'image' || mensaje.type === 'video' || mensaje.type === 'sticker') && !mensaje.body?.trim()) return;

  const texto = mensaje.body?.trim();
  if (!texto) return;

  // Si el cliente hace reply a una imagen preguntando por disponibilidad específica
  if (mensaje.hasQuotedMsg) {
    const quoted = await mensaje.getQuotedMessage().catch(() => null);
    if (quoted && quoted.type === 'image' && quoted.fromMe) {
      // Solo transferir si pregunta por habitación específica (disponibilidad, número, etc.)
      const textLower = texto.toLowerCase();
      const preguntaHab = textLower.includes('disponib') || textLower.includes('esa habitac') || 
                          textLower.includes('ese cuarto') || textLower.includes('número') ||
                          textLower.includes('la del') || textLower.includes('esa pieza');
      if (preguntaHab) {
        const chatId = mensaje.from;
        await cliente.sendMessage(chatId, 'Para consultas sobre una habitación específica, un ejecutivo te atenderá en breve 😊 Estamos recibiendo mensajes por orden de llegada.');
        return;
      }
    }
  }

  console.log(`📩 [${new Date().toLocaleTimeString('es-CL')}] De ${telefono}: ${texto}`);

  // Algunos números llegan con formato @lid - mapear al número real
  const LID_ADMINS = ['202902928908358']; // @lid del +56991655665
  const ADMINS = [process.env.ADMIN_NUMERO, '56991655665', '56999644093', ...LID_ADMINS].filter(Boolean);

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
    // Comandos de disponibilidad manual
    if (texto.startsWith('/ocupado')) {
      const partes = texto.split(' ');
      const motel = partes[1] || 'todo';
      const tipo  = partes[2] || null;
      bloquearHabitacion(motel, tipo);
      const mn = motel === 'apolo' ? 'Apolo' : motel === 'chateau' ? 'Le Chateau' : 'ambos moteles';
      const tn = tipo ? ` — ${tipo.charAt(0).toUpperCase()+tipo.slice(1)}` : ' (todas)';
      await mensaje.reply(`❌ Bloqueado: ${mn}${tn}
Usa /libre para reactivar.`);
      return;
    }
    if (texto.startsWith('/libre')) {
      const partes = texto.split(' ');
      const motel = partes[1] || 'todo';
      const tipo  = partes[2] || null;
      liberarHabitacion(motel, tipo);
      const mn = motel === 'apolo' ? 'Apolo' : motel === 'chateau' ? 'Le Chateau' : 'ambos moteles';
      const tn = tipo ? ` — ${tipo.charAt(0).toUpperCase()+tipo.slice(1)}` : ' (todas)';
      await mensaje.reply(`✅ Liberado: ${mn}${tn}`);
      return;
    }
    if (texto === '/disponibilidad') {
      await mensaje.reply(getEstadoBloqueos());
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

  // Si el admin respondió recientemente a este cliente, pausar 10 minutos
  const pausaAdmin = pausasPorAdmin.get(telefono);
  if (pausaAdmin && (Date.now() - pausaAdmin) < 10 * 60 * 1000) {
    console.log(`⏸️ Bot pausado por respuesta admin — ignorando mensaje de ${telefono}`);
    return;
  } else if (pausaAdmin) {
    pausasPorAdmin.delete(telefono); // Limpiar pausa expirada
  }

  const chat = await mensaje.getChat();
  await chat.sendStateTyping();

  try {
    const respuesta = await procesarMensaje(telefono, texto, numeroPrueba);
    
    // Si es null, el cliente está esperando agente - no responder
    if (respuesta === null) {
      await chat.clearState();
      return;
    }

    const pausa = Math.floor(Math.random() * 1000) + 800;
    await new Promise(r => setTimeout(r, pausa));

    const chatId = mensaje.from;

    // Si la respuesta incluye tarifas, enviar la imagen
    if (respuesta && typeof respuesta === 'object' && respuesta.tarifas) {
      const { MessageMedia } = require('whatsapp-web.js');
      const path = require('path');
      const fs = require('fs');
      const rutaTarifas = path.join(__dirname, 'TARIFAS_APOLO.jpeg');
      if (fs.existsSync(rutaTarifas)) {
        const media = MessageMedia.fromFilePath(rutaTarifas);
        await cliente.sendMessage(chatId, media);
        console.log(`📸 Tarifas enviadas a ${telefono}`);
      } else {
        console.error('❌ No se encontró TARIFAS_APOLO.jpeg');
      }
      await chat.clearState();
      return;
    }

    // Si la respuesta incluye fotos, enviarlas
    if (respuesta && typeof respuesta === 'object' && respuesta.fotos) {
      const { texto: textoRespuesta, fotos } = respuesta;
      const { MessageMedia } = require('whatsapp-web.js');
      const path = require('path');
      const fs = require('fs');

      // Función para enviar fotos de un tipo/motel específico
      const enviarTipoFotos = async (motelId, tipo, cantidad) => {
        const motelArch = motelId === 'lechateau' ? 'chateau' : motelId;
        const motelLabel = motelId === 'lechateau' ? 'Le Chateau' : 'Apolo';
        const nombreTipo = tipo.charAt(0).toUpperCase() + tipo.slice(1);
        await cliente.sendMessage(chatId, `🛏️ ${nombreTipo} - Motel ${motelLabel}`);
        for (let i = 1; i <= cantidad; i++) {
          const rutaFoto = path.join(__dirname, 'fotos', `${motelArch}_${tipo}_${i}.jpeg`);
          if (fs.existsSync(rutaFoto)) {
            try {
              await cliente.sendMessage(chatId, MessageMedia.fromFilePath(rutaFoto));
              await new Promise(r => setTimeout(r, 800));
            } catch (err) {
              console.error(`❌ Error foto ${i} de ${tipo}:`, err.message);
            }
          }
        }
      };

      // Función para procesar un bloque de fotos
      const procesarBloqueForotos = async (bloque) => {
        const motelId = bloque.motel || 'apolo';
        if (bloque.ambos) {
          for (const mId of ['apolo', 'lechateau']) {
            const datosMotel = bloque[mId];
            if (datosMotel.todas && datosMotel.tipos) {
              for (const { tipo, cantidad } of datosMotel.tipos) {
                await enviarTipoFotos(mId, tipo, cantidad);
                await new Promise(r => setTimeout(r, 1000));
              }
            } else {
              await enviarTipoFotos(mId, datosMotel.tipo, datosMotel.cantidad);
            }
            await new Promise(r => setTimeout(r, 1500));
          }
        } else if (bloque.todas && bloque.tipos) {
          for (const { tipo, cantidad } of bloque.tipos) {
            await enviarTipoFotos(motelId, tipo, cantidad);
            await new Promise(r => setTimeout(r, 1000));
          }
        } else {
          await enviarTipoFotos(motelId, bloque.tipo, bloque.cantidad);
        }
      };

      // Enviar texto primero
      if (textoRespuesta) await cliente.sendMessage(chatId, textoRespuesta);

      // Procesar fotos — simple, múltiples o ambos moteles
      if (fotos.multiple && fotos.lista) {
        // Múltiples grupos de fotos (ej: simple + vip)
        for (const bloque of fotos.lista) {
          await procesarBloqueForotos(bloque);
          await new Promise(r => setTimeout(r, 800));
        }
        console.log(`📸 Múltiples grupos de fotos enviados a ${telefono}`);
      } else {
        await procesarBloqueForotos(fotos);
        console.log(`📸 Fotos enviadas a ${telefono}`);
      }

      await chat.clearState();
      return;
    } else {
      await cliente.sendMessage(chatId, respuesta);
      console.log(`📤 Respuesta enviada a ${telefono}`);
    }
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
