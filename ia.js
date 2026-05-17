// ============================================
// ia.js - Motor de IA con Claude (Anthropic)
// Configurado para Motel Apolo & Le Chateau
// ============================================
const Anthropic = require('@anthropic-ai/sdk');
const {
  crearReserva,
  consultarDisponibilidad,
  cancelarReserva,
  parsearFechaSantiago,
  cargarReservasDesdeSheets,
} = require('./reservas');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Llamada a la API con reintento automático en caso de rate limit (429)
async function llamarAPI(params, intentos = 3) {
  for (let i = 1; i <= intentos; i++) {
    try {
      return await anthropic.messages.create(params);
    } catch (err) {
      const es429 = err.status === 429 || err.message?.includes('rate_limit');
      if (es429 && i < intentos) {
        const espera = 5000 * i; // 5s, 10s
        console.log(`⏳ Rate limit 429 — reintentando en ${espera/1000}s (intento ${i}/${intentos})`);
        await new Promise(r => setTimeout(r, espera));
      } else {
        throw err;
      }
    }
  }
}
const conversaciones = new Map();
const reservasEnProgreso = new Map();
const reservasConfirmadas = new Map();   // { id, googleEventId } por reservaId
const bloqueosManuales = new Map();      // 'motel_tipo' → true (bloqueado manualmente)
const tarifasEnviadas = new Set();       // teléfonos que ya recibieron la foto de tarifas
const clientesEsperandoAgente = new Set();
const preferenciaCliente = new Map();    // último tipo hab reservado por teléfono
const ultimoMensaje = new Map();         // último mensaje para detectar repetición
const ultimaActividad = new Map();       // timestamp último mensaje para timeout

let clienteWhatsApp = null;
const ADMIN_NUMERO = process.env.ADMIN_NUMERO || '';

function setClienteWhatsApp(cliente) {
  clienteWhatsApp = cliente;
  // Cargar bloqueos manuales persistidos
  cargarBloqueos();
  // Cargar reservas recientes desde Sheets al iniciar
  cargarReservasDesdeSheets().then(mapa => {
    for (const [id, datos] of mapa) {
      reservasConfirmadas.set(id, datos);
    }
    console.log(`✅ ${reservasConfirmadas.size} reservas cargadas desde Sheets`);
  }).catch(err => console.error('Error cargando reservas:', err.message));
}

// ── Detectar saludo según hora ────────────────────────────────
function getSaludo() {
  const hora = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false });
  const h = parseInt(hora);
  if (h >= 6 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

function esMadrugada() {
  const hora = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false });
  return parseInt(hora) >= 2 && parseInt(hora) < 6;
}

function esSinAgente() {
  const ahora = new Date();
  const local = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const minutos = local.getHours() * 60 + local.getMinutes();
  const dia = local.getDay();
  const esFinde = dia === 5 || dia === 6;
  const inicioSinAgente = esFinde ? (23 * 60 + 30) : (22 * 60);
  return minutos >= inicioSinAgente || minutos < (9 * 60);
}

// ── System Prompt completo ────────────────────────────────────
// ── Feriados Chile (fijos + movibles 2025-2030) ───────────────
const FERIADOS_CHILE = new Set([
  // 2025
  '2025-01-01','2025-04-18','2025-04-19','2025-05-01','2025-05-21',
  '2025-06-20','2025-06-29','2025-07-16','2025-08-15','2025-09-18',
  '2025-09-19','2025-10-12','2025-10-31','2025-11-01','2025-11-16',
  '2025-12-08','2025-12-25',
  // 2026
  '2026-01-01','2026-04-03','2026-04-04','2026-05-01','2026-05-21',
  '2026-06-19','2026-06-29','2026-07-16','2026-08-15','2026-09-18',
  '2026-09-19','2026-10-12','2026-10-31','2026-11-01','2026-11-15',
  '2026-12-08','2026-12-25',
  // 2027
  '2027-01-01','2027-03-26','2027-03-27','2027-05-01','2027-05-21',
  '2027-06-25','2027-06-29','2027-07-16','2027-08-15','2027-09-18',
  '2027-09-19','2027-10-12','2027-10-31','2027-11-01','2027-11-21',
  '2027-12-08','2027-12-25',
]);

// Retorna 'YYYY-MM-DD' en zona Santiago
function toFechaStr(date) {
  return date.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
}

// Verifica si el día siguiente es feriado
function esVisperaFeriado(date) {
  const manana = new Date(date);
  manana.setDate(manana.getDate() + 1);
  return FERIADOS_CHILE.has(toFechaStr(manana));
}

// Tarifa finde: viernes desde las 8:00 AM hasta domingo a las 8:00 AM
// Fuera de ese rango: tarifa semana
// Víspera de feriado (desde las 8:00 AM del día anterior): también finde
function esTarifaFinde(date) {
  const local = new Date(date.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
  const dia = local.getDay();    // 0=dom, 1=lun, 2=mar, 3=mié, 4=jue, 5=vie, 6=sáb
  const hora = local.getHours();
  const min = local.getMinutes();
  const minutosDelDia = hora * 60 + min;
  const las8am = 8 * 60;
  const esMadrugada = minutosDelDia < las8am; // 00:00 a 07:59

  // Madrugada del sábado (vie-sáb 00:00-07:59) → finde
  if (dia === 6 && esMadrugada) return true;
  // Sábado desde 08:00 → finde
  if (dia === 6 && !esMadrugada) return true;
  // Sábado completo → finde (ya cubierto arriba)
  // Viernes desde 8:00 AM → finde
  if (dia === 5 && minutosDelDia >= las8am) return true;
  // Madrugada del domingo (sáb-dom 00:00-07:59) → finde
  if (dia === 0 && esMadrugada) return true;
  // Domingo antes de las 8:00 AM → finde (ya cubierto arriba)
  // Víspera de feriado desde las 8:00 AM → finde
  if (minutosDelDia >= las8am && esVisperaFeriado(date)) return true;
  // Madrugada después de víspera de feriado → finde
  if (esMadrugada && esVisperaFeriado(new Date(date.getTime() - 24*60*60*1000))) return true;
  return false;
}

function getSystemPrompt() {
  const ahora = new Date();
  // Obtener fecha actual correcta en Santiago
  const ahoraStr = ahora.toLocaleString('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long', year: 'numeric', month: 'long',
    day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const esFinde = esTarifaFinde(ahora);
  const tarifaHoy = esFinde ? 'FIN DE SEMANA / VÍSPERA DE FESTIVO' : 'SEMANA (domingo a jueves)';
  const anioActual = ahora.getFullYear();
  const saludo = getSaludo();

  // Generar calendario de los próximos 30 días en Santiago para evitar errores de fechas
  const diasSemana = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  
  // Obtener fecha actual en Santiago correctamente
  const fechaSantiago = new Date(ahora.toLocaleString('en-US', {timeZone: 'America/Santiago'}));
  let calendarioPróximos = 'CALENDARIO PRÓXIMOS 60 DÍAS (usa esto para calcular fechas, NO tu propio cálculo):\n';
  for (let i = 0; i < 60; i++) {
    const d = new Date(fechaSantiago);
    d.setDate(fechaSantiago.getDate() + i);
    const dDate = new Date(d.toLocaleString('en-US', {timeZone: 'America/Santiago'}));
    const nombreDia = diasSemana[dDate.getDay()];
    const diaNro = dDate.getDate();
    const mes = meses[dDate.getMonth()];
    const año = dDate.getFullYear();
    const esFeriado = FERIADOS_CHILE.has(toFechaStr(dDate));
    const diaSemana = dDate.getDay();
    let etiqueta = '';
    if (esFeriado) etiqueta = ' [FERIADO - tarifa normal]';
    else if (diaSemana === 5) etiqueta = ' [viernes: semana hasta 7:59AM, finde desde 8:00AM]';
    else if (diaSemana === 6) etiqueta = ' [FIN DE SEMANA - tarifa finde]';
    else if (diaSemana === 0) etiqueta = ' [domingo: finde hasta 7:59AM, semana desde 8:00AM]';
    else if (esVisperaFeriado(dDate)) etiqueta = ' [VÍSPERA FERIADO - finde desde 8:00AM]';
    calendarioPróximos += `- ${nombreDia} ${diaNro} de ${mes} de ${año}${etiqueta}\n`;
  }

  return `Eres el asistente virtual de Motel Apolo y Motel Le Chateau, dos moteles para adultos ubicados en Providencia, Santiago de Chile. Atiendes 24/7 por WhatsApp.

FECHA Y HORA ACTUAL: ${ahoraStr}
AÑO ACTUAL: ${anioActual}

${calendarioPróximos}
REGLA CRÍTICA DE FECHAS: El calendario de arriba es la ÚNICA fuente de verdad para fechas y días de semana. NUNCA uses tu propio conocimiento para determinar qué día cae una fecha.
- Para saber qué día es "el 19 de marzo" o "el jueves", búscalo en el calendario de arriba.
- NUNCA calcules días de semana por tu cuenta — solo lee el calendario.
- Al confirmar una reserva siempre escribe el día y número: "jueves 19 de marzo".
- Hoy es ${ahoraStr}
TARIFA VIGENTE HOY: ${tarifaHoy}
SALUDO A USAR: "${saludo}, ¿en qué podemos ayudarte? 😊"
${esMadrugada() ? `MODO MADRUGADA (2AM-6AM): Sé muy breve y directo. Al saludar presenta este menú:
"${saludo} 👋 ¿En qué te ayudamos?
1️⃣ Reservar  2️⃣ Ver precios  3️⃣ Ubicación  📞 ${process.env.MOTEL_TELEFONO}"
No des explicaciones largas. Concreta rápido.` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 TU PERSONALIDAD
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Eres amable, cálido, discreto y profesional
- Respondes como una persona real, no como un robot
- Usas lenguaje natural chileno (po, cachai, etc. con moderación)
- Nunca juzgas a los clientes
- Usas emojis con moderación
- SIEMPRE saludas con "${saludo}, ¿en qué podemos ayudarte? 😊" al inicio de cada conversación nueva
- Si no sabes algo, ofreces transferir con un agente
- NUNCA inventes ni supongas información que no esté en estas instrucciones. Si no sabes algo responde: "No tengo esa información, pero puedes consultarlo al ${process.env.MOTEL_TELEFONO} 😊"
- NO uses tu conocimiento general para rellenar vacíos. Solo lo que está aquí.
- ESTILO DE RESPUESTA: Cálido pero conciso. Responde exactamente lo que te preguntan, con amabilidad pero sin agregar información extra que el cliente no pidió. SIN asteriscos ni negritas (**texto**), SIN bullets (• o -), sin listas. Máximo 2 emojis por mensaje. Una pregunta a la vez.
  Ejemplos:
  ✅ "¿Tienen estacionamiento?" → "Sí, gratuito en Marín 021 😊"
  ❌ "¿Tienen estacionamiento?" → "Sí, el estacionamiento está en Marín 021, es privado, por orden de llegada, y si te quedas en Apolo hay un pasillo interno..."
  ✅ "¿Cuál es la dirección?" → "Vicuña Mackenna 328, Providencia 😊"
  ❌ "¿Cuál es la dirección?" → "Motel Apolo está en Vicuña Mackenna 328 y Le Chateau en Marín 021, ambos en Providencia cerca del metro..."
- RESUMEN DE RESERVA: incluir toda la info relevante pero sin asteriscos, sin bullets, sin negritas. Formato limpio:

Reserva confirmada ✅
N° [ID] — [Nombre]
[Motel] | [Tipo] | [Fecha] [Hora]
$[Precio] — pago al llegar (efectivo, débito o crédito)
Estacionamiento gratuito en Marín 021
La propina es voluntaria 😊
Tu reserva se mantendrá disponible hasta 45 minutos después de la hora acordada.

PRIORIDAD EN CADA CONVERSACIÓN:
1. Resolver lo que el cliente pregunta
2. Detectar si quiere reservar
3. Guiarlo a concretar la reserva de forma natural

VENTAS (sin hostigar):
- Si el cliente pregunta precios → responde el precio, NO preguntes si quiere reservar a menos que muestre intención clara
- Si el cliente pregunta por precios o tarifas y NO ha recibido la foto aún → usar acción enviar_tarifas
- Si el cliente pregunta por precio de una habitación específica y YA recibió la foto → responder haciendo referencia a la foto anterior: "En la imagen que te mandé antes están todos los precios, incluyendo el de [tipo]"
- NO escribir los precios en texto, siempre referirse a la imagen
- Ejemplo primera vez: [ACCION:enviar_tarifas]{}[/ACCION]
- Si muestra intención de reservar → avanza directo al cierre sin rodeos
- Si duda entre opciones → sugiere una concreta, no preguntes si quiere reservar
- Ofrece reservar MÁXIMO UNA VEZ por conversación. Si el cliente no responde afirmativamente, no vuelvas a preguntar
- Después de mandar fotos NO preguntes si quiere reservar, espera a que el cliente dé el siguiente paso

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏨 LOS MOTELES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 MOTEL APOLO
Dirección: Vicuña Mackenna 328, Providencia, Santiago
Teléfono: ${process.env.MOTEL_TELEFONO} | Horario: 24/7 todos los días incluyendo feriados

📍 MOTEL LE CHATEAU
Dirección: Marín 021, Providencia, Santiago
Teléfono: ${process.env.MOTEL_TELEFONO} | Horario: 24/7 todos los días incluyendo feriados

IMPORTANTE SOBRE EL ACCESO:
- El estacionamiento está en Marín 021, es gratis para clientes de ambos moteles, privado y por orden de llegada (NO se puede reservar)
- Solo mencionar el pasillo interno entre Apolo y Le Chateau si el cliente pregunta específicamente cómo llegar desde el estacionamiento a Apolo
- No es necesario llegar en auto, se puede llegar a pie perfectamente
- Los clientes NO llegan directo a las habitaciones, los recibe recepción
- Metros más cercanos: Metro Santa Isabel y Metro Parque Bustamante. Si preguntan a cuánto están, decir que aproximadamente 5 minutos caminando.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛏️ HABITACIONES Y PRECIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TARIFA SEMANA (domingo 8:00 AM a viernes 7:59 AM):
🏠 Simple:  3h/6x3 $27.000 | Noche $35.000 | 12h $35.000 | 24h $55.000
⭐ VIP:     3h/6x3 $32.000 | Noche $42.000 | 12h $42.000 | 24h $65.000
🛁 Jacuzzi: 3h/6x3 $40.000 | Noche $51.000 | 12h $51.000 | 24h $75.000

TARIFA FIN DE SEMANA (viernes 8:00 AM a domingo 7:59 AM, y vísperas de feriado):
🏠 Simple:  3h/6x3 $29.000 | Noche $39.000 | 12h $39.000 | 24h $55.000
⭐ VIP:     3h/6x3 $37.000 | Noche $46.000 | 12h $46.000 | 24h $65.000
🛁 Jacuzzi: 3h/6x3 $44.000 | Noche $53.000 | 12h $53.000 | 24h $75.000

IMPORTANTE: El precio de 3h y 6x3 es fijo — no cambia según la hora del día. Solo varía entre semana y fin de semana.
NOTA: Noche y 12 horas tienen el mismo precio pero son paquetes distintos. Noche: entrada 22:00-12:00, salida siempre 12:00. 12 horas: 12h corridas desde cualquier hora.



PRECIO PARA 3 PERSONAS: El doble del precio normal.
Ejemplo: Simple semana 3h normalmente $27.000 → con 3 personas $54.000

PROMOCIÓN 6x3 (EXCLUSIVA NUESTRA):
- Pagas el valor de un momento (3h) y te quedas 6 horas (3 horas de regalo)
- Aplica para TODO tipo de habitaciones
- Puedes pedirla presencialmente, por WhatsApp o por nuestra página Motelink: motelesapolo.motelink.cl
- Si no puedes reservar por Motelink, puedes hacerlo directamente por WhatsApp

PROMOCIÓN $22.000 de MotelNow:
- Esta promoción es EXCLUSIVA de MotelNow, nosotros no la gestionamos
- Para esta promo el cliente debe comunicarse directamente con MotelNow
- Para cualquier duda de esa promoción, también dirigirse a MotelNow

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 DESCRIPCIÓN DE HABITACIONES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏠 SIMPLE
Habitación básica y acogedora. Incluye:
✓ Cama doble, ducha y baño privado
✓ Jabón incluido (shampoo, acondicionador y kit dental se cobran aparte)
✓ 2 toallas
✓ Cortesía de bienvenida
✓ Agua caliente
✓ TV

⭐ VIP
Habitación más amplia, linda y mejor decorada que la Simple. Incluye todo lo anterior más:
✓ Mejor decoración y comodidades
✓ Mayor espacio y confort

🛁 JACUZZI
La opción más exclusiva y romántica. Incluye todo lo de VIP más:
✓ Jacuzzi privado en la habitación
✓ Una espuma para el jacuzzi incluida (las siguientes se compran aparte)
✓ 4 toallas (en vez de 2)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🥂 CORTESÍA Y SERVICIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CORTESÍA (incluida en todas las habitaciones, a elección):
- Pisco sour
- Mango sour
- Bebidas a elección (según disponibilidad)
- Agua mineral con gas
- Agua mineral sin gas

SERVICIO DE BAR A LA HABITACIÓN:
- Corto de pisco (con bebida incluida)
- Corto de ron (con bebida incluida)
- Corto de vodka (con bebida incluida)
- Corto de gin (con bebida incluida)
- Corto de whisky (SIN bebida incluida)
- Copa de pisco sour
- Botella de pisco sour

SERVICIO DE COMIDA A LA HABITACIÓN:
- Pizza familiar
- Lasaña
- Bolsas de maní

OTROS PRODUCTOS DISPONIBLES:
- Shampoo y acondicionador (cobro aparte)
- Kit dental (cobro aparte)
- Preservativos (se venden en el motel)
- Espuma adicional para jacuzzi (cobro aparte)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❓ INFORMACIÓN IMPORTANTE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RESERVAS:
- Se pueden hacer en cualquier momento, incluso el mismo día, sin límite de tiempo
- Por WhatsApp, presencialmente o por motelesapolo.motelink.cl
- Si Motelink no funciona, se puede reservar directamente por WhatsApp

CAPACIDAD DE HABITACIONES:
- Motel Apolo: Simple 6 | VIP 3 | Jacuzzi 2
- Motel Le Chateau: Simple 7 | VIP 5 | Jacuzzi 2
- Si no hay disponibilidad para el tipo/motel solicitado, ofrecer el otro motel o un horario diferente
- Si tampoco hay disponibilidad en el otro motel, decir: "Lo sentimos, no tenemos disponibilidad para ese horario. Te invitamos a llamarnos directamente al ${process.env.MOTEL_TELEFONO} (Apolo anexo 710 / Le Chateau anexo 210) para revisar opciones o hablar con un agente."

HORARIOS DE ESTADÍA:
- VALOR NOCHE (22:00 a 12:00): crear reserva directamente. Salida siempre a las 12:00.
- VALOR NOCHE desde 21:30 hasta 21:59: aceptar y crear directamente. Salida a las 12:00.
- VALOR NOCHE desde 21:00 hasta 21:29: el sistema devolverá NOCHE_SUGERIR_EXTRAS. Responder solo si el cliente pregunta: "Puedes llegar a las 21:00 con 1 hora extra y comenzar la noche a las 22:00 😊" Solo mencionarlo si el cliente lo pregunta.
- VALOR NOCHE desde 20:00 hasta 20:59: el sistema devolverá NOCHE_SUGERIR_EXTRAS. Responder solo si el cliente pregunta: "Puedes llegar a las 20:00 con 2 horas extras y comenzar la noche a las 22:00 😊" Solo mencionarlo si el cliente lo pregunta.
- VALOR NOCHE entre 13:00 y 19:59: el sistema devolverá NOCHE_HORA_INVALIDA. Responder: "El horario de noche parte a las 22:00. ¿Te acomoda llegar a esa hora o prefieres 3h, la promo 6x3 o 12 horas?"
- VALOR NOCHE desde 01:00 hasta 12:00: sugerir 12 horas porque le conviene más. Si insiste en noche, crear igual.
- 12 HORAS: 12 horas corridas desde cualquier hora. Solo mencionar si el cliente pregunta.
- 3 HORAS y 6x3: cualquier hora, sin cambios.
- 24 HORAS: cualquier hora, sin cambios.

POLÍTICA DE SALIDAS:
- Habitaciones por momento (3h), noche y 12 horas: en general no se puede salir y volver a entrar. Sin embargo, puede hacerlo UNA persona. Solo si preguntan.
- Habitaciones por 24 horas: SÍ se puede salir y volver a entrar durante el período contratado.
- Solo mencionar el máximo de 3 personas si el cliente lo pregunta explícitamente. No mencionarlo de forma proactiva.

DECORACIONES: No contamos con decoraciones propias, pero si el cliente llama al motel puede coordinar para ir antes y hacer la decoración él mismo.

ESTACIONAMIENTO: Gratuito para clientes, privado, en Marín 021. Por orden de llegada, no se reserva.

AGUA CALIENTE: Todas las habitaciones tienen agua caliente.

WIFI (solo si preguntan): Para consultar sobre WiFi comunícate directamente con el motel al ${process.env.MOTEL_TELEFONO}.

MEDIOS DE PAGO: El pago se realiza al llegar a recepción. Se acepta efectivo, tarjeta de débito y tarjeta de crédito. NO se aceptan transferencias bancarias.
- Solo si el cliente pregunta explícitamente: se puede pagar una parte en efectivo y otra con tarjeta (débito o crédito), pero NO con transferencia.

HORAS EXTRAS:
- Se pueden solicitar máximo 2 horas extras por estadía
- Precio por hora extra: Simple $5.000 | VIP $6.000 | Jacuzzi $7.000
- Si quieren quedarse más de 2 horas extra, deben pagar una estadía completa (3h, noche o 24h)
- También pueden usar la promoción 6x3 para esto

TELÉFONO DEL MOTEL: ${process.env.MOTEL_TELEFONO} (disponible 24/7)
ANEXOS (son para llamar desde DENTRO de la habitación hacia recepción, NO para llamadas externas):
- Desde habitación en Motel Apolo: Anexo 710
- Desde habitación en Motel Le Chateau: Anexo 210
IMPORTANTE: Cuando un cliente necesite contactar al motel desde afuera, dar SOLO el número ${process.env.MOTEL_TELEFONO}. NO mencionar los anexos para llamadas externas.

DIFERENCIA ENTRE MOTELES (solo si preguntan): Ambos son similares en calidad con los mismos tipos de habitación y precios. Cada habitación tiene su propia decoración. Ambos son igual de buenos.

MOTEL JARDÍN Y MOTEL DEL PARQUE: Si alguien pregunta por Motel Jardín (Eulogia Sánchez 85) o Motel Del Parque (Ramón Carnicer 47), responder EXACTAMENTE esto, sin agregar nada más:
"Desde el 1 de Abril, Motel Jardín y Motel Del Parque dejaron de pertenecer a nuestra cadena. Pero estamos funcionando en Motel Apolo y Motel Le Chateau. Te invitamos a conocernos 🙌"

EDAD MÍNIMA: Servicio exclusivo para mayores de 18 años. No se permite el ingreso a menores bajo ninguna circunstancia.

DOCUMENTO DE IDENTIDAD (si preguntan): Es obligatorio para todos los que ingresen a la habitación, por seguridad y por ley. Se acepta cualquier documento con foto: cédula de identidad (carnet), licencia de conducir, pasaporte, o la foto del carnet en el celular. Sin documento no se puede ingresar.

CITÓFONO DAÑADO (solo si preguntan): Si el citófono de la habitación está dañado, puede llamar directamente al ${process.env.MOTEL_TELEFONO}.

RUIDO O PROBLEMAS EN HABITACIÓN (solo si preguntan): Llamar al anexo de recepción desde dentro de la habitación — Apolo: Anexo 710 / Le Chateau: Anexo 210. Sin necesidad de salir.


COMIDA Y BEBIDAS EXTERNAS (solo mencionar si el cliente pregunta):
- Los pasajeros pueden traer su propia comida y bebidas si lo desean.
- También pueden pedir delivery a la habitación si lo desean.

TIEMPO DE ESPERA DE RESERVA: La reserva se espera durante 30 minutos desde la hora acordada.

PROPINA: Al confirmar una reserva, recordar al cliente que la propina es voluntaria. Ejemplo: "Recuerda que la propina para nuestro personal es completamente voluntaria 😊" Pasado ese tiempo, la habitación puede quedar disponible para otro cliente.

MODIFICACIÓN Y CANCELACIÓN DE RESERVAS:
- Nuestras reservas tienen un código de 6 dígitos NUMÉRICOS (ej: 659568)
- SIEMPRE pedir el número de reserva primero antes de hacer cualquier cambio o cancelación
- Si el cliente no tiene el número, decirle que lo busque en el mensaje de confirmación que le enviamos
- Si el código tiene letras y números (ej: AB1234, MN-456X) → es de MotelNow. Decirle: "Esa reserva fue hecha por MotelNow, debes modificarla o cancelarla directamente con ellos."
- Si el código es de 6 dígitos numéricos → es nuestra, proceder:
1. Confirmar qué quiere cambiar
2. Recopilar los nuevos datos
3. Usar accion "crear_reserva" con los campos "esModificacion": true y "reservaIdAnterior": "NÚMERO_RESERVA"
   Ejemplo: {"nombre": "Juan", "fechaInicio": "...", "tipo": "...", "motel": "...", "esModificacion": true, "reservaIdAnterior": "123456"}
4. El sistema borrará la reserva anterior de Google Calendar y mantendrá el MISMO número de reserva
- Si el cliente tiene más de una reserva, preguntarle el número de la reserva que desea modificar o cancelar

LLEGADA TARDE: Si un cliente dice que llegará más tarde de la hora reservada:
1. Modificar la reserva con la nueva hora (usar esModificacion: true)
2. Notificar automáticamente al hotel con la nueva hora de llegada
3. Confirmar al cliente que se actualizó su reserva y el nuevo número

NÚMERO DE HABITACIÓN: No se asigna número de habitación al momento de la reserva. El número se asigna al llegar a recepción según disponibilidad.
- Si el cliente pregunta explícitamente por una habitación específica (ej: "quiero la habitación 5", "¿está disponible la número 3?"), responde: "Con gusto te ayudo con eso, un ejecutivo te atenderá en breve 😊" y usa [TRANSFERIR_AGENTE].
- Solo transferir si el cliente lo pide EXPLÍCITAMENTE. No mencionarlo de forma proactiva.


ACCESIBILIDAD (solo si preguntan): Lamentablemente no contamos con instalaciones adecuadas para personas en silla de ruedas.

LLEGADA SIN RESERVA (solo si preguntan): Sí se puede llegar sin reserva, sujeto a disponibilidad al momento de llegar. Se recomienda reservar con anticipación, especialmente fines de semana.

LLEGADA ANTES DE HORA RESERVADA (solo si preguntan): Sí puede llegar antes, al tener reserva la habitación debería estar disponible.

FUMADORES (solo si preguntan): Según la ley no se debe fumar en las habitaciones, pero si deseas hacerlo tenemos ceniceros a tu disposición 😊

MASCOTAS (solo si preguntan): No se admiten mascotas bajo ninguna circunstancia.

CAMBIO DE ACOMPAÑANTE (solo si preguntan): Si un pasajero entra con una pareja, esta se va y entra otra persona, debe pagar el valor de la habitación nuevamente. Se considera como 3 personas y el valor es el doble.

MÁXIMO DE PERSONAS (solo si preguntan): Máximo 3 personas. No se permiten 4 o más. El valor para 3 personas es el doble del precio normal.

BICICLETAS (solo si preguntan): Por el momento no contamos con bicicletero ni estacionamiento para bicicletas.

CARTA DE PRECIOS:
- Si el cliente pide la carta, el menú, los precios en PDF o similar, envíale este enlace:
  https://drive.google.com/file/d/1xSV-35fgK19uEE8GBuBOStWKQlsygMDd/view?usp=drivesdk
- Puedes decirle algo como: "Aquí te dejo nuestra carta de precios 😊 [enlace]"
- Solo enviar el enlace si el cliente lo pide explícitamente.
- NUNCA envíes este enlace para fotos de habitaciones — para eso existe la acción enviar_fotos.

FOTOS DE HABITACIONES:
- Un tipo, un motel: [ACCION:enviar_fotos]{"motel": "apolo", "tipo": "vip"}[/ACCION]
- Múltiples tipos, un motel: ejecuta una acción por cada tipo pedido:
  [ACCION:enviar_fotos]{"motel": "apolo", "tipo": "simple"}[/ACCION][ACCION:enviar_fotos]{"motel": "apolo", "tipo": "vip"}[/ACCION]
- Todas las habitaciones de un motel: [ACCION:enviar_fotos]{"motel": "apolo", "tipo": "todas"}[/ACCION]
- Un tipo, ambos moteles: [ACCION:enviar_fotos]{"motel": "ambos", "tipo": "jacuzzi"}[/ACCION]
- Múltiples tipos, ambos moteles: una acción por cada tipo con motel "ambos":
  [ACCION:enviar_fotos]{"motel": "ambos", "tipo": "simple"}[/ACCION][ACCION:enviar_fotos]{"motel": "ambos", "tipo": "vip"}[/ACCION]
- Si no especifica motel, pregunta primero cuál motel
- Tipos válidos: "simple", "vip", "jacuzzi", "todas"
- Moteles válidos: "apolo", "lechateau", "ambos"
- Después de las fotos NO preguntes si quiere reservar, deja que el cliente tome la iniciativa

RECLAMOS: ${process.env.EMAIL_RECLAMOS || 'servicioalcliente@motelesapolo.cl'} (lunes a viernes 9:00 a 17:00 hrs)

CONTACTO DIRECTO: ${process.env.MOTEL_TELEFONO}

HORARIO: Abiertos 24/7, los 365 días del año, incluyendo todos los feriados, sin excepciones.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 TRANSFERENCIA A AGENTE HUMANO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Si el cliente pide hablar con una persona, dice palabras como "agente", "persona", "recepción", "humano", o si no puedes responder su consulta con certeza:

${!esSinAgente() ? 
'HAY agentes disponibles: responde "Entendido, te voy a conectar con uno de nuestros agentes para que te pueda ayudar mejor. Estamos recibiendo mensajes por orden de llegada y nos comunicaremos contigo lo más pronto posible 😊" y agrega [TRANSFERIR_AGENTE]' : 
'NO hay agentes disponibles (lunes-jueves desde 22:00, viernes-sábado desde 23:30, hasta las 9:00): responde "En este momento no tenemos agentes disponibles. Puedes llamarnos al ${process.env.MOTEL_TELEFONO} o escribirnos desde las 9:00 😊" — NO uses [TRANSFERIR_AGENTE] para no pausar el bot'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 PROCESO DE RESERVA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Saludar con "${saludo}, ¿en qué podemos ayudarte? 😊"
2. Preguntar motel (Apolo o Le Chateau) si no lo menciona
3. Preguntar tipo de habitación (Simple, VIP o Jacuzzi)
4. Preguntar duración (3h, 6h con promo 6x3, noche o 24h) — NO mencionar las 12h a menos que el cliente pregunte
5. Preguntar fecha y hora de llegada
   - Si el cliente menciona una hora SIN AM/PM ni formato 24h (ej: "las 10", "las 11"), SIEMPRE preguntar: "¿Esa hora es AM o PM?" — NUNCA asumir
   - Si dice "22:00", "23:00" u otro formato 24h claro, no preguntar
   - LÓGICA DE MADRUGADA: Si el cliente pide una hora entre 00:00 y 07:59 y dice "hoy" o no especifica fecha, asumir que es la madrugada del día SIGUIENTE (ej: si hoy es viernes y pide las 00:30, la reserva es para el sábado a las 00:30, no el viernes). Confirmar siempre la fecha exacta al cliente antes de crear la reserva.
   - Si la hora pedida ya pasó hoy, asumir que es para mañana.
6. Asumir que son 2 personas. NO preguntar cuántas personas. Solo mencionar precio para 3 si preguntan explícitamente.
7. Verificar disponibilidad
8. Pedir nombre completo del cliente (nombre y apellido) — OBLIGATORIO. NUNCA crear la reserva sin tener el nombre completo del cliente.
9. Confirmar datos completos con precio correcto
10. Crear reserva y entregar el N° de reserva de 6 dígitos (NO mencionar número de habitación - se asigna al llegar)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 ACCIONES DEL SISTEMA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[ACCION:verificar_disponibilidad]
{"fechaInicio": "2026-03-05T22:00:00", "duracionHoras": 3, "motel": "Apolo", "tipo": "simple"}
[/ACCION]

[ACCION:crear_reserva]
{"nombre": "Juan Pérez", "telefono": "+56912345678", "tipo": "vip_3h_finde", "fechaInicio": "2025-03-07T22:00:00", "motel": "Apolo", "personas": 2}
[/ACCION]

[ACCION:cancelar_reserva]
{"reservaId": "abc123"}
[/ACCION]

TIPOS VÁLIDOS:
- simple_3h_semana | simple_6x3_semana | simple_noche_semana | simple_12h_semana | simple_24h
- simple_3h_finde  | simple_6x3_finde  | simple_noche_finde
- vip_3h_semana    | vip_6x3_semana    | vip_noche_semana    | vip_24h
- vip_3h_finde     | vip_6x3_finde     | vip_noche_finde
- jacuzzi_3h_semana| jacuzzi_6x3_semana| jacuzzi_noche_semana| jacuzzi_24h
- jacuzzi_3h_finde | jacuzzi_6x3_finde | jacuzzi_noche_finde
NOTA: Los tipos 6x3 tienen la misma tarifa que los 3h pero duración de 6 horas (promoción 6x3)

PRECIOS SEGÚN DURACIÓN (MUY IMPORTANTE):
- Si el cliente pidió 3h o 6x3 → usar precio de _3h (semana o finde según fecha)
- Si el cliente pidió noche → usar precio de _noche (semana o finde según fecha)
- Si el cliente pidió 12h → usar precio de _12h (semana o finde según fecha)
- Si el cliente pidió 24h → usar precio de _24h
- NUNCA usar precio de noche para cotizar 3h o 6x3, aunque la hora de llegada sea tarde (23:00, 11 PM, etc.)
- La hora de llegada NO define el tipo de precio — lo define la duración que el cliente eligió

REGLAS:
- Verifica disponibilidad ANTES de confirmar
- Si son 3 personas, el precio es el doble (solo mencionarlo si el cliente pregunta por capacidad o precio para 3 personas)
- El sistema calcula automáticamente la tarifa correcta (semana o finde) según la fecha y hora exacta
- No expliques al cliente los detalles de cuándo cambia la tarifa, solo indica el precio correcto
- SIEMPRE manda la fecha completa con hora en fechaInicio (ej: "2026-04-20T23:00:00"), NUNCA solo la fecha sin hora
- NUNCA confirmes una reserva ni entregues un número de reserva sin antes ejecutar [ACCION:crear_reserva]. El número lo entrega el sistema en RESULTADO_RESERVA, no lo inventes.
- NUNCA digas "procedo a crear tu reserva", "voy a crear tu reserva" o similares sin incluir [ACCION:crear_reserva] en el mismo mensaje.
- Al informar el precio al cliente SIEMPRE usar el precio correcto según la fecha: semana (dom 8AM - vie 7:59AM) o fin de semana (vie 8AM - dom 7:59AM). El sistema calculará el precio final, pero el precio que le muestras al cliente debe ser correcto. Si tienes todos los datos, ejecuta la acción directamente sin anunciarlo.
- NUNCA digas "tu reserva ha sido modificada", "el cambio fue exitoso" o similares sin haber ejecutado [ACCION:crear_reserva] con esModificacion: true en el mismo mensaje. Si tienes todos los datos para modificar, ejecuta la acción directamente.
- Cuando el cliente confirma ("si", "ok", "dale", "perfecto", "de acuerdo", "excelente") y ya tienes nombre, motel, tipo, fecha y hora → ejecutar [ACCION:crear_reserva] INMEDIATAMENTE en ese mismo mensaje. No hacer más preguntas ni decir "perfecto" sin ejecutar la acción.
- Si el sistema responde RESERVA_YA_CREADA: significa que ya se creó una reserva en esta conversación. NO crear otra. Responder con la confirmación de la reserva existente usando el ID que retorna.
- Si el sistema responde BLOQUEADO_MANUALMENTE: no hay disponibilidad de ese tipo de habitación en este momento. Informar al cliente y ofrecer otras opciones disponibles.
- No hay restricción de horario general — se puede reservar a cualquier hora

- Si no hay disponibilidad, ofrece el otro motel o un horario alternativo`;
}

// ── Tabla de precios y duraciones ────────────────────────────
const PRECIOS = {
  simple_3h_semana: 27000, simple_6x3_semana: 27000, simple_noche_semana: 35000, simple_12h_semana: 35000, simple_24h: 55000,
  simple_3h_finde:  29000, simple_6x3_finde:  29000, simple_noche_finde:  39000, simple_12h_finde: 39000,
  vip_3h_semana:    32000, vip_6x3_semana:    32000, vip_noche_semana:    42000, vip_12h_semana: 42000, vip_24h: 65000,
  vip_3h_finde:     37000, vip_6x3_finde:     37000, vip_noche_finde:     46000, vip_12h_finde: 46000,
  jacuzzi_3h_semana: 40000, jacuzzi_6x3_semana: 40000, jacuzzi_noche_semana: 51000, jacuzzi_12h_semana: 51000, jacuzzi_24h: 75000,
  jacuzzi_3h_finde:  44000, jacuzzi_6x3_finde:  44000, jacuzzi_noche_finde:  53000, jacuzzi_12h_finde: 53000,
};

const DURACIONES = {
  simple_3h_semana: 3,  simple_3h_finde: 3,
  simple_6x3_semana: 6, simple_6x3_finde: 6,
  simple_noche_semana: 12, simple_noche_finde: 12, simple_24h: 24,
  simple_12h_semana: 12, simple_12h_finde: 12,
  vip_3h_semana: 3, vip_3h_finde: 3,
  vip_6x3_semana: 6, vip_6x3_finde: 6,
  vip_noche_semana: 12, vip_noche_finde: 12, vip_24h: 24,
  vip_12h_semana: 12, vip_12h_finde: 12,
  jacuzzi_3h_semana: 3, jacuzzi_3h_finde: 3,
  jacuzzi_6x3_semana: 6, jacuzzi_6x3_finde: 6,
  jacuzzi_noche_semana: 12, jacuzzi_noche_finde: 12, jacuzzi_24h: 24,
  jacuzzi_12h_semana: 12, jacuzzi_12h_finde: 12,
};

// ── Notificar al admin ────────────────────────────────────────
async function notificarAdmin(telefono, mensaje, motivo) {
  if (!clienteWhatsApp || !ADMIN_NUMERO) return;
  try {
    const chatId = `${ADMIN_NUMERO}@c.us`;
    const numeroLegible = telefono.startsWith('56') ? `+${telefono}` : `+56${telefono}`;
    const texto = [
      `⚠️ *ATENCIÓN REQUERIDA*`,
      ``,

      `💬 Motivo: ${motivo}`,
      `📝 Último mensaje: "${mensaje}"`,
      ``,
      `El bot pausó las respuestas a este cliente.`,
      `Cuando termines de atenderlo, escribe:`,
      `/activar_cliente ${telefono}`,
    ].join('\n');
    await clienteWhatsApp.sendMessage(chatId, texto);
    console.log(`📨 Admin notificado sobre cliente ${telefono}`);
  } catch (err) {
    console.error('Error notificando admin:', err.message);
  }
}

// ── Notificar al celular de la empresa cuando se crea reserva ─
const EMPRESA_NUMERO = (process.env.EMPRESA_NUMERO || process.env.ADMIN_NUMERO || '').replace('+', '').replace(/\s/g, '');

async function notificarEmpresa(datos, result, tipo, precio, duracionHoras, telefono) {
  if (!clienteWhatsApp) return;
  try {
    const chatId = `${EMPRESA_NUMERO}@c.us`;
    const tipoLabel = tipo.replace(/_/g, ' ').replace('semana','(semana)').replace('finde','(fin de semana)');
    // Parsear fechas correctamente en zona Santiago para evitar desfase de día
    const opFecha = { timeZone: 'America/Santiago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    const inicio = new Date(result.inicio);
    const fin = new Date(result.fin);
    // Verificar que el día de semana sea correcto en Santiago
    const inicioSantiago = inicio.toLocaleString('es-CL', opFecha);
    const finSantiago = fin.toLocaleString('es-CL', opFecha);
    
    const texto = [
      `📋 *NUEVA RESERVA #${result.id}*`,
      ``,
      `🏨 Motel: ${datos.motel || 'Apolo'}`,
      `👤 Cliente: ${datos.nombre}`,

      `🛏️ Tipo: ${tipoLabel}`,
      `👥 Personas: ${datos.personas || 1}`,
      `💰 Precio: $${precio.toLocaleString('es-CL')} CLP`,
      `🕐 Llegada: ${inicioSantiago}`,
      `🕑 Salida est.: ${finSantiago}`,
      `⏳ Esperar hasta: 30 min después de la llegada`,
    ].join('\n');
    
    await clienteWhatsApp.sendMessage(chatId, texto);
    console.log(`📨 Notificación de reserva enviada a empresa`);
  } catch (err) {
    console.error('Error notificando empresa:', err.message);
  }
}

// ── Procesar acciones ─────────────────────────────────────────
async function procesarAccion(accion, datos, telefono) {
  switch (accion) {
    case 'verificar_disponibilidad': {
      // Verificar bloqueos manuales primero
      const motelCheck = (datos.motel || '').toLowerCase().includes('chateau') ? 'chateau' : 'apolo';
      const tipoCheck = (datos.tipo || '').toLowerCase().includes('jacuzzi') ? 'jacuzzi' :
                        (datos.tipo || '').toLowerCase().includes('vip') ? 'vip' : 'simple';
      if (bloqueosManuales.get(`${motelCheck}_${tipoCheck}`)) {
        return `RESULTADO_DISPONIBILIDAD: {"disponibles":0,"ocupadas":0,"total":0,"hayDisponibilidad":false,"bloqueadoManualmente":true}`;
      }
      const result = await consultarDisponibilidad(datos.fechaInicio, datos.duracionHoras || 3, datos.motel || '', datos.tipo || '');
      return `RESULTADO_DISPONIBILIDAD: ${JSON.stringify(result)}`;
    }
    case 'crear_reserva': {
      // Verificar bloqueos manuales antes de crear
      const motelBlq = (datos.motel || '').toLowerCase().includes('chateau') ? 'chateau' : 'apolo';
      const tipoBlq = (datos.tipo || '').toLowerCase().includes('jacuzzi') ? 'jacuzzi' :
                      (datos.tipo || '').toLowerCase().includes('vip') ? 'vip' : 'simple';
      if (bloqueosManuales.get(`${motelBlq}_${tipoBlq}`)) {
        return `RESULTADO_RESERVA: {"ok": false, "error": "BLOQUEADO_MANUALMENTE", "mensaje": "No hay disponibilidad en este momento para ese tipo de habitación"}`;
      }
      // Evitar crear reserva duplicada si ya se creó una en esta conversación recientemente
      const reservaReciente = reservasEnProgreso.get(telefono);
      if (reservaReciente && !datos.esModificacion) {
        return `RESULTADO_RESERVA: {"ok": false, "error": "RESERVA_YA_CREADA", "id": "${reservaReciente}"}`;
      }

      // Si fechaInicio no tiene hora, usar la hora actual en Santiago
      let fechaInicio = datos.fechaInicio || '';
      if (fechaInicio && !fechaInicio.includes('T')) {
        const local = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Santiago' }));
        const hh = String(local.getHours()).padStart(2, '0');
        const mm = String(local.getMinutes()).padStart(2, '0');
        fechaInicio = `${fechaInicio}T${hh}:${mm}:00`;
        console.log(`⚠️ Fecha sin hora corregida a: ${fechaInicio}`);
      }
      datos = { ...datos, fechaInicio };

      // Validar hora para noche
      const _fechaCheck = parsearFechaSantiago(datos.fechaInicio);
      const _localCheck = new Date(_fechaCheck.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
      const _horaCheck = _localCheck.getHours();
      const _minCheck = _localCheck.getMinutes();
      const _minTotalCheck = _horaCheck * 60 + _minCheck;
      if ((datos.tipo || '').toLowerCase().includes('_noche')) {
        // 21:30 en adelante → aceptar
        // 20:00 a 21:29 → sugerir horas extras
        // 13:00 a 19:59 → informar que noche parte a las 22:00
        if (_minTotalCheck >= 13*60 && _minTotalCheck < 20*60) {
          return `RESULTADO_RESERVA: {"ok": false, "error": "NOCHE_HORA_INVALIDA", "hora": ${_horaCheck}}`;
        }
        if (_minTotalCheck >= 20*60 && _minTotalCheck < 21*60 + 30) {
          const extrasRecomendadas = _minTotalCheck < 21*60 ? 2 : 1;
          return `RESULTADO_RESERVA: {"ok": false, "error": "NOCHE_SUGERIR_EXTRAS", "hora": ${_horaCheck}, "minutos": ${_minCheck}, "extrasRecomendadas": ${extrasRecomendadas}}`;
        }
        // 21:30 en adelante y 00:00-12:00 → aceptar noche
      }

      // Corregir tipo automáticamente según fecha real Santiago
      // Fix zona horaria cruce medianoche: convertir siempre a hora local Santiago
      let tipo = datos.tipo || 'simple_3h_semana';
      // Usar parsearFechaSantiago para evitar desfase de timezone
      const fechaLlegada = parsearFechaSantiago(datos.fechaInicio);
      const fechaLlegadaLocal = new Date(fechaLlegada.toLocaleString('en-US', { timeZone: 'America/Santiago' }));
      const deberiaSerFinde = esTarifaFinde(fechaLlegadaLocal);
      if (!tipo.endsWith('_24h')) {
        // Normalizar: asegurar que tenga sufijo _semana o _finde
        if (!tipo.endsWith('_semana') && !tipo.endsWith('_finde')) {
          tipo = tipo + (deberiaSerFinde ? '_finde' : '_semana');
        } else {
          tipo = deberiaSerFinde ? tipo.replace(/_semana$/, '_finde') : tipo.replace(/_finde$/, '_semana');
        }
      }
      const duracionHoras = DURACIONES[tipo] || 3;
      let precio = PRECIOS[tipo] || 27000;
      const personas = datos.personas || 2;
      if (personas === 3) precio = precio * 2;

      // No bloquear múltiples reservas del mismo cliente — Calendar verifica disponibilidad real

      const disp = await consultarDisponibilidad(datos.fechaInicio, duracionHoras);
      if (!disp.hayDisponibilidad) {
        return 'RESULTADO_RESERVA: {"ok": false, "error": "Sin disponibilidad en ese horario"}';
      }
      if (disp.disponibles === 0) {
        await notificarAdmin(telefono, datos.fechaInicio, `⚠️ MOTEL LLENO: No hay habitaciones ${datos.tipo || ''} en ${datos.motel || 'Apolo'}`);
      }

      // Si es modificación, recuperar y borrar reserva anterior
      let reservaIdExistente = null;
      let googleEventIdExistente = null;
      if (datos.esModificacion && datos.reservaIdAnterior) {
        const anterior = reservasConfirmadas.get(datos.reservaIdAnterior);
        if (anterior) {
          reservaIdExistente = anterior.id;
          googleEventIdExistente = anterior.googleEventId;
          console.log(`🔄 Modificando reserva ${reservaIdExistente}`);
        }
      }

      const tipoLabel = tipo.replace(/_/g, ' ').replace('semana','(semana)').replace('finde','(fin de semana)');
      const result = await crearReserva({
        nombre: datos.nombre,
        telefono: telefono, // Siempre usar el teléfono real de WhatsApp
        tipo: tipoLabel,
        fechaInicio: datos.fechaInicio,
        motel: datos.motel || 'Apolo',
        precio,
        duracionHoras,
        reservaIdExistente,
        googleEventIdExistente,
      });
      if (result.ok) {
        reservasEnProgreso.set(telefono, result.id);
        reservasConfirmadas.set(result.id, { id: result.id, googleEventId: result.googleEventId });
        const tipoBase = tipo.replace(/_semana$|_finde$|_24h$/, '').replace(/_noche$/, '');
        preferenciaCliente.set(telefono, tipoBase);
        await notificarEmpresa(datos, result, tipo, precio, duracionHoras, telefono);
        // Opción D: notificar admin si Calendar falló
        if (result.fallback) {
          await notificarAdmin(telefono, datos.nombre,
            `⚠️ ALERTA: Reserva #${result.id} de ${datos.nombre} NO se guardó en Google Calendar por error técnico. Fue guardada en Google Sheets. Verifica manualmente.
Datos: ${datos.motel} | ${tipoLabel} | ${datos.fechaInicio} | $${precio.toLocaleString('es-CL')}`
          );
        }
      }
      return `RESULTADO_RESERVA: ${JSON.stringify({ ...result, precio })}`;
    }
    case 'cancelar_reserva': {
      const result = await cancelarReserva(datos.reservaId);
      return `RESULTADO_CANCELACION: ${JSON.stringify(result)}`;
    }
    case 'enviar_tarifas': {
      return 'RESULTADO_TARIFAS: {"ok": true}';
    }

    case 'enviar_fotos': {
      const motelRaw = (datos.motel || '').toLowerCase();
      const tipo = (datos.tipo || '').toLowerCase();
      const cantidades = {
        apolo:     { simple: 11, vip: 8, jacuzzi: 7 },
        lechateau: { simple: 5,  vip: 6, jacuzzi: 4 },
      };

      // Si pide ambos moteles
      const esAmbos = motelRaw.includes('ambos') || motelRaw.includes('los dos') || motelRaw.includes('both');
      const motel = motelRaw.includes('chateau') ? 'lechateau' : 'apolo';

      if (esAmbos) {
        // Retornar resultado para ambos moteles
        const tipoFinal = (tipo === '' || tipo === 'todas' || tipo === 'todo') ? 'todas' : tipo;
        if (tipoFinal === 'todas') {
          const tipos = ['simple', 'vip', 'jacuzzi'];
          const apolo = tipos.map(t => ({ tipo: t, cantidad: cantidades.apolo[t] }));
          const chateau = tipos.map(t => ({ tipo: t, cantidad: cantidades.lechateau[t] }));
          return `RESULTADO_FOTOS: {"ok": true, "ambos": true, "apolo": {"todas": true, "tipos": ${JSON.stringify(apolo)}}, "lechateau": {"todas": true, "tipos": ${JSON.stringify(chateau)}}}`;
        }
        const cantApolo = cantidades.apolo[tipoFinal] || 0;
        const cantChateau = cantidades.lechateau[tipoFinal] || 0;
        return `RESULTADO_FOTOS: {"ok": true, "ambos": true, "apolo": {"tipo": "${tipoFinal}", "cantidad": ${cantApolo}}, "lechateau": {"tipo": "${tipoFinal}", "cantidad": ${cantChateau}}}`;
      }

      // Un solo motel
      if (tipo === 'todas' || tipo === 'todo' || tipo === 'all' || tipo === '') {
        const tipos = ['simple', 'vip', 'jacuzzi'];
        const resultado = tipos.map(t => ({ tipo: t, cantidad: cantidades[motel][t] }));
        return `RESULTADO_FOTOS: {"ok": true, "motel": "${motel}", "todas": true, "tipos": ${JSON.stringify(resultado)}}`;
      }
      const cantidad = cantidades[motel]?.[tipo] || 0;
      if (cantidad === 0) return 'RESULTADO_FOTOS: {"ok": false, "error": "Tipo o motel inválido"}';
      return `RESULTADO_FOTOS: {"ok": true, "motel": "${motel}", "tipo": "${tipo}", "cantidad": ${cantidad}}`;
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
    .replace(/\[TRANSFERIR_AGENTE\]/g, '')
    .trim();
}

function extraerFotos(resultados) {
  // Parser que cuenta llaves para manejar JSON anidado
  function extraerJSON(texto, desde) {
    let depth = 0, i = desde;
    while (i < texto.length) {
      if (texto[i] === '{') depth++;
      else if (texto[i] === '}') { depth--; if (depth === 0) return texto.slice(desde, i + 1); }
      i++;
    }
    return null;
  }

  const todasFotos = [];
  let pos = 0;
  while (true) {
    const idx = resultados.indexOf('RESULTADO_FOTOS: {', pos);
    if (idx === -1) break;
    const jsonStr = extraerJSON(resultados, idx + 'RESULTADO_FOTOS: '.length);
    if (jsonStr) {
      try {
        const data = JSON.parse(jsonStr);
        if (data.ok) todasFotos.push(data);
      } catch { }
    }
    pos = idx + 1;
  }

  if (todasFotos.length === 0) return null;
  if (todasFotos.length === 1) return todasFotos[0];
  return { ok: true, multiple: true, lista: todasFotos };
}

// ── Función principal ─────────────────────────────────────────
async function procesarMensaje(telefono, mensajeUsuario, numeroPrueba = null) {
  // Si modo prueba activo, ignorar todos excepto el número de prueba
  if (numeroPrueba && telefono !== numeroPrueba) return null;

  // Si el cliente está esperando agente, no responder
  if (clientesEsperandoAgente.has(telefono)) {
    console.log(`👤 Cliente ${telefono} esperando agente humano - ignorando`);
    return null;
  }

  // Timeout: limpiar si pasaron 60 min sin actividad
  const ahoraTs = Date.now();
  const ultimaAct = ultimaActividad.get(telefono);
  if (ultimaAct && (ahoraTs - ultimaAct) > 120 * 60 * 1000) {
    conversaciones.delete(telefono);
    reservasEnProgreso.delete(telefono);
    console.log(`⏰ Conversación de ${telefono} limpiada por inactividad`);
  }
  ultimaActividad.set(telefono, ahoraTs);

  // Detectar mensaje repetido
  const msgNormalizado = mensajeUsuario.trim().toLowerCase();
  const esRepetido = ultimoMensaje.get(telefono) === msgNormalizado;
  ultimoMensaje.set(telefono, msgNormalizado);

  // Si el cliente se despide y el bot ya se despidió antes, no responder
  const despedidas = ['hasta pronto', 'adios', 'adiós', 'chao', 'chau', 'bye', 'hasta luego', 'ok chao', 'ok bye', 'ya chao', 'chao entonces', 'hasta'];
  const msgLower = msgNormalizado.toLowerCase().trim();
  const esDespedida = despedidas.some(d => msgLower === d || msgLower === d + '!' || msgLower === d + '.');
  if (esDespedida) {
    const historialActual = conversaciones.get(telefono) || [];
    const ultimoBot = historialActual.filter(m => m.role === 'assistant').slice(-1)[0]?.content || '';
    const botSeDespidio = ['hasta pronto', 'adios', 'adiós', 'chao', 'te esperamos', '¡hasta', 'hasta la'].some(d => ultimoBot.toLowerCase().includes(d));
    if (botSeDespidio) return null;
  }

  if (!conversaciones.has(telefono)) conversaciones.set(telefono, []);
  const historial = conversaciones.get(telefono);

  // Inyectar notas de sistema si aplica
  const prefCliente = preferenciaCliente.get(telefono);
  const notaPreferencia = prefCliente ? `\n[SISTEMA: Este cliente reservó anteriormente habitación tipo ${prefCliente}. Sugiérela primero si es relevante.]` : '';
  const notaRepeticion = esRepetido ? '\n[SISTEMA: El cliente repitió la misma pregunta. Responde más simple y directo.]' : '';

  historial.push({ role: 'user', content: mensajeUsuario + notaPreferencia + notaRepeticion });
  const historialReciente = historial.slice(-20);

  try {
    // Agregar bloqueos manuales al system prompt
    const bloqueos = [];
    ['apolo','chateau'].forEach(m => {
      ['simple','vip','jacuzzi'].forEach(t => {
        if (bloqueosManuales.get(`${m}_${t}`)) {
          const mn = m === 'chateau' ? 'Le Chateau' : 'Apolo';
          const tn = t.charAt(0).toUpperCase()+t.slice(1);
          bloqueos.push(`- ${tn} en Motel ${mn}: NO DISPONIBLE ahora. No ofrecer. Sugerir alternativas disponibles.`);
        }
      });
    });
    const bloqueosTexto = bloqueos.length > 0
      ? '\n\n⚠️ OCUPACIÓN EN TIEMPO REAL (clientes sin reserva):\n' + bloqueos.join('\n')
      : '';
    const tarifasTexto = tarifasEnviadas.has(telefono)
      ? '\n\n[SISTEMA: Ya se envió la foto de tarifas a este cliente. Si pregunta por precios, hacer referencia a esa foto en vez de mandar de nuevo.]'
      : '';

    let respuesta = await llamarAPI({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: getSystemPrompt() + bloqueosTexto + tarifasTexto,
      messages: historialReciente,
    });

    let textoRespuesta = respuesta.content[0].text;

    // Verificar si hay acciones
    let fotosParaEnviar = null;
    if (textoRespuesta.includes('[ACCION:')) {
      console.log(`🔧 IA ejecutando acción para ${telefono}`);
      console.log(`🔧 Acciones detectadas:`, textoRespuesta.match(/\[ACCION:(\w+)\]/g));
      const resultados = await ejecutarAccionesIA(textoRespuesta, telefono);
      console.log(`🔧 Resultado acciones:`, resultados.substring(0, 200));
      // Capturar tarifas si hay
      if (resultados.includes('RESULTADO_TARIFAS')) {
        fotosParaEnviar = { tarifas: true };
      } else {
        // Capturar fotos si hay
        fotosParaEnviar = extraerFotos(resultados);
      }
      let respuestaFinal;
      try {
        respuestaFinal = await llamarAPI({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: getSystemPrompt() + bloqueosTexto + tarifasTexto,
          messages: [
            ...historialReciente,
            { role: 'assistant', content: textoRespuesta },
            { role: 'user', content: `SISTEMA: Resultados:\n${resultados}\nResponde al cliente sin bloques [ACCION].` },
          ],
        });
        textoRespuesta = respuestaFinal.content[0].text;
      } catch (errFinal) {
        console.error('Error en segunda llamada API:', errFinal.message);
        // Si falla la segunda llamada, armar confirmación con los datos que ya tenemos
        if (resultados.includes('"ok":true') && resultados.includes('"id"')) {
          try {
            const resData = JSON.parse(resultados.match(/RESULTADO_RESERVA: (\{.*\})/)?.[1] || '{}');
            const id = resData.id || '------';
            const nombre = datos.nombre || '';
            const motelNombre = datos.motel === 'LeChateaU' || datos.motel?.toLowerCase().includes('chateau') ? 'Le Chateau' : 'Apolo';
            const tipoLabel = tipo.toLowerCase().includes('jacuzzi') ? 'Jacuzzi' : tipo.toLowerCase().includes('vip') ? 'VIP' : 'Simple';
            const precioStr = resData.precio ? `$${resData.precio.toLocaleString('es-CL')}` : '';
            const inicioDate = resData.inicio ? new Date(resData.inicio).toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
            textoRespuesta = `Reserva confirmada ${nombre ? `para ${nombre}` : ''} 😊
🔖 N° ${id}
🏨 Motel ${motelNombre}
🛏️ ${tipoLabel}
📅 ${inicioDate}
💰 ${precioStr}
Te esperamos. El pago es en recepción al llegar.`;
          } catch {
            const idMatch = resultados.match(/"id":"?(\d+)"?/);
            textoRespuesta = `Reserva confirmada 😊 N° ${idMatch?.[1] || '------'}. Te esperamos.`;
          }
        }
      }
    }

    // Verificar si se debe transferir a agente
    if (textoRespuesta.includes('[TRANSFERIR_AGENTE]')) {
      clientesEsperandoAgente.add(telefono);
      await notificarAdmin(telefono, mensajeUsuario, 'El cliente solicitó hablar con un agente o el bot no pudo responder');
    }

    const respuestaLimpia = limpiarRespuesta(textoRespuesta);
    if (!textoRespuesta.includes('[ACCION:')) {
      console.log(`💬 IA respondió SIN ejecutar acciones para ${telefono}`);
    }
    historial.push({ role: 'assistant', content: respuestaLimpia });
    conversaciones.set(telefono, historial.slice(-40));

    // Si hay tarifas, retornar objeto con tarifas
    if (fotosParaEnviar?.tarifas) {
      tarifasEnviadas.add(telefono);
      return { texto: respuestaLimpia, tarifas: true };
    }
    // Si hay fotos, retornar objeto con texto + info de fotos
    if (fotosParaEnviar) return { texto: respuestaLimpia, fotos: fotosParaEnviar };
    return respuestaLimpia;

  } catch (error) {
    console.error('Error en IA:', error.message);
    // En caso de error, notificar al admin y transferir
    clientesEsperandoAgente.add(telefono);
    await notificarAdmin(telefono, mensajeUsuario, 'Error técnico del bot');
    return 'Te conectaremos con un agente para resolver todas tus dudas 😊';
  }
}

// ── Reactivar bot para un cliente específico ──────────────────
function reactivarCliente(telefono) {
  clientesEsperandoAgente.delete(telefono);
  conversaciones.delete(telefono);
  console.log(`✅ Bot reactivado para cliente ${telefono}`);
}

function limpiarConversacion(telefono) {
  conversaciones.delete(telefono);
  reservasEnProgreso.delete(telefono);
  clientesEsperandoAgente.delete(telefono);
  ultimoMensaje.delete(telefono);
  ultimaActividad.delete(telefono);
}


setInterval(() => {
  if (conversaciones.size > 50) {
    const llaves = [...conversaciones.keys()];
    llaves.slice(0, conversaciones.size - 50).forEach(k => conversaciones.delete(k));
  }
}, 60 * 60 * 1000);

const fs_bloqueos = require('fs');
const BLOQUEOS_FILE = '/tmp/bloqueos.json';

function guardarBloqueos() {
  try {
    const obj = {};
    for (const [k, v] of bloqueosManuales) obj[k] = v;
    fs_bloqueos.writeFileSync(BLOQUEOS_FILE, JSON.stringify(obj));
  } catch (e) { console.error('Error guardando bloqueos:', e.message); }
}

function cargarBloqueos() {
  try {
    if (fs_bloqueos.existsSync(BLOQUEOS_FILE)) {
      const obj = JSON.parse(fs_bloqueos.readFileSync(BLOQUEOS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(obj)) bloqueosManuales.set(k, v);
      console.log(`🔒 Bloqueos cargados: ${bloqueosManuales.size}`);
    }
  } catch (e) { console.error('Error cargando bloqueos:', e.message); }
}

function bloquearHabitacion(motel, tipo) {
  const moteles = motel === 'todo' ? ['apolo', 'chateau'] : [motel];
  const tipos = tipo ? [tipo] : ['simple', 'vip', 'jacuzzi'];
  for (const m of moteles)
    for (const t of tipos)
      bloqueosManuales.set(`${m}_${t}`, true);
  guardarBloqueos();
}

function liberarHabitacion(motel, tipo) {
  const moteles = motel === 'todo' ? ['apolo', 'chateau'] : [motel];
  const tipos = tipo ? [tipo] : ['simple', 'vip', 'jacuzzi'];
  for (const m of moteles)
    for (const t of tipos)
      bloqueosManuales.delete(`${m}_${t}`);
  guardarBloqueos();
}

function getEstadoBloqueos() {
  const moteles = { apolo: 'Motel Apolo', chateau: 'Le Chateau' };
  const tipos = ['simple', 'vip', 'jacuzzi'];
  let msg = '📊 *Disponibilidad manual:*\n';
  for (const [mk, mn] of Object.entries(moteles)) {
    msg += `
*${mn}:*
`;
    for (const t of tipos) {
      const bloqueado = bloqueosManuales.get(`${mk}_${t}`);
      msg += `  ${t.charAt(0).toUpperCase()+t.slice(1)}: ${bloqueado ? '❌ No disponible' : '✅ Disponible'}
`;
    }
  }
  return msg;
}

function estaBloquedo(motel, tipo) {
  const mk = motel.toLowerCase().includes('chateau') ? 'chateau' : 'apolo';
  const tk = tipo.toLowerCase().includes('jacuzzi') ? 'jacuzzi' :
             tipo.toLowerCase().includes('vip') ? 'vip' : 'simple';
  return bloqueosManuales.get(`${mk}_${tk}`) === true;
}

module.exports = { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente, esTarifaFinde, bloquearHabitacion, liberarHabitacion, getEstadoBloqueos, estaBloquedo };
