// ============================================
// reservas.js - Gestor de Reservas
// ============================================
const { google } = require('googleapis');
require('dotenv').config();

// Almacén temporal en memoria (mientras no hay base de datos)
const reservasEnMemoria = new Map();

// ── Google Calendar Auth ──────────────────────────────────────
function getCalendarClient() {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  oAuth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return google.calendar({ version: 'v3', auth: oAuth2Client });
}

// ── Calcular duración según tipo ─────────────────────────────
function calcularDuracion(tipo) {
  const duraciones = {
    '3_horas':       { horas: 3,  precio: parseInt(process.env.PRECIO_3_HORAS  || 15000) },
    '6_horas':       { horas: 6,  precio: parseInt(process.env.PRECIO_6_HORAS  || 25000) },
    '12_horas':      { horas: 12, precio: parseInt(process.env.PRECIO_12_HORAS || 35000) },
    'noche_completa':{ horas: 12, precio: parseInt(process.env.PRECIO_NOCHE_COMPLETA || 50000) },
  };
  return duraciones[tipo] || duraciones['3_horas'];
}

// ── Crear reserva en Google Calendar ─────────────────────────
async function crearReserva({ nombre, telefono, tipo, fechaInicio, habitacion, motel, precio }) {
  const duracion = calcularDuracion(tipo);
  const inicio = new Date(fechaInicio);
  const fin = new Date(inicio.getTime() + duracion.horas * 60 * 60 * 1000);

  const tipoLabel = {
    '3_horas': '3 Horas',
    '6_horas': '6 Horas',
    '12_horas': '12 Horas',
    'noche_completa': 'Noche Completa',
  }[tipo] || tipo;

  const motelNombre = motel ? `Motel ${motel}` : (process.env.MOTEL_NOMBRE || 'Motel');
  const precioFinal = precio || duracion.precio;

  const evento = {
    summary: `🏨 [${motelNombre}] Hab.${habitacion} - ${nombre}`,
    description: [
      `🏨 Motel: ${motelNombre}`,
      `👤 Cliente: ${nombre}`,
      `📱 Teléfono: ${telefono}`,
      `🛏️ Habitación: ${habitacion}`,
      `⏱️ Tipo: ${tipo || tipoLabel}`,
      `💰 Precio: $${precioFinal.toLocaleString('es-CL')} CLP`,
    ].join('\n'),
    start: { dateTime: inicio.toISOString(), timeZone: 'America/Santiago' },
    end:   { dateTime: fin.toISOString(),   timeZone: 'America/Santiago' },
    colorId: '2', // Verde
  };

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: evento,
    });

    const reservaId = res.data.id;

    // Guardar también en memoria para acceso rápido
    reservasEnMemoria.set(reservaId, {
      id: reservaId,
      nombre,
      telefono,
      tipo,
      habitacion,
      inicio: inicio.toISOString(),
      fin: fin.toISOString(),
      precio: duracion.precio,
      estado: 'confirmada',
      googleEventId: reservaId,
    });

    return {
      ok: true,
      id: reservaId,
      precio: duracion.precio,
      inicio,
      fin,
      habitacion,
    };
  } catch (err) {
    console.error('Error creando reserva en Google Calendar:', err.message);
    // Fallback: guardar solo en memoria si Calendar falla
    const reservaId = `local_${Date.now()}`;
    reservasEnMemoria.set(reservaId, {
      id: reservaId, nombre, telefono, tipo, habitacion,
      inicio: inicio.toISOString(), fin: fin.toISOString(),
      precio: duracion.precio, estado: 'confirmada',
    });
    return { ok: true, id: reservaId, precio: duracion.precio, inicio, fin, habitacion, fallback: true };
  }
}

// ── Consultar disponibilidad ──────────────────────────────────
async function consultarDisponibilidad(fechaInicio, duracionHoras = 3) {
  const inicio = new Date(fechaInicio);
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
    const habitacionesOcupadas = eventosActivos.length;
    const disponibles = totalHabitaciones - habitacionesOcupadas;

    return {
      disponibles: Math.max(0, disponibles),
      ocupadas: habitacionesOcupadas,
      total: totalHabitaciones,
      hayDisponibilidad: disponibles > 0,
    };
  } catch (err) {
    console.error('Error consultando disponibilidad:', err.message);
    return { disponibles: totalHabitaciones, ocupadas: 0, total: totalHabitaciones, hayDisponibilidad: true };
  }
}

// ── Obtener número de habitación disponible ───────────────────
async function obtenerHabitacionDisponible(fechaInicio, duracionHoras = 3) {
  const inicio = new Date(fechaInicio);
  const fin = new Date(inicio.getTime() + duracionHoras * 60 * 60 * 1000);
  const totalHabitaciones = parseInt(process.env.TOTAL_HABITACIONES || 10);

  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      timeMin: inicio.toISOString(),
      timeMax: fin.toISOString(),
      singleEvents: true,
    });

    const eventos = (res.data.items || []).filter(e => e.status !== 'cancelled');
    const habitacionesOcupadas = new Set();

    eventos.forEach(e => {
      const match = e.summary?.match(/Hab\.(\d+)/);
      if (match) habitacionesOcupadas.add(parseInt(match[1]));
    });

    for (let i = 1; i <= totalHabitaciones; i++) {
      if (!habitacionesOcupadas.has(i)) return i;
    }
    return null; // Sin habitaciones disponibles
  } catch (err) {
    return Math.floor(Math.random() * totalHabitaciones) + 1;
  }
}

// ── Cancelar reserva ──────────────────────────────────────────
async function cancelarReserva(reservaId) {
  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      eventId: reservaId,
    });
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

// ── Formatear fecha en español (Chile) ───────────────────────
function formatearFecha(fecha) {
  return new Date(fecha).toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

module.exports = {
  crearReserva,
  consultarDisponibilidad,
  obtenerHabitacionDisponible,
  cancelarReserva,
  obtenerReservasProximas,
  calcularDuracion,
  formatearFecha,
};
