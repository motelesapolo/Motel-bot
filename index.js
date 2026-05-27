// ============================================
// index.js - Bot WhatsApp con Meta Cloud API
// ============================================
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente, bloquearHabitacion, liberarHabitacion, getEstadoBloqueos } = require('./ia');
const { iniciarRecordatorios } = require('./recordatorios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// Variables de Meta Cloud API
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;        // Token permanente de Meta
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;  // ID del número de teléfono
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || 'moteles_apolo_2026';

let botPausado = false;
let numeroPrueba = null;
const pausasPorAdmin = new Map();
const mensajesProcesados = new Set();
const procesandoCliente = new Map();
const mensajesPendientes = new Map();

// ── Enviar mensaje via Meta API ───────────────────────────────
async function enviarMensaje(telefono, texto) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'text',
        text: { body: texto }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
  }
}

// ── Enviar imagen via Meta API ────────────────────────────────
async function enviarImagen(telefono, rutaLocal) {
  try {
    const FormData = require('form-data');
    // Primero subir el archivo a Meta
    const form = new FormData();
    form.append('file', fs.createReadStream(rutaLocal));
    form.append('messaging_product', 'whatsapp');
    form.append('type', 'image/jpeg');

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/media`,
      form,
      { headers: { ...form.getHeaders(), Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    const mediaId = uploadRes.data.id;

    // Luego enviar la imagen
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        to: telefono,
        type: 'image',
        image: { id: mediaId }
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('Error enviando imagen:', err.response?.data || err.message);
  }
}

// ── Webhook verificación (Meta lo llama al configurar) ────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Webhook recepción de mensajes ─────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const mensaje = value?.messages?.[0];

    if (!mensaje) return;

    // Solo procesar mensajes de texto
    const tipo = mensaje.type;
    if (tipo !== 'text' && tipo !== 'image' && tipo !== 'audio') return;

    const telefono = mensaje.from;
    const msgId = mensaje.id;
    const texto = mensaje.text?.body || '';

    // Filtro duplicados
    if (mensajesProcesados.has(msgId)) return;
    mensajesProcesados.add(msgId);
    if (mensajesProcesados.size > 1000) mensajesProcesados.clear();

    // Ignorar número del motel
    const NUMERO_MOTEL = process.env.EMPRESA_NUMERO || '56945676410';
    if (telefono === NUMERO_MOTEL || telefono.includes(NUMERO_MOTEL)) return;

    // Admins
    const ADMINS = [process.env.ADMIN_NUMERO, '56991655665', '56999644093'].filter(Boolean);
    const esAdmin = ADMINS.includes(telefono);

    console.log(`📩 De ${telefono}: ${texto.substring(0, 50)}`);

    // Mensajes de voz
    if (tipo === 'audio') {
      await enviarMensaje(telefono, 'No puedo escuchar mensajes de voz. Por favor escríbeme 😊');
      return;
    }

    // Comandos admin
    if (esAdmin) {
      if (texto === '/desactivar') { botPausado = true; await enviarMensaje(telefono, '⏸️ Bot pausado.'); return; }
      if (texto === '/activar') { botPausado = false; await enviarMensaje(telefono, '▶️ Bot reactivado.'); return; }
      if (texto === '/estado') { await enviarMensaje(telefono, botPausado ? '⏸️ Pausado' : '▶️ Activo'); return; }
      if (texto === '/disponibilidad') { await enviarMensaje(telefono, getEstadoBloqueos()); return; }
      if (texto.startsWith('/ocupado')) {
        const partes = texto.split(' ');
        bloquearHabitacion(partes[1] || 'todo', partes[2] || null);
        await enviarMensaje(telefono, `❌ Bloqueado: ${partes[1] || 'todo'} ${partes[2] || '(todas)'}`);
        return;
      }
      if (texto.startsWith('/libre')) {
        const partes = texto.split(' ');
        liberarHabitacion(partes[1] || 'todo', partes[2] || null);
        await enviarMensaje(telefono, `✅ Liberado: ${partes[1] || 'todo'} ${partes[2] || '(todas)'}`);
        return;
      }
      if (texto.startsWith('/prueba')) {
        numeroPrueba = texto.split(' ')[1] || null;
        await enviarMensaje(telefono, numeroPrueba ? `🧪 Modo prueba: ${numeroPrueba}` : '🧪 Modo prueba desactivado');
        return;
      }
      if (texto === '/limpiar') { limpiarConversacion(telefono); await enviarMensaje(telefono, '🧹 Conversación reiniciada.'); return; }
      return; // Ignorar otros mensajes de admins
    }

    if (botPausado) return;
    if (numeroPrueba && telefono !== numeroPrueba) return;

    // Pausa por respuesta admin
    const pausaAdmin = pausasPorAdmin.get(telefono);
    if (pausaAdmin && (Date.now() - pausaAdmin) < 10 * 60 * 1000) return;

    // Debounce 1.5s acumulador
    if (!mensajesPendientes.has(telefono)) mensajesPendientes.set(telefono, []);
    mensajesPendientes.get(telefono).push(texto);

    if (procesandoCliente.get(telefono)) clearTimeout(procesandoCliente.get(telefono));

    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1500);
      procesandoCliente.set(telefono, timer);
    });
    procesandoCliente.delete(telefono);

    const pendientes = mensajesPendientes.get(telefono) || [];
    mensajesPendientes.delete(telefono);
    const textoFinal = pendientes.join(' ');
    if (pendientes.length > 1) console.log(`📨 Mensajes acumulados: "${textoFinal}"`);

    // Procesar mensaje
    const respuesta = await procesarMensaje(telefono, textoFinal || texto, numeroPrueba);
    if (!respuesta) return;

    // Manejar respuesta con tarifas
    if (typeof respuesta === 'object' && respuesta.tarifas) {
      const rutaTarifas = path.join(__dirname, 'TARIFAS_APOLO.jpeg');
      if (fs.existsSync(rutaTarifas)) await enviarImagen(telefono, rutaTarifas);
      if (respuesta.texto?.trim()) {
        await new Promise(r => setTimeout(r, 1500));
        await enviarMensaje(telefono, respuesta.texto);
      }
      return;
    }

    // Manejar respuesta con fotos
    if (typeof respuesta === 'object' && respuesta.fotos) {
      const { texto: textoResp, fotos } = respuesta;
      const cantidades = { apolo: { simple: 11, vip: 8, jacuzzi: 7 }, chateau: { simple: 7, vip: 6, jacuzzi: 4 } };

      const enviarTipoFotos = async (motelId, tipo, cantidad) => {
        const motelArch = motelId === 'lechateau' ? 'chateau' : motelId;
        const motelLabel = motelId === 'lechateau' ? 'Le Chateau' : 'Apolo';
        await enviarMensaje(telefono, `🛏️ ${tipo.charAt(0).toUpperCase()+tipo.slice(1)} - Motel ${motelLabel}`);
        for (let i = 1; i <= cantidad; i++) {
          const ruta = path.join(__dirname, 'fotos', `${motelArch}_${tipo}_${i}.jpeg`);
          if (fs.existsSync(ruta)) {
            await enviarImagen(telefono, ruta);
            await new Promise(r => setTimeout(r, 800));
          }
        }
      };

      const procesarBloque = async (bloque) => {
        const motelId = bloque.motel || 'apolo';
        if (bloque.ambos) {
          for (const mId of ['apolo', 'lechateau']) {
            const d = bloque[mId];
            if (d.todas && d.tipos) {
              for (const { tipo, cantidad } of d.tipos) { await enviarTipoFotos(mId, tipo, cantidad); await new Promise(r => setTimeout(r, 1000)); }
            } else { await enviarTipoFotos(mId, d.tipo, d.cantidad); }
            await new Promise(r => setTimeout(r, 1500));
          }
        } else if (bloque.todas && bloque.tipos) {
          for (const { tipo, cantidad } of bloque.tipos) { await enviarTipoFotos(motelId, tipo, cantidad); await new Promise(r => setTimeout(r, 1000)); }
        } else { await enviarTipoFotos(motelId, bloque.tipo, bloque.cantidad); }
      };

      if (fotos.multiple && fotos.lista) {
        for (const bloque of fotos.lista) { await procesarBloque(bloque); await new Promise(r => setTimeout(r, 800)); }
      } else { await procesarBloque(fotos); }

      if (textoResp?.trim()) { await new Promise(r => setTimeout(r, 1500)); await enviarMensaje(telefono, textoResp); }
      return;
    }

    // Respuesta normal de texto
    const textoRespuesta = typeof respuesta === 'object' ? respuesta.texto : respuesta;
    if (textoRespuesta) {
      await enviarMensaje(telefono, textoRespuesta);
      console.log(`📤 Respuesta enviada a ${telefono}`);
    }

  } catch (error) {
    console.error('Error en webhook:', error.message);
  }
});

// ── Notificaciones de estado de mensajes ─────────────────────
// Meta también manda notificaciones cuando el mensaje fue entregado/leído
// Las ignoramos pero hay que responder 200

// ── Iniciar servidor ──────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌐 Servidor webhook en puerto ${PORT}`);
  // Iniciar recordatorios
  iniciarRecordatorios(enviarMensaje);
  // Pasar función de envío a ia.js para notificaciones
  setClienteWhatsApp({ sendMessage: (tel, msg) => enviarMensaje(tel, msg) });
  console.log('🏨 Motel Apolo / Le Chateau - LISTO (Meta Cloud API)');
});
