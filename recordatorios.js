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
      // Extraer teléfono de la descripción del evento
      const telefonoMatch = evento.description?.match(/📱 Teléfono: (\+?\d+)/);
      const nombreMatch = evento.description?.match(/👤 Cliente: (.+)/);
      const habitacionMatch = evento.summary?.match(/Hab\.(\d+)/);

      if (!telefonoMatch) continue;

      const telefono = telefonoMatch[1].replace(/\D/g, '');
      const nombre = nombreMatch ? nombreMatch[1] : 'Estimado/a';
      const habitacion = habitacionMatch ? habitacionMatch[1] : '?';
      const horaInicio = formatearFecha(evento.start.dateTime);

      // Verificar si ya se envió recordatorio (usando ID del evento)
      const yaEnviado = recordatoriosEnviados.has(evento.id);
      if (yaEnviado) continue;

      const mensaje = [
        `📅 *Recordatorio de Reserva*`,
        ``,
        `Hola ${nombre} 👋`,
        `Te recordamos que tienes una reserva en *${process.env.MOTEL_NOMBRE}*:`,
        ``,
        `🛏️ Habitación: ${habitacion}`,
        `🕐 Llegada: ${horaInicio}`,
        `📍 Dirección: ${process.env.MOTEL_DIRECCION}`,
        ``,
        `¡Te esperamos! Si necesitas cancelar o cambiar tu reserva, responde este mensaje.`,
      ].join('\n');

      try {
        const chatId = `${telefono}@c.us`;
        await clienteWhatsApp.sendMessage(chatId, mensaje);
        recordatoriosEnviados.add(evento.id);
        console.log(`📨 Recordatorio enviado a ${telefono}`);
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
