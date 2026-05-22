// server/src/network/socketHandlers.js
const GameManager = require('../game/GameManager');
const { MIN_PLAYERS } = require('../../config/gameConfig');

// Almacén en memoria: roomCode → GameManager
const rooms = new Map();
// Almacén de jugadores: socketId → { playerId, roomCode, name }
const connectedPlayers = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function generatePlayerId() {
  return `p_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

function getMaxWolves(playerCount) {
  return Math.max(1, Math.floor((playerCount - 1) / 2));
}

function normalizeSettings(settings) {
  const maxPlayersRaw = Number.parseInt(settings?.maxPlayers, 10);
  const maxPlayers = Number.isFinite(maxPlayersRaw) ? maxPlayersRaw : 8;
  const safeMaxPlayers = Math.max(MIN_PLAYERS, Math.min(maxPlayers, 20));
  const maxWolves = getMaxWolves(safeMaxPlayers);

  const wolvesRaw = Number.parseInt(settings?.wolves, 10);
  const wolves = Number.isFinite(wolvesRaw) ? wolvesRaw : 1;
  const safeWolves = Math.max(1, Math.min(wolves, maxWolves));

  return {
    maxPlayers: safeMaxPlayers,
    wolves: safeWolves,
    enableWitch: Boolean(settings?.enableWitch),
    enableSeer: Boolean(settings?.enableSeer),
  };
}

function registerHandlers(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] Conectado: ${socket.id}`);

    // ─── LOBBY ───────────────────────────────────────────────────────────────

    // Host crea una sala
    socket.on('client:room:create', ({ settings } = {}, callback) => {
      const roomCode = generateRoomCode();
      const normalized = normalizeSettings(settings || {});
      rooms.set(roomCode, new GameManager(io, roomCode, normalized));
      socket.join(roomCode);
      socket.join(`host:${roomCode}`); // Sala especial del host

      connectedPlayers.set(socket.id, { isHost: true, roomCode });
      console.log(`[Room] Sala creada: ${roomCode}`);
      callback?.({ success: true, roomCode, settings: normalized });
    });

    // Jugador se une a la sala
    socket.on('client:room:join', ({ name, roomCode }, callback) => {
      const gameManager = rooms.get(roomCode);
      if (!gameManager) {
        return callback?.({ success: false, message: 'Sala no encontrada.' });
      }

      const { PHASES } = require('../../config/gameConfig');
      if (gameManager.state.phase !== PHASES.LOBBY) {
        return callback?.({ success: false, message: 'La partida ya ha comenzado.' });
      }

      if (gameManager.state.getAllPlayers().length >= gameManager.settings.maxPlayers) {
        return callback?.({ success: false, message: 'La sala ya esta llena.' });
      }

      const playerId = generatePlayerId();
      const player = {
        id: playerId,
        name: name.trim().substring(0, 20),
        socketId: socket.id,
        role: null,
      };

      gameManager.state.addPlayer(player);
      socket.join(roomCode);
      connectedPlayers.set(socket.id, { playerId, roomCode, name: player.name });

      // Notificar a todos de la actualización del lobby
      io.to(roomCode).emit('server:room:update', {
        players: gameManager.state.getAllPlayers().map(p => ({ id: p.id, name: p.name })),
        maxPlayers: gameManager.settings.maxPlayers,
      });

      console.log(`[Room] ${player.name} se unió a ${roomCode}`);
      callback?.({ success: true, playerId, playerName: player.name });
    });

    // ─── INICIO DE PARTIDA (solo host) ───────────────────────────────────────

    socket.on('client:game:start', ({ roomCode }, callback) => {
      const gameManager = rooms.get(roomCode);
      const session = connectedPlayers.get(socket.id);

      if (!gameManager || !session?.isHost) {
        return callback?.({ success: false, message: 'No autorizado.' });
      }

      const players = gameManager.state.getAllPlayers();
      if (players.length < MIN_PLAYERS) {
        return callback?.({ success: false, message: `Mínimo ${MIN_PLAYERS} jugadores requeridos.` });
      }

      gameManager.startGame();
      callback?.({ success: true });
    });

    // ─── ACCIONES NOCTURNAS ──────────────────────────────────────────────────

    socket.on('client:action:night', (action, callback) => {
      const session = connectedPlayers.get(socket.id);
      if (!session?.playerId) return callback?.({ success: false });

      const gameManager = rooms.get(session.roomCode);
      if (!gameManager) return callback?.({ success: false });

      const result = gameManager.receiveNightAction(session.playerId, action);
      callback?.(result);
    });

    // ─── VOTACIÓN ────────────────────────────────────────────────────────────

    socket.on('client:vote:cast', ({ targetId }, callback) => {
      const session = connectedPlayers.get(socket.id);
      if (!session?.playerId) return callback?.({ success: false });

      const gameManager = rooms.get(session.roomCode);
      if (!gameManager) return callback?.({ success: false });

      const result = gameManager.castVote(session.playerId, targetId);
      callback?.(result);
    });

    // ─── DESCONEXIÓN ─────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      const session = connectedPlayers.get(socket.id);
      if (session) {
        console.log(`[Socket] Desconectado: ${session.name || 'Host'} (${socket.id})`);
        connectedPlayers.delete(socket.id);

        // Notificar desconexión temporal al room (no eliminar al jugador todavía)
        if (session.roomCode) {
          io.to(session.roomCode).emit('server:player:disconnected', {
            playerId: session.playerId,
          });
        }
      }
    });
  });
}

module.exports = { registerHandlers };
