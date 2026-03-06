// ============================================
// ia.js - Motor de IA con Claude (Anthropic)
// Configurado para Motel Apolo & Le Chateau
// ============================================
const Anthropic = require('@anthropic-ai/sdk');
const {
  crearReserva,
  consultarDisponibilidad,
  obtenerHabitacionDisponible,
  cancelarReserva,
} = require('./reservas');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversaciones = new Map();
const reservasEnProgreso = new Map();

// ── System Prompt completo ────────────────────────────────────
function getSystemPrompt() {
  const ahoraStr = new Date().toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const diaSemana = new Date().getDay();
  const esFinde = diaSemana === 5 || diaSemana === 6;
  const tarifaHoy = esFinde ? 'FIN DE SEMANA / VÍSPERA DE FESTIVO' : 'SEMANA (domingo a jueves)';

  return `Eres el asistente virtual de Motel Apolo y Motel Le Chateau, dos moteles privados en Providencia, Santiago de Chile. Atiendes 24/7 por WhatsApp.

FECHA Y HORA ACTUAL: ${ahoraStr}
TARIFA VIGENTE HOY: ${tarifaHoy}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏨 LOS MOTELES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 MOTEL APOLO
Dirección: Vicuña Mackenna 328, Providencia, Santiago
Teléfono: +56 9 4567 6410 | Horario: 24/7

📍 MOTEL LE CHATEAU
Dirección: Marín 021, Providencia, Santiago
Teléfono: +56 9 4567 6410 | Horario: 24/7

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛏️ HABITACIONES Y PRECIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TARIFA SEMANA (domingo a jueves):
🏠 Simple:  3h $27.000 | 12h/noche $35.000 | 24h $55.000
⭐ VIP:     3h $32.000 | 12h/noche $42.000 | 24h $65.000
🛁 Jacuzzi: 3h $40.000 | 12h/noche $51.000 | 24h $75.000

TARIFA FIN DE SEMANA (viernes, sábado y vísperas de festivos):
🏠 Simple:  3h $29.000 | 12h/noche $39.000 | 24h $55.000
⭐ VIP:     3h $37.000 | 12h/noche $46.000 | 24h $65.000
🛁 Jacuzzi: 3h $44.000 | 12h/noche $53.000 | 24h $75.000

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 DESCRIPCIÓN DE HABITACIONES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏠 SIMPLE
Cama doble/matrimonial, TV, baño privado con ducha, artículos de aseo, estacionamiento privado y acceso discreto. Perfecta para una estadía cómoda y privada.

⭐ VIP
Todo lo de la Simple más: cama king size, decoración especial, iluminación ambiente, TV de mayor tamaño y amenities premium. Mayor confort y exclusividad.

🛁 JACUZZI
Todo lo de la VIP más: jacuzzi privado dentro de la habitación. Nuestra opción más romántica y exclusiva, ideal para ocasiones especiales.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❓ PREGUNTAS FRECUENTES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

¿Están abiertos? → Sí, 24/7 los 365 días del año, incluyendo festivos.
¿Hay estacionamiento? → Sí, estacionamiento privado y acceso discreto en ambos moteles.
¿Se puede llegar sin reserva? → Sí, pero recomendamos reservar para garantizar disponibilidad, especialmente fines de semana.
¿Cómo se paga? → Pago al llegar en recepción. Se acepta efectivo.
¿Dónde queda el Apolo? → Vicuña Mackenna 328, Providencia (cerca del metro Vicuña Mackenna).
¿Dónde queda Le Chateau? → Marín 021, Providencia.
¿Diferencia entre moteles? → Ambos ofrecen los mismos tipos de habitación y precios. Son dos locales distintos con la misma calidad.
¿Incluye desayuno? → No, el servicio es por estadía. No se incluye desayuno.
¿Hay servicio a la habitación? → Puedes consultar disponibilidad de productos en recepción al momento del check-in.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 TU PERSONALIDAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Amable, discreto y profesional en todo momento
- Respetuoso y sin juicios hacia los clientes
- Tono cálido y cercano, propio del habla chilena (puedes usar "po", "cachai", etc. con moderación)
- Eficiente pero nunca apurado
- Usa emojis con moderación para hacer la conversación más amena
- Si no sabes algo con certeza, ofrece consultar con recepción al +56 9 4567 6410

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 PROCESO DE RESERVA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Saludar cálidamente
2. Preguntar en qué puedes ayudar
3. Si quiere reservar: preguntar motel (Apolo o Le Chateau)
4. Preguntar tipo de habitación (Simple, VIP o Jacuzzi)
5. Preguntar duración (3h, 12h/noche o 24h)
6. Preguntar fecha y hora de llegada
7. Verificar disponibilidad con el sistema
8. Pedir nombre del cliente
9. Confirmar datos completos con el precio correcto (semana o finde)
10. Crear reserva y entregar número de habitación asignado

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 ACCIONES DEL SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Cuando necesites verificar disponibilidad o crear una reserva, usa EXACTAMENTE estos bloques:

[ACCION:verificar_disponibilidad]
{"fechaInicio": "2025-03-05T22:00:00", "duracionHoras": 3}
[/ACCION]

[ACCION:crear_reserva]
{"nombre": "Juan Pérez", "telefono": "+56912345678", "tipo": "vip_3h_finde", "fechaInicio": "2025-03-07T22:00:00", "motel": "Apolo"}
[/ACCION]

[ACCION:cancelar_reserva]
{"reservaId": "abc123"}
[/ACCION]

TIPOS VÁLIDOS:
- simple_3h_semana | simple_noche_semana | simple_24h
- simple_3h_finde  | simple_noche_finde
- vip_3h_semana    | vip_noche_semana    | vip_24h
- vip_3h_finde     | vip_noche_finde
- jacuzzi_3h_semana| jacuzzi_noche_semana| jacuzzi_24h
- jacuzzi_3h_finde | jacuzzi_noche_finde

REGLAS CRÍTICAS:
- SIEMPRE verifica disponibilidad antes de confirmar una reserva
- Aplica tarifa FINDE si la llegada es viernes o sábado (o víspera de festivo)
- Si no hay disponibilidad en un motel, ofrece el otro o un horario alternativo
- Para cancelar, pide el número de reserva
- Las 24h tienen el mismo precio semana y finde`;
}

// ── Tabla de precios y duraciones ────────────────────────────
const PRECIOS = {
  simple_3h_semana: 27000, simple_noche_semana: 35000, simple_24h: 55000,
  simple_3h_finde:  29000, simple_noche_finde:  39000,
  vip_3h_semana:    32000, vip_noche_semana:    42000, vip_24h: 65000,
  vip_3h_finde:     37000, vip_noche_finde:     46000,
  jacuzzi_3h_semana:    40000, jacuzzi_noche_semana: 51000, jacuzzi_24h: 75000,
  jacuzzi_3h_finde:     44000, jacuzzi_noche_finde:  53000,
};

const DURACIONES = {
  simple_3h_semana: 3,  simple_3h_finde: 3,
  simple_noche_semana: 12, simple_noche_finde: 12,
  simple_24h: 24,
  vip_3h_semana: 3, vip_3h_finde: 3,
  vip_noche_semana: 12, vip_noche_finde: 12,
  vip_24h: 24,
  jacuzzi_3h_semana: 3, jacuzzi_3h_finde: 3,
  jacuzzi_noche_semana: 12, jacuzzi_noche_finde: 12,
  jacuzzi_24h: 24,
};

// ── Procesar acciones ─────────────────────────────────────────
async function procesarAccion(accion, datos, telefono) {
  switch (accion) {
    case 'verificar_disponibilidad': {
      const result = await consultarDisponibilidad(datos.fechaInicio, datos.duracionHoras || 3);
      return `RESULTADO_DISPONIBILIDAD: ${JSON.stringify(result)}`;
    }
    case 'crear_reserva': {
      const tipo = datos.tipo || 'simple_3h_semana';
      const duracionHoras = DURACIONES[tipo] || 3;
      const precio = PRECIOS[tipo] || 27000;
      const habitacion = await obtenerHabitacionDisponible(datos.fechaInicio, duracionHoras);
      if (!habitacion) {
        return 'RESULTADO_RESERVA: {"ok": false, "error": "Sin habitaciones disponibles"}';
      }
      const result = await crearReserva({
        nombre: datos.nombre,
        telefono: datos.telefono || telefono,
        tipo: tipo.replace(/_/g, ' '),
        fechaInicio: datos.fechaInicio,
        habitacion,
        motel: datos.motel || 'Apolo',
        precio,
      });
      if (result.ok) reservasEnProgreso.set(telefono, result.id);
      return `RESULTADO_RESERVA: ${JSON.stringify({ ...result, habitacion, precio })}`;
    }
    case 'cancelar_reserva': {
      const result = await cancelarReserva(datos.reservaId);
      return `RESULTADO_CANCELACION: ${JSON.stringify(result)}`;
    }
    default:
      return 'ACCION_DESCONOCIDA';
  }
}

async function ejecutarAccionesIA(texto, telefono) {
  const regex = /\[ACCION:(\w+)\]\s*([\s\S]*?)\[\/ACCION\]/g;
  let match, resultados = '';
  while ((match = regex.exec(texto)) !== null) {
    try {
      const datos = JSON.parse(match[2].trim());
      resultados += await procesarAccion(match[1], datos, telefono) + '\n';
    } catch (e) {
      resultados += `ERROR_ACCION: ${e.message}\n`;
    }
  }
  return resultados;
}

function limpiarRespuesta(texto) {
  return texto
    .replace(/\[ACCION:\w+\][\s\S]*?\[\/ACCION\]/g, '')
    .replace(/RESULTADO_\w+:.*\n?/g, '')
    .trim();
}

// ── Función principal ─────────────────────────────────────────
async function procesarMensaje(telefono, mensajeUsuario) {
  if (!conversaciones.has(telefono)) conversaciones.set(telefono, []);
  const historial = conversaciones.get(telefono);
  historial.push({ role: 'user', content: mensajeUsuario });
  const historialReciente = historial.slice(-20);

  try {
    let respuesta = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: getSystemPrompt(),
      messages: historialReciente,
    });

    let textoRespuesta = respuesta.content[0].text;

    if (textoRespuesta.includes('[ACCION:')) {
      const resultados = await ejecutarAccionesIA(textoRespuesta, telefono);
      const respuestaFinal = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: getSystemPrompt(),
        messages: [
          ...historialReciente,
          { role: 'assistant', content: textoRespuesta },
          { role: 'user', content: `SISTEMA: Resultados:\n${resultados}\nResponde al cliente sin bloques [ACCION].` },
        ],
      });
      textoRespuesta = respuestaFinal.content[0].text;
    }

    const respuestaLimpia = limpiarRespuesta(textoRespuesta);
    historial.push({ role: 'assistant', content: respuestaLimpia });
    conversaciones.set(telefono, historial.slice(-40));
    return respuestaLimpia;

  } catch (error) {
    console.error('Error en IA:', error.message);
    return '😔 Ocurrió un error. Por favor contáctanos al +56 9 4567 6410.';
  }
}

function limpiarConversacion(telefono) {
  conversaciones.delete(telefono);
  reservasEnProgreso.delete(telefono);
}

setInterval(() => {
  if (conversaciones.size > 50) {
    const llaves = [...conversaciones.keys()];
    llaves.slice(0, conversaciones.size - 50).forEach(k => conversaciones.delete(k));
  }
}, 60 * 60 * 1000);

module.exports = { procesarMensaje, limpiarConversacion };
