// ============================================
// index.js - Bot de WhatsApp para Motel (Chile)
// ============================================
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente, bloquearHabitacion, liberarHabitacion, getEstadoBloqueos } = require('./ia');

const app = express();
const PORT = process.env.PORT || 3000;

let qrActual = null;
let botConectado = false;
let botPausado = false;
let numeroPrueba = null;
const pausasPorAdmin = new Map();
const mensajesProcesados = new Set();
const procesandoCliente = new Map();
const mensajesPendientes = new Map();

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

app.get('/health', (req, res) => res.json({
  ok: true,
  conectado: botConectado,
  pausado: botPausado
}));

app.listen(PORT, () => {
  console.log(`🌐 Servidor web activo en puerto ${PORT}`);
});

// ── Cliente WhatsApp ──────────────────────────────────────────
const mensajesDelBot = new Set();

// Un redeploy puede dejar en el Volume los candados del Chromium
// del contenedor anterior. Solo se eliminan estos archivos
// temporales; la sesión se conserva.
const perfilChromium = '/data/session/session';

for (const candado of [
  'SingletonLock',
  'SingletonSocket',
  'SingletonCookie'
]) {
  try {
    fs.rmSync(path.join(perfilChromium, candado), {
      force: true
    });
  } catch (error) {
    console.warn(
      `⚠️ No se pudo limpiar ${candado}: ${error.message}`
    );
  }
}

console.log('🔓 Candados temporales de Chromium verificados');

const cliente = new Client({
  authStrategy: new LocalAuth({
    dataPath: '/data/session'
  }),
  authTimeoutMs: 90000,
  puppeteer: {
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--disable-gpu'
    ]
  }
});

// Registrar los mensajes enviados por el bot para que no sean
// confundidos con respuestas manuales del administrador.
const _sendMessageOriginal =
  cliente.sendMessage.bind(cliente);

const ultimoEnvioBot = new Map();

cliente.sendMessage = async (...args) => {
  try {
    const destino = String(args[0] || '')
      .replace('@c.us', '')
      .replace('@lid', '');

    if (destino) {
      ultimoEnvioBot.set(destino, Date.now());

      if (ultimoEnvioBot.size > 300) {
        ultimoEnvioBot.clear();
      }
    }
  } catch (error) {
    // El registro nunca debe impedir el envío.
  }

  const msg = await _sendMessageOriginal(...args);
  const id = msg?.id?._serialized || msg?.id?.id;

  if (id) {
    mensajesDelBot.add(id);

    if (mensajesDelBot.size > 500) {
      mensajesDelBot.clear();
    }
  }

  return msg;
};

// Detectar respuestas manuales del administrador.
cliente.on('message_create', async (mensaje) => {
  try {
    if (!mensaje.fromMe) return;

    const id =
      mensaje.id?._serialized || mensaje.id?.id;

    await new Promise(resolve =>
      setTimeout(resolve, 2000)
    );

    if (id && mensajesDelBot.has(id)) return;

    const cuerpoFromMe =
      (mensaje.body || '').toLowerCase();

    if (
      cuerpoFromMe.includes('bienvenid') ||
      cuerpoFromMe.includes('te esperamos')
    ) {
      return;
    }

    const destinatario = (mensaje.to || '')
      .replace('@c.us', '')
      .replace('@lid', '');

    if (
      !destinatario ||
      destinatario.includes('@g.us') ||
      destinatario.includes('status')
    ) {
      return;
    }

    const intentoReciente =
      ultimoEnvioBot.get(destinatario);

    if (
      intentoReciente &&
      Date.now() - intentoReciente < 15000
    ) {
      return;
    }

    pausasPorAdmin.set(destinatario, Date.now());

    console.log(
      `⏸️ Bot pausado 10min para ${destinatario} — admin respondió manualmente`
    );
  } catch (error) {
    console.error(
      'Error en message_create:',
      error.message
    );
  }
});

cliente.on('qr', qr => {
  qrActual = qr;
  botConectado = false;

  console.log(
    '📱 QR generado - abre la URL de Railway y escanéalo'
  );
});

cliente.on('loading_screen', (percent, message) => {
  console.log(
    `⏳ Cargando WhatsApp: ${percent}% ${message || ''}`
  );
});

cliente.on('authenticated', () => {
  qrActual = null;
  console.log('✅ WhatsApp autenticado');
});

cliente.on('ready', () => {
  if (botConectado) {
    console.log('ℹ️ Evento LISTO repetido ignorado');
    return;
  }

  console.log(
    `🏨 ${process.env.MOTEL_NOMBRE} - LISTO`
  );

  botConectado = true;
  qrActual = null;
  setClienteWhatsApp(cliente);
});

cliente.on('auth_failure', msg => {
  console.error('❌ Auth failure:', msg);
});

// Railway debe iniciar un proceso completamente nuevo ante una
// desconexión. LocalAuth recuperará la sesión desde /data/session.
let reinicioProgramado = false;

function programarReinicio(motivo, esperaMs = 4000) {
  if (reinicioProgramado) return;

  reinicioProgramado = true;
  botConectado = false;

  console.error(
    `♻️ Reinicio limpio programado: ${motivo}`
  );

  setTimeout(() => process.exit(1), esperaMs);
}

cliente.on('disconnected', reason => {
  console.log('📵 Desconectado:', reason);

  programarReinicio(
    `WhatsApp desconectado (${reason})`
  );
});

// ── Mensajes ──────────────────────────────────────────────────
cliente.on('message', async mensaje => {
  if (mensaje.from.includes('@g.us')) return;
  if (mensaje.fromMe) return;
  if (mensaje.from === 'status@broadcast') return;
  if (mensaje.from.includes('@newsletter')) return;

  if (
    mensaje.type === 'e2e_notification' ||
    mensaje.type === 'notification_template'
  ) {
    return;
  }

  if (!mensaje.from) return;

  const msgId =
    mensaje.id?.id ||
    mensaje.id?._serialized ||
    '';

  if (
    msgId &&
    mensajesProcesados.has(msgId)
  ) {
    console.log(
      `⚠️ Mensaje duplicado ignorado: ${msgId}`
    );
    return;
  }

  if (msgId) {
    mensajesProcesados.add(msgId);

    if (mensajesProcesados.size > 1000) {
      mensajesProcesados.clear();
    }
  }

  if (!botConectado) {
    let esperado = 0;

    while (
      !botConectado &&
      esperado < 15000
    ) {
      await new Promise(resolve =>
        setTimeout(resolve, 1000)
      );

      esperado += 1000;
    }

    if (!botConectado) {
      console.log(
        '⏳ Bot aún reconectando — se procesará el mensaje cuando el cliente reenvíe'
      );
      return;
    }

    console.log(
      '✅ Reconexión completa — procesando mensaje pendiente'
    );
  }

  const rawFrom = mensaje.from || '';

  let telefono = rawFrom
    .replace('@c.us', '')
    .replace('@lid', '');

  const NUMERO_MOTEL =
    process.env.EMPRESA_NUMERO || '56945676410';

  const LID_MOTEL = '160009157619778';

  if (
    telefono === NUMERO_MOTEL ||
    telefono === LID_MOTEL
  ) {
    return;
  }

  const LID_MAP = {
    '202902928908358': '56991655665',
    '217274023702535':
      process.env.ADMIN_NUMERO || '56949716039'
  };

  if (LID_MAP[telefono]) {
    telefono = LID_MAP[telefono];
  }

  if (
    mensaje.type === 'ptt' ||
    mensaje.type === 'audio'
  ) {
    console.log(
      `🎤 Mensaje de voz de ${telefono} - respondiendo automáticamente`
    );

    await mensaje.reply(
      'Hola 👋 Lo sentimos, no podemos atender mensajes de voz. Por favor escríbenos tu consulta y con gusto te ayudamos 😊'
    );

    return;
  }

  if (
    (
      mensaje.type === 'image' ||
      mensaje.type === 'video' ||
      mensaje.type === 'sticker'
    ) &&
    !mensaje.body?.trim()
  ) {
    return;
  }

  const texto = mensaje.body?.trim();

  if (!texto) return;

  if (mensaje.hasQuotedMsg) {
    const quoted =
      await mensaje
        .getQuotedMessage()
        .catch(() => null);

    if (
      quoted &&
      quoted.type === 'image' &&
      quoted.fromMe
    ) {
      const textLower = texto.toLowerCase();

      const preguntaHab =
        textLower.includes('disponib') ||
        textLower.includes('esa habitac') ||
        textLower.includes('ese cuarto') ||
        textLower.includes('número') ||
        textLower.includes('la del') ||
        textLower.includes('esa pieza');

      if (preguntaHab) {
        const chatId = mensaje.from;

        await cliente.sendMessage(
          chatId,
          'Para consultas sobre una habitación específica, un ejecutivo te atenderá en breve 😊 Estamos recibiendo mensajes por orden de llegada.'
        );

        return;
      }
    }
  }

  console.log(
    `📩 [${new Date().toLocaleTimeString('es-CL')}] De ${telefono}: ${texto}`
  );

  const LID_ADMINS = [
    '202902928908358',
    '217274023702535'
  ];

  const ADMINS = [
    process.env.ADMIN_NUMERO,
    '56991655665',
    '56999644093',
    ...LID_ADMINS
  ].filter(Boolean);

  // ── Comandos Admin ────────────────────────────────────────
  if (ADMINS.includes(telefono)) {
    if (texto === '/desactivar') {
      botPausado = true;

      await mensaje.reply(
        '⏸️ *Bot pausado globalmente.* Responde tú manualmente.\nEscribe /activar para reactivar.'
      );

      return;
    }

    if (texto === '/activar') {
      botPausado = false;

      await mensaje.reply(
        '▶️ *Bot reactivado.* Vuelve a responder automáticamente.'
      );

      return;
    }

    if (texto.startsWith('/prueba')) {
      const num = texto.split(' ')[1];

      if (num) {
        numeroPrueba = num
          .replace('+', '')
          .replace(/\s/g, '');

        await mensaje.reply(
          `🧪 *Modo prueba activado*\nSolo responderé al número: +${numeroPrueba}\nPara desactivar escribe /prueba_off`
        );
      } else {
        await mensaje.reply(
          '❌ Debes indicar el número. Ejemplo: /prueba +56912345678'
        );
      }

      return;
    }

    if (texto === '/prueba_off') {
      numeroPrueba = null;

      await mensaje.reply(
        '✅ *Modo prueba desactivado*\nEl bot responde a todos normalmente.'
      );

      return;
    }

    if (texto === '/estado') {
      await mensaje.reply(
        `${botPausado ? '⏸️ PAUSADO' : '✅ ACTIVO'}${numeroPrueba ? `\n🧪 MODO PRUEBA: solo +${numeroPrueba}` : ''}\n🏨 ${process.env.MOTEL_NOMBRE}\n⏰ ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })}\n\nComandos disponibles:\n/desactivar - Pausar bot\n/activar - Reactivar bot\n/limpiar - Reiniciar tu conversación\n/activar_cliente NUMERO - Reactivar bot para un cliente`
      );

      return;
    }

    if (texto === '/limpiar') {
      limpiarConversacion(telefono);

      await mensaje.reply(
        '🧹 Conversación reiniciada.'
      );

      return;
    }

    if (texto.startsWith('/ocupado')) {
      const partes = texto.split(' ');
      const motel =
        (partes[1] || 'todo').toLowerCase();

      const tipo = partes[2]
        ? partes[2].toLowerCase()
        : null;

      bloquearHabitacion(motel, tipo);

      const mn = motel.includes('apolo')
        ? 'Apolo'
        : motel.includes('chateau')
          ? 'Le Chateau'
          : 'ambos moteles';

      const tn = tipo
        ? ` — ${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`
        : ' (todas)';

      await mensaje.reply(
        `❌ Bloqueado: ${mn}${tn}\nUsa /libre para reactivar.`
      );

      return;
    }

    if (texto.startsWith('/libre')) {
      const partes = texto.split(' ');
      const motel =
        (partes[1] || 'todo').toLowerCase();

      const tipo = partes[2]
        ? partes[2].toLowerCase()
        : null;

      liberarHabitacion(motel, tipo);

      const mn = motel.includes('apolo')
        ? 'Apolo'
        : motel.includes('chateau')
          ? 'Le Chateau'
          : 'ambos moteles';

      const tn = tipo
        ? ` — ${tipo.charAt(0).toUpperCase() + tipo.slice(1)}`
        : ' (todas)';

      await mensaje.reply(
        `✅ Liberado: ${mn}${tn}`
      );

      return;
    }

    if (texto === '/disponibilidad') {
      await mensaje.reply(
        getEstadoBloqueos()
      );

      return;
    }

    if (texto.startsWith('/activar_cliente')) {
      const numeroCliente =
        texto.split(' ')[1];

      if (numeroCliente) {
        reactivarCliente(numeroCliente);

        await mensaje.reply(
          `✅ Bot reactivado para el cliente ${numeroCliente}. Volverá a responder automáticamente.`
        );
      } else {
        await mensaje.reply(
          '⚠️ Uso: /activar_cliente 56912345678'
        );
      }

      return;
    }

    return;
  }

  if (botPausado) {
    console.log(
      `⏸️ Bot pausado - mensaje de ${telefono} ignorado`
    );

    return;
  }

  const pausaAdmin =
    pausasPorAdmin.get(telefono);

  if (
    pausaAdmin &&
    Date.now() - pausaAdmin < 10 * 60 * 1000
  ) {
    console.log(
      `⏸️ Bot pausado por respuesta admin — ignorando mensaje de ${telefono}`
    );

    return;
  } else if (pausaAdmin) {
    pausasPorAdmin.delete(telefono);
  }

  if (!mensajesPendientes.has(telefono)) {
    mensajesPendientes.set(telefono, []);
  }

  mensajesPendientes.get(telefono).push(texto);

  const prev =
    procesandoCliente.get(telefono);

  if (prev) {
    clearTimeout(prev.timer);
    prev.cancelar();
  }

  const debeContinuar =
    await new Promise(resolve => {
      const timer = setTimeout(
        () => resolve(true),
        7000
      );

      procesandoCliente.set(telefono, {
        timer,
        cancelar: () => resolve(false)
      });
    });

  if (!debeContinuar) return;

  procesandoCliente.delete(telefono);

  const pendientes =
    mensajesPendientes.get(telefono) || [];

  mensajesPendientes.delete(telefono);

  const textoFinal = pendientes.join(' ');

  if (pendientes.length > 1) {
    console.log(
      `📨 Mensajes acumulados de ${telefono}: "${textoFinal}"`
    );
  }

  try {
    const palabras =
      (textoFinal || texto).split(' ').length;

    const delayRespuesta =
      palabras <= 5
        ? 2000
        : palabras <= 15
          ? 3000
          : 4000;

    await new Promise(resolve =>
      setTimeout(resolve, delayRespuesta)
    );

    const respuesta = await procesarMensaje(
      telefono,
      textoFinal || texto,
      numeroPrueba
    );

    if (respuesta === null) return;

    const pausa =
      Math.floor(Math.random() * 1000) + 800;

    await new Promise(resolve =>
      setTimeout(resolve, pausa)
    );

    const chatId = mensaje.from;

    if (
      respuesta &&
      typeof respuesta === 'object' &&
      respuesta.tarifas
    ) {
      const { MessageMedia } =
        require('whatsapp-web.js');

      const rutaTarifas = path.join(
        __dirname,
        'TARIFAS_APOLO.jpeg'
      );

      if (fs.existsSync(rutaTarifas)) {
        const media =
          MessageMedia.fromFilePath(rutaTarifas);

        await cliente.sendMessage(
          chatId,
          media
        );

        console.log(
          `📸 Tarifas enviadas a ${telefono}`
        );
      } else {
        console.error(
          '❌ No se encontró TARIFAS_APOLO.jpeg'
        );
      }

      if (
        respuesta.texto &&
        respuesta.texto.trim()
      ) {
        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );

        await cliente.sendMessage(
          chatId,
          respuesta.texto
        );
      }

      return;
    }

    if (
      respuesta &&
      typeof respuesta === 'object' &&
      respuesta.fotos
    ) {
      const {
        texto: textoRespuesta,
        fotos
      } = respuesta;

      const { MessageMedia } =
        require('whatsapp-web.js');

      const enviarTipoFotos = async (
        motelId,
        tipo,
        cantidad
      ) => {
        const motelArch =
          motelId === 'lechateau'
            ? 'chateau'
            : motelId;

        const motelLabel =
          motelId === 'lechateau'
            ? 'Le Chateau'
            : 'Apolo';

        const nombreTipo =
          tipo.charAt(0).toUpperCase() +
          tipo.slice(1);

        await cliente.sendMessage(
          chatId,
          `🛏️ ${nombreTipo} - Motel ${motelLabel}`
        );

        for (
          let i = 1;
          i <= cantidad;
          i++
        ) {
          const rutaFoto = path.join(
            __dirname,
            'fotos',
            `${motelArch}_${tipo}_${i}.jpeg`
          );

          if (fs.existsSync(rutaFoto)) {
            try {
              await cliente.sendMessage(
                chatId,
                MessageMedia.fromFilePath(rutaFoto)
              );

              await new Promise(resolve =>
                setTimeout(resolve, 800)
              );
            } catch (error) {
              console.error(
                `❌ Error foto ${i} de ${tipo}:`,
                error.message
              );
            }
          }
        }
      };

      const procesarBloqueForotos =
        async bloque => {
          const motelId =
            bloque.motel || 'apolo';

          if (bloque.ambos) {
            for (
              const mId of [
                'apolo',
                'lechateau'
              ]
            ) {
              const datosMotel =
                bloque[mId];

              if (
                datosMotel.todas &&
                datosMotel.tipos
              ) {
                for (
                  const {
                    tipo,
                    cantidad
                  } of datosMotel.tipos
                ) {
                  await enviarTipoFotos(
                    mId,
                    tipo,
                    cantidad
                  );

                  await new Promise(resolve =>
                    setTimeout(resolve, 1000)
                  );
                }
              } else {
                await enviarTipoFotos(
                  mId,
                  datosMotel.tipo,
                  datosMotel.cantidad
                );
              }

              await new Promise(resolve =>
                setTimeout(resolve, 1500)
              );
            }
          } else if (
            bloque.todas &&
            bloque.tipos
          ) {
            for (
              const {
                tipo,
                cantidad
              } of bloque.tipos
            ) {
              await enviarTipoFotos(
                motelId,
                tipo,
                cantidad
              );

              await new Promise(resolve =>
                setTimeout(resolve, 1000)
              );
            }
          } else {
            await enviarTipoFotos(
              motelId,
              bloque.tipo,
              bloque.cantidad
            );
          }
        };

      if (
        fotos.multiple &&
        fotos.lista
      ) {
        for (const bloque of fotos.lista) {
          await procesarBloqueForotos(
            bloque
          );

          await new Promise(resolve =>
            setTimeout(resolve, 800)
          );
        }

        console.log(
          `📸 Múltiples grupos de fotos enviados a ${telefono}`
        );
      } else {
        await procesarBloqueForotos(fotos);

        console.log(
          `📸 Fotos enviadas a ${telefono}`
        );
      }

      if (
        textoRespuesta &&
        textoRespuesta.trim()
      ) {
        await new Promise(resolve =>
          setTimeout(resolve, 1500)
        );

        try {
          await cliente.sendMessage(
            chatId,
            textoRespuesta
          );
        } catch (errorEnvio) {
          console.error(
            `Envío directo falló (${errorEnvio.message}) — intentando vía reply`
          );

          await mensaje.reply(
            textoRespuesta
          );
        }
      }

      return;
    }

    try {
      await cliente.sendMessage(
        chatId,
        respuesta
      );

      console.log(
        `📤 Respuesta enviada a ${telefono}`
      );
    } catch (errorEnvio) {
      console.error(
        `Envío directo falló (${errorEnvio.message}) — intentando vía reply`
      );

      await mensaje.reply(respuesta);

      console.log(
        `📤 Respuesta enviada vía reply (plan B) a ${telefono}`
      );
    }
  } catch (error) {
    console.error(
      'Error procesando mensaje:',
      error.message
    );

    if (error.stack) {
      console.error(
        'Traza:',
        error.stack
          .split('\n')
          .slice(0, 5)
          .join('\n')
      );
    }

    const avisoError =
      'Disculpa, tuvimos un problema técnico. ¿Podrías repetir tu mensaje? 😊';

    try {
      await cliente.sendMessage(
        mensaje.from,
        avisoError
      );
    } catch (errorEnvio) {
      try {
        await mensaje.reply(avisoError);
      } catch (errorReply) {
        console.error(
          'No se pudo enviar mensaje de error al cliente:',
          errorReply.message
        );
      }
    }
  } finally {
    procesandoCliente.delete(telefono);
  }
});

console.log('🚀 Iniciando bot...');

console.log(
  `🏨 Motel: ${process.env.MOTEL_NOMBRE || 'Sin configurar'}`
);

console.log(`🧩 Node: ${process.version}`);

console.log(
  `🧩 whatsapp-web.js: ${require('whatsapp-web.js/package.json').version}`
);

console.log(
  '🛠️ Corrección oficial de navegación: 942d236'
);

console.log('━'.repeat(50));

// Si Puppeteer pierde el contexto de WhatsApp Web, Railway
// reiniciará el proceso y recuperará la sesión persistente.
process.on('unhandledRejection', reason => {
  console.error(
    'Error no manejado:',
    reason
  );

  const detalle =
    reason?.stack ||
    reason?.message ||
    String(reason);

  if (
    /Execution context was destroyed|TargetCloseError|Target closed|Protocol error/i.test(detalle)
  ) {
    programarReinicio(
      'Puppeteer perdió el contexto de WhatsApp Web',
      2500
    );
  }
});

process.on(
  'uncaughtException',
  error => {
    console.error(
      'Excepción no controlada:',
      error
    );

    programarReinicio(
      error?.message ||
        'excepción no controlada',
      2500
    );
  }
);

cliente.initialize().catch(error => {
  console.error(
    'Error al iniciar:',
    error
  );

  programarReinicio(
    `falló initialize(): ${error.message}`,
    2500
  );
});
