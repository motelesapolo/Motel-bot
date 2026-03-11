// ============================================
// reservas.js - Gestor de Reservas
// ============================================
const { google } = require('googleapis');
require('dotenv').config();

const reservasEnMemoria = new Map();

// ── Google Calendar Auth ──────────────────────────────────────
function getCalendarClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// ── Generar ID de 6 dígitos ───────────────────────────────────
function generarIdReserva() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Parsear fecha respetando zona horaria Santiago ────────────
// Chile (Santiago) usa America/Santiago: UTC-4 en invierno, UTC-3 en verano
// Esta función convierte correctamente cualquier fecha/hora local de Santiago
function parsearFechaSantiago(fechaStr) {
  // Si ya tiene timezone explícito, usarlo directamente
  if (fechaStr.includes('Z') || /[+-]\d{2}:\d{2}$/.test(fechaStr)) {
    return new Date(fechaStr);
  }
  // Sin timezone: asumir hora local de Santiago
  // Calculamos el offset real de Santiago para esa fecha específica
  const fechaBase = fechaStr.includes('T') ? fechaStr : fechaStr + 'T00:00:00';
  // Usar Intl para obtener el offset correcto de Santiago en esa fecha
  const tempDate = new Date(fechaBase + 'Z');
  const santiagoParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(tempDate);
  
  const get = (type) => parseInt(santiagoParts.find(p => p.type === type)?.value || '0');
  const utcHour = tempDate.getUTCHours();
  const santiagHour = get('hour') === 24 ? 0 : get('hour');
  let offsetHours = santiagHour - utcHour;
  if (offsetHours > 12) offsetHours -= 24;
  if (offsetHours < -12) offsetHours += 24;
  
  const offsetSign = offsetHours >= 0 ? '+' : '-';
  const offsetAbs = Math.abs(offsetHours);
  const offsetStr = `${offsetSign}${String(offsetAbs).padStart(2,'0')}:00`;
  
  return new Date(fechaBase + offsetStr);
}

// ── Crear reserva en Google Calendar ─────────────────────────
async function crearReserva({ nombre, telefono, tipo, fechaInicio, motel, precio, duracionHoras }) {
  const inicio = parsearFechaSantiago(fechaInicio);
  const horas = duracionHoras || 3;
  const fin = new Date(inicio.getTime() + horas * 60 * 60 * 1000);
  const reservaId = generarIdReserva();
  const motelNombre = motel ? `Motel ${motel}` : (process.env.MOTEL_NOMBRE || 'Motel');
  const precioFinal = precio || 0;

  // Formatear fechas para mostrar en Santiago
  const opcionesFecha = { timeZone: 'America/Santiago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const inicioStr = inicio.toLocaleString('es-CL', opcionesFecha);
  const finStr = fin.toLocaleString('es-CL', opcionesFecha);

  const evento = {
    summary: `🏨 [${motelNombre}] ${tipo} - ${nombre} #${reservaId}`,
    description: [
      `🔖 N° Reserva: ${reservaId}`,
      `🏨 Motel: ${motelNombre}`,
      `👤 Cliente: ${nombre}`,
      `📱 Teléfono: ${telefono}`,
      `🛏️ Tipo: ${tipo}`,
      `⏱️ Duración: ${horas} horas`,
      `💰 Precio: $${precioFinal.toLocaleString('es-CL')} CLP`,
      `🕐 Llegada: ${inicioStr}`,
      `🕑 Salida estimada: ${finStr}`,
      `⏳ Tiempo de espera: 30 minutos`,
    ].join('\n'),
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Santiago' },
    end:   { dateTime: fin.toISOString(),   timeZone: 'America/Santiago' },
    colorId: '2',
  };

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: evento,
    });

    reservasEnMemoria.set(reservaId, {
      id: reservaId,
      googleEventId: res.data.id,
      nombre, telefono, tipo, motel,
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      precio: precioFinal,
      estado: 'confirmada',
    });

    return { ok: true, id: reservaId, precio: precioFinal, inicio, fin };
  } catch (err) {
    console.error('Error creando reserva en Google Calendar:', err.message);
    reservasEnMemoria.set(reservaId, {
      id: reservaId, nombre, telefono, tipo, motel,
      inicio: inicio.toISOString(), fin: fin.toISOString(),
      precio: precioFinal, estado: 'confirmada',
    });
    return { ok: true, id: reservaId, precio: precioFinal, inicio, fin, fallback: true };
  }
}

// ── Consultar disponibilidad ──────────────────────────────────
async function consultarDisponibilidad(fechaInicio, duracionHoras = 3) {
  const inicio = parsearFechaSantiago(fechaInicio);
  const fin = new Date(inicio.getTime() + duracionHoras * 60 * 60 * 1000);
  const totalHabitaciones = parseInt(process.env.TOTAL_HABITACIONES || 10);

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: inicio.toISOString(),
      timeMax: fin.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventosActivos = (res.data.items || []).filter(e => e.status !== 'cancelled');
    const ocupadas = eventosActivos.length;
    const disponibles = Math.max(0, totalHabitaciones - ocupadas);

    return { disponibles, ocupadas, total: totalHabitaciones, hayDisponibilidad: disponibles > 0 };
  } catch (err) {
    console.error('Error consultando disponibilidad:', err.message);
    return { disponibles: totalHabitaciones, ocupadas: 0, total: totalHabitaciones, hayDisponibilidad: true };
  }
}

// ── Cancelar reserva ──────────────────────────────────────────
async function cancelarReserva(reservaId) {
  // Buscar en memoria el googleEventId
  const reserva = reservasEnMemoria.get(reservaId);
  const googleId = reserva?.googleEventId;

  try {
    const calendar = getCalendarClient();
    if (googleId) {
      await calendar.events.delete({
        calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
        eventId: googleId,
      });
    }
    reservasEnMemoria.delete(reservaId);
    return { ok: true };
  } catch (err) {
    console.error('Error cancelando reserva:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Obtener reservas próximas ─────────────────────────────────
async function obtenerReservasProximas(horas = 2) {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + horas * 60 * 60 * 1000);
  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: ahora.toISOString(),
      timeMax: limite.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });
    return res.data.items || [];
  } catch (err) {
    return [];
  }
}

function formatearFecha(fecha) {
  return new Date(fecha).toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

module.exports = {
  crearReserva,
  consultarDisponibilidad,
  cancelarReserva,
  obtenerReservasProximas,
  formatearFecha,
};
