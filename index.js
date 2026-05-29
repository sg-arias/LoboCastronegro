// server/index.js
// ─── Punto de entrada principal del servidor ───────────────────────────────────

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const QRCode = require('qrcode');

const { registerHandlers } = require('./src/network/socketHandlers');
const { PORT, MIN_PLAYERS } = require('./config/gameConfig');

// ─── Configuración del servidor ────────────────────────────────────────────────

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*', // En LAN local, permitir todos los orígenes
    methods: ['GET', 'POST'],
  },
  pingTimeout: 10000,
  pingInterval: 5000,
});

// ─── Servir archivos estáticos ─────────────────────────────────────────────────

// Interfaz del Host (pantalla proyectada)
app.use('/host', express.static(path.join(__dirname, 'client/host')));
// Interfaz del Jugador (movil/web)
app.use('/', express.static(path.join(__dirname, 'client/player')));
// Recursos compartidos
app.use('/shared', express.static(path.join(__dirname, 'client/shared')));

// ─── Endpoints HTTP ────────────────────────────────────────────────────────────

// QR code del servidor para jugadores
app.get('/qr', async (req, res) => {
  const localIP = getLocalIP();
  const host = process.env.HOST_IP || localIP || req.hostname || '127.0.0.1';
  const roomParam = req.query.room;
  const joinPath = roomParam ? `/join?room=${encodeURIComponent(roomParam)}` : '/join';
  const url = `http://${host}:${PORT}${joinPath}`;
  try {
    const qrDataURL = await QRCode.toDataURL(url, { width: 300, margin: 2 });
    res.json({ qr: qrDataURL, url });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo generar el QR' });
  }
});

// Ruta de unión (redirige a la SPA del jugador)
app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/player/index.html'));
});

// Estado del servidor (útil para debug)
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    ip: getLocalIP(),
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// Configuracion publica para el cliente host
app.get('/config', (req, res) => {
  res.json({
    minPlayers: MIN_PLAYERS,
  });
});

// ─── WebSocket handlers ────────────────────────────────────────────────────────

registerHandlers(io);

// ─── Arrancar servidor ─────────────────────────────────────────────────────────

httpServer.listen(PORT, '0.0.0.0', async () => {
  const localIP = getLocalIP();
  const host = process.env.HOST_IP || localIP || '127.0.0.1';
  const playerURL = `http://${host}:${PORT}`;
  const hostURL = `http://${host}:${PORT}/host`;

  console.log('\n' + '═'.repeat(55));
  console.log('  🐺  LOBOS DE LA OSCURIDAD — Servidor iniciado');
  console.log('═'.repeat(55));
  console.log(`  📺  Host (pantalla proyectada): ${hostURL}`);
  console.log(`  📱  Jugadores (escáner QR):      ${playerURL}`);
  console.log('─'.repeat(55));

  // Generar y mostrar QR en consola
  try {
    const qrString = await QRCode.toString(playerURL, { type: 'terminal', small: true });
    console.log('\n  Jugadores escanean este QR:\n');
    console.log(qrString);
  } catch (_) {
    console.log(`  URL manual para jugadores: ${playerURL}`);
  }

  console.log('═'.repeat(55) + '\n');
});

// ─── Utilidades ────────────────────────────────────────────────────────────────

function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (const name of Object.keys(interfaces)) {

    // Ignorar interfaces virtuales
    const lower = name.toLowerCase();

    if (
      lower.includes('virtual') ||
      lower.includes('vmware') ||
      lower.includes('vbox') ||
      lower.includes('hyper-v')
    ) {
      continue;
    }

    for (const iface of interfaces[name]) {

      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        !iface.address.startsWith('169.254')
      ) {

        // Preferir IPs típicas LAN
        if (
          iface.address.startsWith('192.168.') ||
          iface.address.startsWith('10.') ||
          iface.address.startsWith('172.')
        ) {
          return iface.address;
        }
      }
    }
  }

  return '127.0.0.1';
}

// Manejo de errores del proceso
process.on('uncaughtException', (err) => {
  console.error('[Error] Excepción no manejada:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Error] Promise rechazada:', reason);
});
