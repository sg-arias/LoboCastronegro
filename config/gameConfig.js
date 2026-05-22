// config/gameConfig.js

const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const MIN_PLAYERS = 3;

const PHASES = {
  LOBBY: 'lobby',
  NIGHT: 'night',
  DISCUSSION: 'discussion',
  VOTING: 'voting',
  GAME_OVER: 'game_over',
};

const DURATIONS_MS = {
  NIGHT: 45000,
  DISCUSSION: 45000,
  VOTING: 30000,
};

module.exports = {
  PORT,
  MIN_PLAYERS,
  PHASES,
  DURATIONS_MS,
};
