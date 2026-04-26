// ============================================
// recordatorios.js - Sistema de Recordatorios
// ============================================
const cron = require('node-cron');
const { obtenerReservasProximas, formatearFecha } = require('./reservas');

let clienteWhatsApp = null;

function iniciarRecordatorios(cliente) {
  clienteWhatsApp = cliente;

  // Verificar reservas próximas cada 30 minutos
  cron.schedule('*/30 * * * *', async () => {
    await enviarRecordatorios();
  });

  console.log('⏰ Sistema de recordatorios iniciado (cada 30 min)');
}

async function enviarRecordatorios() {
  if (!clienteWhatsApp) return;

  try {
    // Obtener reservas que comienzan en las próximas 2 horas
    const reservasProximas = await obtenerReservasProximas(2);

    for (const evento of reservasProximas) {
      // Extraer datos del formato actual de descripción
      // Formato: "👤 Cliente: Nombre\n🔖 N° Reserva: XXXXXX\n🏨 Motel: ..."
      const nombreMatch = evento.description?.match(/👤 Cliente: (.+)/);
      const reservaMatch = evento.description?.match(/🔖 N° Reserva: (\d+)/);
      const motelMatch = evento.description?.match(/🏨 Motel: (.+)/);
      const telefonoMatch = evento.description?.match(/📱 Teléfono: (\+?\d+)/);

      // Sin nombre ni número de reserva no podemos enviar recordatorio útil
      if (!nombreMatch || !reservaMatch) continue;

      const nombre = nombreMatch[1].trim();
      const reservaId = reservaMatch[1].trim();
      const motelNombre = motelMatch ? motelMatch[1].trim() : (process.env.MOTEL_NOMBRE || 'el motel');
      const horaInicio = formatearFecha(evento.start.dateTime);

      // Verificar si ya se envió recordatorio
      const yaEnviado = recordatoriosEnviados.has(evento.id);
      if (yaEnviado) continue;

      const mensaje = [
        `Hola ${nombre} 👋 Te recordamos tu reserva en ${motelNombre}:`,
        `📅 Llegada: ${horaInicio}`,
        `🔖 N° Reserva: ${reservaId}`,
        `Si necesitas cancelar o cambiar, responde este mensaje.`,
      ].join('\n');

      // Enviar solo si tenemos teléfono (guardado en descripción en reservas antiguas)
      // o intentar extraerlo del summary si aplica
      const telefono = telefonoMatch ? telefonoMatch[1].replace(/\D/g, '') : null;
      if (!telefono) {
        console.log(`⚠️ Reserva ${reservaId} sin teléfono en Calendar — recordatorio omitido`);
        continue;
      }

      try {
        const chatId = `${telefono}@c.us`;
        await clienteWhatsApp.sendMessage(chatId, mensaje);
        recordatoriosEnviados.add(evento.id);
        console.log(`📨 Recordatorio enviado a ${telefono} (reserva ${reservaId})`);
      } catch (err) {
        console.error(`Error enviando recordatorio a ${telefono}:`, err.message);
      }
    }
  } catch (err) {
    console.error('Error en sistema de recordatorios:', err.message);
  }
}

// Set para evitar recordatorios duplicados (se limpia cada 24h)
const recordatoriosEnviados = new Set();
setInterval(() => recordatoriosEnviados.clear(), 24 * 60 * 60 * 1000);

module.exports = { iniciarRecordatorios };
