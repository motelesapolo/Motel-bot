// ============================================
// ia.js - Motor de IA con Claude (Anthropic)
// Configurado para Motel Apolo & Le Chateau
// ============================================
const Anthropic = require('@anthropic-ai/sdk');
const {
  crearReserva,
  consultarDisponibilidad,
  cancelarReserva,
} = require('./reservas');
require('dotenv').config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const conversaciones = new Map();
const reservasEnProgreso = new Map();
// Guarda { id, googleEventId } de la última reserva confirmada por teléfono
const reservasConfirmadas = new Map();
const clientesEsperandoAgente = new Set(); // clientes que pidieron agente humano

let clienteWhatsApp = null;
const ADMIN_NUMERO = process.env.ADMIN_NUMERO || '';

function setClienteWhatsApp(cliente) {
  clienteWhatsApp = cliente;
}

// ── Detectar saludo según hora ────────────────────────────────
function getSaludo() {
  const hora = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago', hour: 'numeric', hour12: false });
  const h = parseInt(hora);
  if (h >= 6 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 20) return 'Buenas tardes';
  return 'Buenas noches';
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

// Viernes y sábado: SIEMPRE finde (aunque sean feriado)
// Víspera de feriado (lunes-jueves): finde
// Feriado que cae lunes-jueves: normal
// Todo lo demás: normal
function esTarifaFinde(date) {
  const dia = new Date(date.toLocaleString('en-US', { timeZone: 'America/Santiago' })).getDay();
  if (dia === 5 || dia === 6) return true;
  return esVisperaFeriado(date);
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
    const dia = dDate.getDate();
    const mes = meses[dDate.getMonth()];
    const año = dDate.getFullYear();
    const esDiaFinde = esTarifaFinde(dDate);
    const esFeriado = FERIADOS_CHILE.has(toFechaStr(dDate));
    let etiqueta = '';
    if (esFeriado && (dDate.getDay() === 5 || dDate.getDay() === 6)) etiqueta = ' [FERIADO + FIN DE SEMANA]';
    else if (esFeriado) etiqueta = ' [FERIADO - tarifa normal]';
    else if (esVisperaFeriado(dDate)) etiqueta = ' [VÍSPERA FERIADO - tarifa finde]';
    else if (esDiaFinde) etiqueta = ' [FIN DE SEMANA]';
    calendarioPróximos += `- ${nombreDia} ${dia} de ${mes} de ${año}${etiqueta}\n`;
  }

  return `Eres el asistente virtual de Motel Apolo y Motel Le Chateau, dos moteles para adultos ubicados en Providencia, Santiago de Chile. Atiendes 24/7 por WhatsApp.

FECHA Y HORA ACTUAL: ${ahoraStr}
AÑO ACTUAL: ${anioActual}

${calendarioPróximos}
REGLA IMPORTANTE: Para cualquier fecha que mencione el cliente ("el sábado", "mañana", "el 15"), búscala EXACTAMENTE en el calendario de arriba. NUNCA calcules fechas por tu cuenta.
IMPORTANTE SOBRE FECHAS:
- Hoy es ${ahoraStr}
- Cuando el cliente diga "el sábado" o "el próximo sábado", calcula la fecha basándote en HOY exactamente.
- El próximo sábado desde hoy (${ahoraStr}) es el día correcto — NO agregues ni restes días extra.
- Fechas de referencia para marzo 2026: sábado 14, domingo 15, lunes 16, martes 17, miércoles 18, jueves 19, viernes 20, sábado 21.
- NUNCA uses el 15 de marzo como sábado — el sábado de marzo 2026 es el 14 y el 21.
- Cuando confirmes una fecha al cliente, di siempre el día y el número: "sábado 14 de marzo".
TARIFA VIGENTE HOY: ${tarifaHoy}
SALUDO A USAR: "${saludo}, ¿en qué podemos ayudarte? 😊"

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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏨 LOS MOTELES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 MOTEL APOLO
Dirección: Vicuña Mackenna 328, Providencia, Santiago
Teléfono: +56 9 4567 6410 | Horario: 24/7 todos los días incluyendo feriados

📍 MOTEL LE CHATEAU
Dirección: Marín 021, Providencia, Santiago
Teléfono: +56 9 4567 6410 | Horario: 24/7 todos los días incluyendo feriados

IMPORTANTE SOBRE EL ACCESO:
- El estacionamiento está en Marín 021 (Motel Le Chateau), es gratis para clientes, privado y por orden de llegada (NO se puede reservar)
- Si te quedas en Motel Apolo y llegas al estacionamiento de Marín 021, el ingreso a Apolo es por dentro de Le Chateau — hay un pasillo interno que une ambos moteles
- No es necesario llegar en auto, se puede llegar a pie perfectamente
- Metro más cercano: Metro Santa Isabel, a dos cuadras caminando
- Los clientes NO llegan directo a las habitaciones, los recibe recepción

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛏️ HABITACIONES Y PRECIOS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TARIFA SEMANA (domingo a jueves):
🏠 Simple:  Momento/3h $27.000 | 12h/noche $35.000 | 24h $55.000
⭐ VIP:     Momento/3h $32.000 | 12h/noche $42.000 | 24h $65.000
🛁 Jacuzzi: Momento/3h $40.000 | 12h/noche $51.000 | 24h $75.000

TARIFA FIN DE SEMANA (viernes, sábado y vísperas de festivos):
🏠 Simple:  Momento/3h $29.000 | 12h/noche $39.000 | 24h $55.000
⭐ VIP:     Momento/3h $37.000 | 12h/noche $46.000 | 24h $65.000
🛁 Jacuzzi: Momento/3h $44.000 | 12h/noche $53.000 | 24h $75.000

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

HORAS EXTRAS:
- Se pueden pedir máximo 2 horas extras por estadía
- Si quieren quedarse más, deben pagar una estadía completa (momento 3h, 12h o 24h)
- También pueden usar la promoción 6x3 para las horas extras

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
- Si tampoco hay disponibilidad en el otro motel, decir: "Lo sentimos, no tenemos disponibilidad para ese horario. Te invitamos a llamarnos directamente al +56 9 4567 6410 (Apolo anexo 710 / Le Chateau anexo 210) para revisar opciones o hablar con un agente."

HORARIOS DE ESTADÍA:
- Estadía de NOCHE: entrada disponible desde las 22:00 hrs, salida fija a las 12:00 del día siguiente. El cliente puede llegar a las 22:00, 23:00, 23:30 o cualquier hora desde las 22:00.
- Estadía de 12 HORAS: dura exactamente 12 horas corridas y puede comenzar a CUALQUIER hora del día o de la noche. Es un paquete distinto a la noche.
- PRECIO: La noche y las 12 horas tienen el mismo precio. Son tarifas distintas con nombres distintos.
- Si el cliente quiere reservar "por noche" y su llegada sería a las 00:30 o después (01:00, 01:30, 02:00, 03:00, etc.), recomendar la opción de 12 horas porque tendrían más tiempo. Ejemplos de horas que deben recomendar 12 horas: 1:00 AM, 1:30 AM, 2:00 AM, 3:00 AM, 00:30, 01:00, 02:00. La noche siempre termina a las 12:00 del mediodía sin importar a qué hora lleguen.
- NUNCA explicar proactivamente cuántas horas tiene el paquete noche ni hacer cálculos. Solo si el cliente pregunta explícitamente puedes decir que la noche parte a las 22:00 y termina a las 12:00.
- NO mezclar ni comparar el paquete noche con el de 12 horas al presentar opciones.
- Estadía de 24 HORAS: puede comenzar a CUALQUIER hora, sin restricción
- Estadía de 3 HORAS (momento): puede comenzar a CUALQUIER hora

POLÍTICA DE SALIDAS:
- Habitaciones por momento (3h), por noche y por 12 horas: NO se puede salir y volver a entrar. Una vez que se sale, se termina la estadía.
- Habitaciones por 24 horas: SÍ se puede salir y volver a entrar durante el período contratado.
- Solo mencionar el máximo de 3 personas por habitación si el cliente lo pregunta explícitamente. No mencionarlo de forma proactiva.

DECORACIONES: No contamos con decoraciones propias, pero si el cliente llama al motel puede coordinar para ir antes y hacer la decoración él mismo.

ESTACIONAMIENTO: Gratuito para clientes, privado, en Marín 021. Por orden de llegada, no se reserva.

AGUA CALIENTE: Todas las habitaciones tienen agua caliente.

MEDIOS DE PAGO: El pago se realiza al llegar a recepción. Se acepta efectivo, tarjeta de débito y tarjeta de crédito. NO se aceptan transferencias bancarias.
- Solo si el cliente pregunta explícitamente: se puede pagar una parte en efectivo y otra con tarjeta (débito o crédito), pero NO con transferencia.

HORAS EXTRAS:
- Se pueden solicitar máximo 2 horas extras por estadía
- Precio por hora extra: Simple $5.000 | VIP $6.000 | Jacuzzi $7.000
- Si quieren quedarse más de 2 horas extra, deben pagar una estadía completa (momento 3h, 12h o 24h)
- También pueden usar la promoción 6x3 para esto

TELÉFONO DEL MOTEL: +56 9 4567 6410 (disponible 24/7)
ANEXOS (son para llamar desde DENTRO de la habitación hacia recepción, NO para llamadas externas):
- Desde habitación en Motel Apolo: Anexo 710
- Desde habitación en Motel Le Chateau: Anexo 210
IMPORTANTE: Cuando un cliente necesite contactar al motel desde afuera, dar SOLO el número +56 9 4567 6410. NO mencionar los anexos para llamadas externas.

EDAD MÍNIMA: Nuestro servicio es exclusivo para mayores de 18 años. No se permite el ingreso a menores de edad.

COMIDA Y BEBIDAS EXTERNAS (solo mencionar si el cliente pregunta):
- Los pasajeros pueden traer su propia comida y bebidas si lo desean.
- También pueden pedir delivery a la habitación si lo desean.

TIEMPO DE ESPERA DE RESERVA: La reserva se espera durante 30 minutos desde la hora acordada.

PROPINA: Al confirmar una reserva, recordar al cliente que la propina es voluntaria. Ejemplo: "Recuerda que la propina para nuestro personal es completamente voluntaria 😊" Pasado ese tiempo, la habitación puede quedar disponible para otro cliente.

MODIFICACIÓN DE RESERVAS: Si el cliente ya tiene una reserva activa y quiere cambiar algo (fecha, hora, tipo de habitación, motel), debes:
1. Confirmar qué quiere cambiar y pedir el número de reserva si no lo tienes
2. Recopilar los nuevos datos
3. Usar accion "crear_reserva" con los campos "esModificacion": true y "reservaIdAnterior": "NÚMERO_RESERVA_ANTERIOR"
   Ejemplo: {"nombre": "Juan", "fechaInicio": "...", "tipo": "...", "motel": "...", "esModificacion": true, "reservaIdAnterior": "123456"}
4. El sistema borrará automáticamente la reserva anterior de Google Calendar y mantendrá el MISMO número de reserva
5. Informar al cliente que su reserva fue actualizada y que el número de reserva NO cambia

LLEGADA TARDE: Si un cliente dice que llegará más tarde de la hora reservada:
1. Pedir el número de reserva si no lo tienes
2. Modificar la reserva con la nueva hora (usar esModificacion: true y reservaIdAnterior con el número de reserva)
3. Notificar automáticamente al hotel con la nueva hora de llegada
4. Confirmar al cliente que se actualizó su reserva y que el número de reserva se mantiene igual

NÚMERO DE HABITACIÓN: No se asigna número de habitación al momento de la reserva. El número se asigna al llegar a recepción según disponibilidad. Si el cliente desea una habitación específica, debe llamar directamente al motel.

ESTACIONAMIENTO: No se puede reservar estacionamiento, es por orden de llegada y gratuito para clientes.

ACCESIBILIDAD (solo si preguntan): Lamentablemente no contamos con instalaciones adecuadas para personas en silla de ruedas.

BICICLETAS (solo si preguntan): Por el momento no contamos con bicicletero ni estacionamiento para bicicletas.

JUGUETES Y ARTÍCULOS SEXUALES (solo si preguntan): No contamos con venta ni arriendo de juguetes sexuales ni artículos de ese tipo.

CARTA DE PRECIOS:
- Si el cliente pide la carta, el menú, los precios en PDF o similar, envíale este enlace:
  https://drive.google.com/file/d/1xSV-35fgK19uEE8GBuBOStWKQlsygMDd/view?usp=drivesdk
- Puedes decirle algo como: "Aquí te dejo nuestra carta de precios 😊 [enlace]"
- Solo enviar el enlace si el cliente lo pide explícitamente.
- NUNCA envíes este enlace cuando el cliente pida fotos de habitaciones.

FOTOS DE HABITACIONES:
- Si el cliente pide fotos, imágenes o videos de las habitaciones, NO envíes ningún link.
- Responde algo como: "¡Claro! Para mostrarte las fotos de nuestras habitaciones te voy a conectar con uno de nuestros agentes 😊 En breve te contactamos."
- Luego usa la acción TRANSFERIR_AGENTE para notificar al admin con motivo "El cliente solicitó fotos de habitaciones".

RECLAMOS: servicioalcliente@motelesapolo.cl (lunes a viernes 9:00 a 17:00 hrs)

CONTACTO DIRECTO: +56 9 4567 6410

HORARIO: Abiertos 24/7, los 365 días del año, incluyendo todos los feriados, sin excepciones.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 TRANSFERENCIA A AGENTE HUMANO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Si el cliente pide hablar con una persona, dice palabras como "agente", "persona", "recepción", "humano", o si no puedes responder su consulta con certeza, responde EXACTAMENTE así:

"Entendido, te voy a conectar con uno de nuestros agentes para que te pueda ayudar mejor. En breve te contactamos 😊"

Luego incluye este bloque especial al final:
[TRANSFERIR_AGENTE]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 PROCESO DE RESERVA
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Saludar con "${saludo}, ¿en qué podemos ayudarte? 😊"
2. Preguntar motel (Apolo o Le Chateau) si no lo menciona
3. Preguntar tipo de habitación (Simple, VIP o Jacuzzi)
4. Preguntar duración (momento/3h, 6h con promo, 12h/noche o 24h)
5. Preguntar fecha y hora de llegada
   - Si el cliente menciona una hora SIN indicar AM/PM ni formato 24h (ej: "las 10", "a las 11", "a las 9"), SIEMPRE preguntar: "¿Esa hora es AM o PM?" — NUNCA asumir
   - Si dice "22:00", "23:00", "00:00" u otro formato 24h claro, no preguntar
   - Si dice "de noche", "de tarde", "de madrugada", usar el contexto para confirmar la hora exacta
NOTA: NO preguntar cuántas personas. Asumir que son 2. Solo mencionar precio para 3 personas si el cliente lo pregunta explícitamente.
7. Verificar disponibilidad
8. Pedir nombre completo del cliente (nombre y apellido)
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
- simple_3h_semana | simple_noche_semana | simple_24h
- simple_3h_finde  | simple_noche_finde
- vip_3h_semana    | vip_noche_semana    | vip_24h
- vip_3h_finde     | vip_noche_finde
- jacuzzi_3h_semana| jacuzzi_noche_semana| jacuzzi_24h
- jacuzzi_3h_finde | jacuzzi_noche_finde

REGLAS:
- Verifica disponibilidad ANTES de confirmar
- Si son 3 personas, el precio es el doble (solo mencionarlo si el cliente pregunta por capacidad o precio para 3 personas)
- Aplica tarifa finde si la llegada es: viernes, sábado, o víspera de feriado chileno
- Viernes y sábado son SIEMPRE finde (aunque coincidan con feriado)
- Feriado que cae lunes-jueves: tarifa normal, pero su víspera es finde
- El calendario de arriba ya indica cada día si aplica finde o no, úsalo
- Si no hay disponibilidad, ofrece el otro motel o un horario alternativo`;
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
  simple_noche_semana: 12, simple_noche_finde: 12, simple_24h: 24,
  vip_3h_semana: 3, vip_3h_finde: 3,
  vip_noche_semana: 12, vip_noche_finde: 12, vip_24h: 24,
  jacuzzi_3h_semana: 3, jacuzzi_3h_finde: 3,
  jacuzzi_noche_semana: 12, jacuzzi_noche_finde: 12, jacuzzi_24h: 24,
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
const EMPRESA_NUMERO = '56945676410';

async function notificarEmpresa(datos, result, tipo, precio, duracionHoras, telefono) {
  if (!clienteWhatsApp) return;
  try {
    const chatId = `${EMPRESA_NUMERO}@c.us`;
    const tipoLabel = tipo.replace(/_/g, ' ').replace('semana','(semana)').replace('finde','(fin de semana)');
    const inicio = new Date(result.inicio);
    const fin = new Date(result.fin);
    const opFecha = { timeZone: 'America/Santiago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' };
    
    const texto = [
      `📋 *NUEVA RESERVA #${result.id}*`,
      ``,
      `🏨 Motel: ${datos.motel || 'Apolo'}`,
      `👤 Cliente: ${datos.nombre}`,

      `🛏️ Tipo: ${tipoLabel}`,
      `👥 Personas: ${datos.personas || 1}`,
      `💰 Precio: $${precio.toLocaleString('es-CL')} CLP`,
      `🕐 Llegada: ${inicio.toLocaleString('es-CL', opFecha)}`,
      `🕑 Salida est.: ${fin.toLocaleString('es-CL', opFecha)}`,
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
      const result = await consultarDisponibilidad(datos.fechaInicio, datos.duracionHoras || 3, datos.motel || '', datos.tipo || '');
      return `RESULTADO_DISPONIBILIDAD: ${JSON.stringify(result)}`;
    }
    case 'crear_reserva': {
      // Corregir tipo automáticamente según fecha real de llegada
      let tipo = datos.tipo || 'simple_3h_semana';
      const fechaLlegada = new Date(new Date(datos.fechaInicio).toLocaleString('en-US', { timeZone: 'America/Santiago' }));
      const deberiaSerFinde = esTarifaFinde(fechaLlegada);
      if (!tipo.endsWith('_24h')) {
        if (deberiaSerFinde) {
          tipo = tipo.replace(/_semana$/, '_finde');
        } else {
          tipo = tipo.replace(/_finde$/, '_semana');
        }
      }
      const duracionHoras = DURACIONES[tipo] || 3;
      let precio = PRECIOS[tipo] || 27000;
      const personas = datos.personas || 2;
      if (personas === 3) precio = precio * 2;
      const disp = await consultarDisponibilidad(datos.fechaInicio, duracionHoras);
      if (!disp.hayDisponibilidad) {
        return 'RESULTADO_RESERVA: {"ok": false, "error": "Sin disponibilidad en ese horario"}';
      }
      const tipoLabel = tipo.replace(/_/g, ' ').replace('semana','(semana)').replace('finde','(fin de semana)');
      // Si es modificación, recuperar datos de la reserva anterior
      let reservaIdExistente = null;
      let googleEventIdExistente = null;
      if (datos.esModificacion && datos.reservaIdAnterior) {
        const anterior = reservasConfirmadas.get(datos.reservaIdAnterior);
        if (anterior) {
          reservaIdExistente = anterior.id;
          googleEventIdExistente = anterior.googleEventId;
          console.log(`🔄 Modificando reserva ${reservaIdExistente} - borrando evento Calendar ${googleEventIdExistente}`);
        }
      }

      const result = await crearReserva({
        nombre: datos.nombre,
        telefono: datos.telefono || telefono,
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
        // Guardar para futuras modificaciones
        reservasConfirmadas.set(result.id, { id: result.id, googleEventId: result.googleEventId });
        // Notificar al celular de la empresa
        await notificarEmpresa(datos, result, tipo, precio, duracionHoras, telefono);
      }
      return `RESULTADO_RESERVA: ${JSON.stringify({ ...result, precio })}`;
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
    .replace(/\[TRANSFERIR_AGENTE\]/g, '')
    .trim();
}

// ── Función principal ─────────────────────────────────────────
async function procesarMensaje(telefono, mensajeUsuario) {
  // Si el cliente está esperando agente, no responder
  if (clientesEsperandoAgente.has(telefono)) {
    console.log(`👤 Cliente ${telefono} esperando agente humano - ignorando`);
    return null;
  }

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

    // Verificar si hay acciones
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

    // Verificar si se debe transferir a agente
    if (textoRespuesta.includes('[TRANSFERIR_AGENTE]')) {
      clientesEsperandoAgente.add(telefono);
      await notificarAdmin(telefono, mensajeUsuario, 'El cliente solicitó hablar con un agente o el bot no pudo responder');
    }

    const respuestaLimpia = limpiarRespuesta(textoRespuesta);
    historial.push({ role: 'assistant', content: respuestaLimpia });
    conversaciones.set(telefono, historial.slice(-40));
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
}

// Limpiar reserva en progreso después de 2 horas para permitir nueva reserva
function programarLimpiezaReserva(telefono) {
  setTimeout(() => {
    reservasEnProgreso.delete(telefono);
    console.log(`🧹 Reserva en progreso limpiada para ${telefono}`);
  }, 2 * 60 * 60 * 1000);
}

setInterval(() => {
  if (conversaciones.size > 50) {
    const llaves = [...conversaciones.keys()];
    llaves.slice(0, conversaciones.size - 50).forEach(k => conversaciones.delete(k));
  }
}, 60 * 60 * 1000);

module.exports = { procesarMensaje, limpiarConversacion, setClienteWhatsApp, reactivarCliente, esTarifaFinde };
