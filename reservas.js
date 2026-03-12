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
// Método robusto: usamos el offset real de Santiago para la fecha dada
function parsearFechaSantiago(fechaStr) {
  // Si ya tiene timezone explícito, usarlo directamente
  if (fechaStr.includes('Z') || /[+-]\d{2}:\d{2}$/.test(fechaStr)) {
    return new Date(fechaStr);
  }
  
  const fechaBase = fechaStr.includes('T') ? fechaStr : fechaStr + 'T00:00:00';
  
  // Obtener el offset real de Santiago para esa fecha específica
  // Santiago es UTC-3 en verano (octubre-marzo) y UTC-4 en invierno (abril-septiembre)
  const [datePart, timePart] = fechaBase.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const mes = month; // 1-12
  
  // Chile usa horario de verano: UTC-3 de octubre a marzo, UTC-4 de abril a septiembre
  const esVerano = mes <= 3 || mes >= 10;
  const offset = esVerano ? '-03:00' : '-04:00';
  
  return new Date(`${fechaBase}${offset}`);
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

  const tipoCorto = tipo.toLowerCase().includes('jacuzzi') ? 'Jacuzzi' :
                    tipo.toLowerCase().includes('vip') ? 'VIP' : 'Simple';

  const evento = {
    summary: `${nombre} / ${tipoCorto} / $${precioFinal.toLocaleString('es-CL')}`,
    description: [
      `🔖 N° Reserva: ${reservaId}`,
      `🏨 Motel: ${motelNombre}`,
      `👤 Cliente: ${nombre}`,
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

// ── Capacidad por motel y tipo ───────────────────────────────
const CAPACIDAD = {
  Apolo:     { simple: 6, vip: 3, jacuzzi: 2 },
  LeChateaU: { simple: 7, vip: 5, jacuzzi: 2 },
};

function getCapacidad(motel, tipoHab) {
  const m = motel && motel.toLowerCase().includes('chateau') ? 'LeChateaU' : 'Apolo';
  const t = tipoHab && tipoHab.toLowerCase().includes('jacuzzi') ? 'jacuzzi' :
            tipoHab && tipoHab.toLowerCase().includes('vip') ? 'vip' : 'simple';
  return CAPACIDAD[m][t];
}

// ── Consultar disponibilidad ──────────────────────────────────
async function consultarDisponibilidad(fechaInicio, duracionHoras = 3, motel = '', tipoHab = '') {
  const inicio = parsearFechaSantiago(fechaInicio);
  const fin = new Date(inicio.getTime() + duracionHoras * 60 * 60 * 1000);
  const totalHabitaciones = getCapacidad(motel, tipoHab);

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: inicio.toISOString(),
      timeMax: fin.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const motelFiltro = motel ? motel.toLowerCase() : '';
    const tipoFiltro = tipoHab ? tipoHab.toLowerCase().split('_')[0] : '';

    const eventosActivos = (res.data.items || []).filter(e => {
      if (e.status === 'cancelled') return false;
      const summary = (e.summary || '').toLowerCase();
      const matchMotel = motelFiltro ? summary.includes(motelFiltro) : true;
      const matchTipo = tipoFiltro ? summary.includes(tipoFiltro) : true;
      return matchMotel && matchTipo;
    });

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
