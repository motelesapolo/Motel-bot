// ============================================
// patch-wwebjs.js
// Aplica el fix del bug de envío de imágenes de whatsapp-web.js (17-sept-2026).
// WhatsApp Web empezó a incluir una propiedad interna __x_id en el modelo de media
// que pisa el id real del mensaje, rompiendo el envío de imágenes/fotos/tarifas.
// El fix (PR upstream wwebjs#201923) es borrar message.__x_id antes de enviar.
// Este script lo reaplica automáticamente en cada build (Dockerfile), porque
// node_modules se reinstala en cada deploy y el arreglo se perdería si no.
// Es idempotente: si ya está aplicado, no hace nada. Nunca rompe el build.
// ============================================
const fs = require('fs');

const f = 'node_modules/whatsapp-web.js/src/util/Injected/Utils.js';

try {
  let s = fs.readFileSync(f, 'utf8');

  if (s.includes('delete message.__x_id')) {
    console.log('✅ PATCH __x_id: ya estaba aplicado, nada que hacer');
  } else {
    // Anclaje: el cierre del objeto "message" (justo después de ...extraOptions).
    const anchor = '            ...extraOptions,\n        };';
    if (s.includes(anchor)) {
      s = s.replace(anchor, anchor + '\n        delete message.__x_id;');
      fs.writeFileSync(f, s);
      console.log('✅ PATCH __x_id: aplicado correctamente (arregla el envío de imágenes)');
    } else {
      console.log('⚠️ PATCH __x_id: no se encontró el punto de anclaje. El bot arranca igual, pero el envío de imágenes podría fallar. Avisar para revisar.');
    }
  }
} catch (e) {
  console.log('⚠️ PATCH __x_id: no se pudo aplicar (' + e.message + '). El bot arranca igual.');
}
