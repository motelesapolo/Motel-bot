# 🏨 Bot WhatsApp + IA para Motel (Chile)

Bot inteligente con **Claude AI** que atiende clientes 24/7, toma reservas y las agrega automáticamente a **Google Calendar**.

---

## ✨ Funcionalidades

- 💬 **Chat con IA** — Responde preguntas de forma natural y discreta
- 📅 **Reservas automáticas** — Toma datos y crea eventos en Google Calendar
- ✅ **Verifica disponibilidad** — Consulta el calendario en tiempo real
- ❌ **Cancelaciones** — Procesa solicitudes de cancelación
- ⏰ **Recordatorios** — Envía recordatorios automáticos antes de la llegada
- 🛏️ **Tipos de estadía** — 3h, 6h, 12h y noche completa

---

## 🚀 Instalación Paso a Paso

### PASO 1: Instalar Node.js

Descarga desde https://nodejs.org (versión 18 o superior)

### PASO 2: Descargar el bot

```bash
# Descomprime los archivos en una carpeta, luego:
cd whatsapp-bot
npm install
```

### PASO 3: Obtener API Key de Claude (Anthropic)

1. Ve a https://console.anthropic.com
2. Crea una cuenta y ve a "API Keys"
3. Crea una nueva key y cópiala

### PASO 4: Configurar Google Calendar

**4.1 Crear proyecto en Google Cloud:**
1. Ve a https://console.cloud.google.com
2. Crea un proyecto nuevo (ej: "Motel Bot")
3. Busca "Google Calendar API" y actívala

**4.2 Crear credenciales OAuth:**
1. Ve a "APIs y servicios" → "Credenciales"
2. Clic en "Crear credenciales" → "ID de cliente OAuth 2.0"
3. Tipo de aplicación: "Aplicación de escritorio"
4. Descarga el JSON o copia el `Client ID` y `Client Secret`

**4.3 Obtener Refresh Token:**
```bash
node setup-google.js
```
Sigue las instrucciones en pantalla.

### PASO 5: Configurar variables de entorno

```bash
cp .env.example .env
```

Edita el archivo `.env` con tus datos:

```env
ANTHROPIC_API_KEY=sk-ant-...        # Tu key de Claude
GOOGLE_CLIENT_ID=...                # De Google Cloud
GOOGLE_CLIENT_SECRET=...            # De Google Cloud
GOOGLE_REFRESH_TOKEN=...            # Del paso 4.3
MOTEL_NOMBRE=Mi Motel               # Nombre de tu motel
MOTEL_DIRECCION=Av. Principal 123   # Dirección
MOTEL_TELEFONO=+56912345678         # Teléfono real
PRECIO_3_HORAS=15000                # Precio en CLP
PRECIO_6_HORAS=25000
PRECIO_12_HORAS=35000
PRECIO_NOCHE_COMPLETA=50000
TOTAL_HABITACIONES=10               # Total de habitaciones
```

### PASO 6: Iniciar el bot

```bash
npm start
```

Aparecerá un **código QR** en la terminal. Escanéalo con WhatsApp:
> WhatsApp → tres puntos → Dispositivos vinculados → Vincular dispositivo

---

## ☁️ Deploy en Railway (Servidor Gratuito)

Railway te permite correr el bot 24/7 gratis.

1. Crea cuenta en https://railway.app
2. Conecta tu repositorio de GitHub (sube los archivos)
3. Crea un nuevo proyecto desde el repo
4. En "Variables" agrega todas las del `.env`
5. El bot se desplegará automáticamente

**⚠️ Nota sobre Railway:** La primera vez que el bot inicia en Railway, necesitarás ver el QR en los logs del deploy. Después de escanear, la sesión se guarda.

---

## 💬 Ejemplos de Conversación

**Cliente:** Hola, ¿tienen disponibilidad para esta noche?
**Bot:** ¡Hola! Bienvenido/a a [Motel]. 😊 Claro, tenemos disponibilidad. ¿Qué tipo de estadía prefieres? Tenemos opciones de 3 horas ($15.000), 6 horas ($25.000), 12 horas ($35.000) o noche completa ($50.000).

**Cliente:** Quiero 3 horas para las 10 de la noche
**Bot:** ✅ Hay disponibilidad para hoy a las 22:00. ¿Me podrías dar tu nombre para confirmar la reserva?

**Cliente:** Juan Pérez
**Bot:** 📋 Confirmando tu reserva:
- Habitación: 3
- Llegada: hoy, 22:00 hrs
- Duración: 3 horas
- Total: $15.000

¿Confirmas? (sí/no)

---

## 📁 Estructura del Proyecto

```
whatsapp-bot/
├── index.js          # Bot principal
├── ia.js             # Motor de IA (Claude)
├── reservas.js       # Google Calendar
├── recordatorios.js  # Recordatorios automáticos
├── setup-google.js   # Configurar Google (1 vez)
├── package.json
├── .env.example
└── README.md
```

---

## 💰 Costos Estimados (Mensuales)

| Servicio | Costo |
|----------|-------|
| Railway (servidor) | Gratis (hasta 500h/mes) |
| Claude AI (Anthropic) | ~$5-15 USD (según uso) |
| Google Calendar API | Gratis |
| **Total** | **~$5-15 USD/mes** |

---

## 🆘 Problemas Comunes

**"Cannot read properties of undefined"** → Verifica que el `.env` esté correcto

**QR no aparece** → Borra la carpeta `session/` y reinicia

**Error de Google Calendar** → Repite el `node setup-google.js` para obtener un nuevo refresh token

**El bot no responde** → Verifica que el proceso esté corriendo y que el número esté vinculado

---

## 📞 Soporte

Si tienes problemas, revisa los logs del servidor — el bot registra todos los mensajes y errores.
