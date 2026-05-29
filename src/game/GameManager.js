// server/src/game/GameManager.js

const { PHASES, DURATIONS_MS } = require('../../config/gameConfig');

const ROLE_CARDS = {
  villager: {
    name: 'villager',
    displayName: 'Aldeano',
    flavorText: 'Protege el pueblo y descubre a los lobos.',
    abilities: ['Debate y vota para eliminar sospechosos.'],
  },
  werewolf: {
    name: 'werewolf',
    displayName: 'Hombre Lobo',
    flavorText: 'Caza en la oscuridad y evita ser descubierto.',
    abilities: ['Elige un objetivo por la noche.'],
  },
  seer: {
    name: 'seer',
    displayName: 'Vidente',
    flavorText: 'Descubre la verdadera naturaleza de un jugador.',
    abilities: ['Elige un jugador y averigua su bando.'],
  },
  witch: {
    name: 'witch',
    displayName: 'Bruja',
    flavorText: 'Posees una pocion de cura y una de veneno.',
    abilities: ['Puedes salvar a un jugador o eliminar a otro, una vez cada una.'],
  },
};

function shuffle(list) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class GameState {
  constructor() {
    this.phase = PHASES.LOBBY;
    this.nightNumber = 0;
    this.players = [];
  }

  addPlayer(player) {
    this.players.push({ ...player, isAlive: true, team: 'villagers' });
  }

  getAllPlayers() {
    return this.players.slice();
  }

  getAlivePlayers() {
    return this.players.filter(p => p.isAlive);
  }

  getPublicState() {
    return {
      nightNumber: this.nightNumber,
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive,
        role: p.role?.displayName,
        team: p.team,
      })),
    };
  }
}

class GameManager {
  constructor(io, roomCode, settings) {
    this.io = io;
    this.roomCode = roomCode;
    this.settings = settings;
    this.state = new GameState();
    this.votes = new Map();
    this.timers = new Set();
    this.resetNightActions();
    this.witchState = { healUsed: false, poisonUsed: false };
    this.actionLog = [];
  }

  addLog(action, message) {
    this.actionLog.push({
      action,
      message,
      at: Date.now(),
    });
  }

  getActionLog() {
    return this.actionLog.slice();
  }

  resetNightActions() {
    this.nightActions = {
      wolfVotes: new Map(),
      seerTarget: null,
      witchHealTarget: null,
      witchPoisonTarget: null,
      witchSkipped: false,
    };
  }

  clearTimers() {
    this.timers.forEach(t => clearTimeout(t));
    this.timers.clear();
  }

  emitPhase(phase, durationMs = 0) {
    this.state.phase = phase;
    this.io.to(this.roomCode).emit('server:game:phase', {
      phase,
      duration: durationMs,
      publicState: this.state.getPublicState(),
    });
    this.addLog('phase', `Cambio a fase ${phase}`);
  }

  startGame() {
    this.clearTimers();
    this.assignRoles();
    this.sendRoleReveal();
    this.startNight();
  }

  assignRoles() {
    const players = this.state.getAllPlayers();
    const roles = [];

    for (let i = 0; i < this.settings.wolves; i += 1) {
      roles.push('werewolf');
    }
    if (this.settings.enableSeer) roles.push('seer');
    if (this.settings.enableWitch) roles.push('witch');

    while (roles.length < players.length) roles.push('villager');

    const shuffledRoles = shuffle(roles);
    const shuffledPlayers = shuffle(players);

    shuffledPlayers.forEach((player, idx) => {
      const roleName = shuffledRoles[idx];
      player.role = ROLE_CARDS[roleName];
      player.team = roleName === 'werewolf' ? 'wolves' : 'villagers';
    });
    this.addLog('roles:assigned', 'Roles asignados a jugadores');
  }

  sendRoleReveal() {
    const wolves = this.state.players.filter(p => p.team === 'wolves');
    this.state.players.forEach(player => {
      const partners = player.team === 'wolves'
        ? wolves.filter(w => w.id !== player.id).map(w => ({ id: w.id, name: w.name }))
        : [];
      this.io.to(player.socketId).emit('server:role:reveal', {
        role: { ...player.role, partners },
        duration: 3500,
      });
    });
  }

  startNight() {
    this.clearTimers();
    this.resetNightActions();
    this.state.nightNumber += 1;
    this.emitPhase(PHASES.NIGHT, DURATIONS_MS.NIGHT);
    this.sendNightPrompts();
    this.addLog('night:start', `Noche ${this.state.nightNumber} inicia`);

    const timer = setTimeout(() => {
      this.resolveNight();
    }, DURATIONS_MS.NIGHT);
    this.timers.add(timer);
  }

  sendNightPrompts() {
    const alive = this.state.getAlivePlayers();
    const wolves = alive.filter(p => p.team === 'wolves');
    const wolfTargets = alive.filter(p => p.team !== 'wolves')
      .map(p => ({ id: p.id, name: p.name }));

    wolves.forEach(wolf => {
      this.io.to(wolf.socketId).emit('server:night:prompt', {
        title: '🐺 Elige una victima',
        instruction: 'Los lobos deben elegir a quien eliminar.',
        type: 'select_target',
        actionType: 'wolf_kill',
        targets: wolfTargets,
      });
    });

    const seer = alive.find(p => p.role?.name === 'seer');
    if (seer) {
      const seerTargets = alive.filter(p => p.id !== seer.id)
        .map(p => ({ id: p.id, name: p.name }));
      this.io.to(seer.socketId).emit('server:night:prompt', {
        title: '🔮 Mira el destino',
        instruction: 'Elige un jugador para ver su bando.',
        type: 'select_target',
        actionType: 'seer_peek',
        targets: seerTargets,
      });
    }

    const witch = alive.find(p => p.role?.name === 'witch');
    if (witch) {
      const witchTargets = alive.filter(p => p.id !== witch.id)
        .map(p => ({ id: p.id, name: p.name }));
      const actions = [];
      if (!this.witchState.healUsed) {
        actions.push({
          label: 'Usar pocion de cura',
          actionType: 'witch_heal',
          requiresTarget: true,
          targets: witchTargets,
        });
      }
      if (!this.witchState.poisonUsed) {
        actions.push({
          label: 'Usar pocion de veneno',
          actionType: 'witch_poison',
          requiresTarget: true,
          targets: witchTargets,
        });
      }
      actions.push({ label: 'No hacer nada', actionType: 'skip' });

      this.io.to(witch.socketId).emit('server:night:prompt', {
        title: '🧙‍♀️ Bruja',
        instruction: 'Elige tu accion para esta noche.',
        type: 'multi_action',
        actions,
      });
    }
  }

  receiveNightAction(playerId, action) {
    if (this.state.phase !== PHASES.NIGHT) {
      return { success: false, message: 'No es de noche.' };
    }

    const actor = this.state.players.find(p => p.id === playerId);
    if (!actor || !actor.isAlive) {
      return { success: false, message: 'No puedes actuar.' };
    }

    if (actor.team === 'wolves' && action.actionType === 'wolf_kill') {
      if (!action.targetId) return { success: false, message: 'Selecciona un objetivo.' };
      this.nightActions.wolfVotes.set(playerId, action.targetId);
      this.addLog('night:wolf', `Lobo ${actor.name} eligio objetivo`);
      this.tryResolveNightEarly();
      return { success: true };
    }

    if (actor.role?.name === 'seer' && action.actionType === 'seer_peek') {
      if (!action.targetId) return { success: false, message: 'Selecciona un objetivo.' };
      if (this.nightActions.seerTarget) return { success: false, message: 'Ya miraste.' };
      const target = this.state.players.find(p => p.id === action.targetId);
      if (!target) return { success: false, message: 'Objetivo invalido.' };
      this.nightActions.seerTarget = target.id;
      this.addLog('night:seer', `Vidente ${actor.name} observo a ${target.name}`);
      const message = target.team === 'wolves'
        ? `${target.name} parece ser un lobo.`
        : `${target.name} es del pueblo.`;
      this.io.to(actor.socketId).emit('server:night:result', { message });
      this.tryResolveNightEarly();
      return { success: true };
    }

    if (actor.role?.name === 'witch') {
      if (action.actionType === 'skip') {
        this.nightActions.witchSkipped = true;
        this.addLog('night:witch', `Bruja ${actor.name} no actuo`);
        this.tryResolveNightEarly();
        return { success: true };
      }
      if (action.actionType === 'witch_heal') {
        if (this.witchState.healUsed) return { success: false, message: 'La cura ya fue usada.' };
        if (!action.targetId) return { success: false, message: 'Selecciona un objetivo.' };
        this.witchState.healUsed = true;
        this.nightActions.witchHealTarget = action.targetId;
        this.addLog('night:witch', `Bruja ${actor.name} uso cura`);
        this.tryResolveNightEarly();
        return { success: true };
      }
      if (action.actionType === 'witch_poison') {
        if (this.witchState.poisonUsed) return { success: false, message: 'El veneno ya fue usado.' };
        if (!action.targetId) return { success: false, message: 'Selecciona un objetivo.' };
        this.witchState.poisonUsed = true;
        this.nightActions.witchPoisonTarget = action.targetId;
        this.addLog('night:witch', `Bruja ${actor.name} uso veneno`);
        this.tryResolveNightEarly();
        return { success: true };
      }
    }

    return { success: false, message: 'Accion no valida.' };
  }

  tryResolveNightEarly() {
    const alive = this.state.getAlivePlayers();
    const wolves = alive.filter(p => p.team === 'wolves');
    const seerAlive = alive.some(p => p.role?.name === 'seer');
    const witchAlive = alive.some(p => p.role?.name === 'witch');

    const wolvesDone = wolves.length === 0 || this.nightActions.wolfVotes.size >= wolves.length;
    const seerDone = !seerAlive || !!this.nightActions.seerTarget;
    const witchDone = !witchAlive || this.nightActions.witchSkipped || this.nightActions.witchHealTarget || this.nightActions.witchPoisonTarget;

    if (wolvesDone && seerDone && witchDone) {
      this.resolveNight();
    }
  }

  resolveNight() {
    if (this.state.phase !== PHASES.NIGHT) return;

    this.clearTimers();

    const tally = {};
    for (const targetId of this.nightActions.wolfVotes.values()) {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }

    const entries = Object.entries(tally);
    let wolfTarget = null;
    if (entries.length > 0) {
      entries.sort(([, a], [, b]) => b - a);
      const topCount = entries[0][1];
      const tied = entries.filter(([, count]) => count === topCount);
      const choice = tied[Math.floor(Math.random() * tied.length)];
      wolfTarget = choice[0];
    }

    const killed = [];
    const healedTarget = this.nightActions.witchHealTarget;
    if (wolfTarget && wolfTarget !== healedTarget) {
      killed.push({ playerId: wolfTarget, cause: 'wolves' });
    }

    if (this.nightActions.witchPoisonTarget) {
      killed.push({ playerId: this.nightActions.witchPoisonTarget, cause: 'witch' });
    }

    const uniqueKilled = new Map();
    killed.forEach(k => uniqueKilled.set(k.playerId, k));

    uniqueKilled.forEach(k => {
      const victim = this.state.players.find(p => p.id === k.playerId);
      if (victim && victim.isAlive) {
        victim.isAlive = false;
        this.io.to(this.roomCode).emit('server:player:died', { playerId: victim.id });
        this.addLog('night:death', `Muere ${victim.name} (${k.cause})`);
      }
    });

    this.io.to(this.roomCode).emit('server:night:results', {
      killed: Array.from(uniqueKilled.values()),
    });
    this.addLog('night:results', `Resultados de noche: ${uniqueKilled.size} bajas`);

    if (this.checkWin()) return;
    this.startDiscussion();
  }

  startDiscussion() {
    this.clearTimers();
    this.emitPhase(PHASES.DISCUSSION, DURATIONS_MS.DISCUSSION);

    const timer = setTimeout(() => {
      this.openVoting();
    }, DURATIONS_MS.DISCUSSION);
    this.timers.add(timer);
  }

  openVoting() {
    this.votes.clear();
    this.emitPhase(PHASES.VOTING, DURATIONS_MS.VOTING);

    const targets = this.state.getAlivePlayers()
      .map(p => ({ id: p.id, name: p.name }));

    this.io.to(this.roomCode).emit('server:voting:open', { targets });
  }

  castVote(voterId, targetId) {
    if (this.state.phase !== PHASES.VOTING) {
      return { success: false, message: 'La votacion no esta activa.' };
    }

    const voter = this.state.players.find(p => p.id === voterId);
    if (!voter || !voter.isAlive) {
      return { success: false, message: 'No puedes votar.' };
    }

    if (this.votes.has(voterId)) {
      return { success: false, message: 'Ya votaste.' };
    }

    this.votes.set(voterId, targetId);
    this.addLog('vote:cast', `Voto emitido por ${voter?.name || voterId}`);
    this.emitVoteCount();

    const totalVoters = this.state.getAlivePlayers().length;
    if (this.votes.size >= totalVoters) {
      this.finalizeVote();
    }

    return { success: true };
  }

  emitVoteCount() {
    const totalVoters = this.state.getAlivePlayers().length;
    this.io.to(this.roomCode).emit('server:vote:count', {
      votesIn: this.votes.size,
      totalVoters,
    });
  }

  finalizeVote() {
    const tally = {};
    for (const targetId of this.votes.values()) {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }

    const entries = Object.entries(tally);
    let eliminatedId = null;
    let eliminatedName = null;

    if (entries.length > 0) {
      entries.sort(([, a], [, b]) => b - a);
      const [topId, topCount] = entries[0];
      const tied = entries.filter(([, count]) => count === topCount);
      if (tied.length === 1) {
        eliminatedId = topId;
        const eliminated = this.state.players.find(p => p.id === eliminatedId);
        if (eliminated) {
          eliminated.isAlive = false;
          eliminatedName = eliminated.name;
          this.io.to(this.roomCode).emit('server:player:died', { playerId: eliminatedId });
          this.addLog('vote:death', `Eliminado ${eliminated.name} por votacion`);
        }
      }
    }

    this.io.to(this.roomCode).emit('server:vote:result', {
      tally,
      eliminated: eliminatedId,
      eliminatedName,
    });
    this.addLog('vote:result', eliminatedName ? `Eliminado ${eliminatedName}` : 'Empate sin eliminacion');

    if (this.checkWin()) return;
    this.startNight();
  }

  checkWin() {
    const alive = this.state.getAlivePlayers();
    const wolves = alive.filter(p => p.team === 'wolves');
    const villagers = alive.filter(p => p.team !== 'wolves');

    if (wolves.length === 0) {
      this.emitPhase(PHASES.GAME_OVER);
      this.io.to(this.roomCode).emit('server:game:over', {
        winner: 'villagers',
        reason: 'Todos los lobos han sido eliminados.',
        rolesReveal: this.state.players.map(p => ({ name: p.name, role: p.role?.displayName })),
      });
      return true;
    }

    if (wolves.length >= villagers.length) {
      this.emitPhase(PHASES.GAME_OVER);
      this.io.to(this.roomCode).emit('server:game:over', {
        winner: 'wolves',
        reason: 'Los lobos igualaron o superaron al pueblo.',
        rolesReveal: this.state.players.map(p => ({ name: p.name, role: p.role?.displayName })),
      });
      return true;
    }

    return false;
  }
}

module.exports = GameManager;
