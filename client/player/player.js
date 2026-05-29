// client/player/player.js
// Lógica principal del cliente jugador (SPA mobile-first)

(function() {
  'use strict';

  // ─── Estado del Cliente ────────────────────────────────────────────────────

  const state = {
    socket: null,
    playerId: null,
    playerName: null,
    roomCode: null,
    myRole: null,
    currentScreen: 'join',
    selectedTarget: null,
    hasVoted: false,
    phaseTimer: null,
    phaseDuration: 0,
    phaseStart: 0,
  };

  function prefillRoomCode() {
    const params = new URLSearchParams(window.location.search);
    const room = params.get('room');
    if (!room) return;

    const code = room.toUpperCase().substring(0, 5);
    const input = document.getElementById('room-code');
    input.value = code;
    input.readOnly = true;
    input.style.opacity = '0.85';
    const nameInput = document.getElementById('player-name');
    if (nameInput) nameInput.focus();
  }

  // ─── UI Helpers ────────────────────────────────────────────────────────────

  function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const screen = document.getElementById(`screen-${name}`);
    if (screen) {
      screen.classList.add('active');
      state.currentScreen = name;
    }
  }

  function showToast(message, duration = 3500) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
  }

  function setStatus(elementId, message, type = '') {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.textContent = message;
    el.className = `status-msg ${type}`;
  }

  function startTimerBar(fillId, durationMs) {
    const fill = document.getElementById(fillId);
    if (!fill) return;

    clearTimeout(state.phaseTimer);
    state.phaseDuration = durationMs;
    state.phaseStart = Date.now();

    fill.style.transition = 'none';
    fill.style.width = '100%';

    setTimeout(() => {
      fill.style.transition = `width ${durationMs}ms linear`;
      fill.style.width = '0%';
    }, 50);
  }

  // ─── Roles: Iconos y Colores ───────────────────────────────────────────────

  const ROLE_DISPLAY = {
    villager: { icon: '🧑‍🌾', colorClass: 'village', label: 'Aldeano' },
    werewolf: { icon: '🐺', colorClass: 'wolf',    label: 'Hombre Lobo' },
    seer:     { icon: '🔮', colorClass: 'village', label: 'Vidente' },
    witch:    { icon: '🧙‍♀️', colorClass: 'village', label: 'Bruja' },
    cupid:    { icon: '💘', colorClass: 'village', label: 'Cupido' },
    hunter:   { icon: '🏹', colorClass: 'village', label: 'Cazador' },
  };

  // ─── Conexión al Servidor ──────────────────────────────────────────────────

  function connect() {
    state.socket = io({ reconnection: true, reconnectionDelay: 1000 });

    state.socket.on('connect', () => {
      console.log('[Socket] Conectado');
    });

    state.socket.on('disconnect', () => {
      showToast('⚠️ Conexión perdida. Reconectando...');
    });

    // ─── Eventos del Servidor ──────────────────────────────────────────────

    state.socket.on('server:room:update', ({ players }) => {
      updatePlayerList(players);
    });

    state.socket.on('server:game:phase', ({ phase, duration, publicState }) => {
      handlePhaseChange(phase, duration, publicState);
    });

    state.socket.on('server:role:reveal', ({ role, duration }) => {
      state.myRole = role;
      renderRoleReveal(role);
      showScreen('role');
      // Auto-avanzar a la siguiente fase después del reveal
      setTimeout(() => {}, duration);
    });

    state.socket.on('server:night:prompt', (prompt) => {
      renderNightPrompt(prompt);
      showScreen('night');
    });

    state.socket.on('server:night:result', (result) => {
      showToast(result.message, 6000);
    });

    state.socket.on('server:role:lover_reveal', ({ partnerName, message }) => {
      showToast(message, 8000);
    });

    state.socket.on('server:voting:open', ({ targets }) => {
      renderVoteTargets(targets);
    });

    state.socket.on('server:vote:count', ({ votesIn, totalVoters }) => {
      const el = document.getElementById('votes-count');
      if (el) el.textContent = `${votesIn} de ${totalVoters} votos emitidos`;
    });

    state.socket.on('server:vote:result', (result) => {
      const eliminatedName = result.eliminatedName || result.eliminated;
      const player = eliminatedName
        ? `${eliminatedName} ha sido eliminado`
        : 'Empate — nadie es eliminado';
      showToast(`⚖️ Resultado: ${player}`, 5000);
    });

    state.socket.on('server:player:died', ({ playerId }) => {
      if (playerId === state.playerId) {
        showScreen('dead');
      } else {
        showToast(`💀 Un jugador ha sido eliminado`);
      }
    });

    state.socket.on('server:night:results', ({ killed }) => {
      if (killed.length === 0) {
        showToast('🌅 Nadie murió esta noche.');
      } else {
        showToast(`🌅 ${killed.length} jugador(es) han caído esta noche...`);
      }
    });

    state.socket.on('server:game:over', ({ winner, reason, rolesReveal }) => {
      renderGameOver(winner, reason, rolesReveal);
    });

    state.socket.on('server:room:closed', () => {
      showToast('La sala fue cerrada por el narrador.', 5000);
      state.playerId = null;
      state.roomCode = null;
      showScreen('join');
    });
  }

  // ─── Unirse a la Sala ──────────────────────────────────────────────────────

  function joinRoom() {
    const name = document.getElementById('player-name').value.trim();
    const code = document.getElementById('room-code').value.trim().toUpperCase();

    if (!name) return setStatus('join-status', 'Introduce tu nombre.', 'error');
    if (!code || code.length < 4) return setStatus('join-status', 'Introduce el código de sala.', 'error');

    setStatus('join-status', 'Conectando...', '');
    document.getElementById('btn-join').disabled = true;

    state.socket.emit('client:room:join', { name, roomCode: code }, (response) => {
      document.getElementById('btn-join').disabled = false;
      if (response?.success) {
        state.playerId = response.playerId;
        state.playerName = response.playerName;
        state.roomCode = code;
        document.getElementById('lobby-code-badge').textContent = code;
        showScreen('lobby');
        setStatus('join-status', '', '');
      } else {
        setStatus('join-status', response?.message || 'Error al unirse.', 'error');
      }
    });
  }

  // ─── Actualizar Lista de Jugadores ────────────────────────────────────────

  function updatePlayerList(players) {
    const list = document.getElementById('player-list');
    if (!list) return;
    list.innerHTML = '';

    players.forEach(player => {
      const isMe = player.id === state.playerId;
      const initials = player.name.substring(0, 2).toUpperCase();
      const div = document.createElement('div');
      div.className = 'player-item';
      div.innerHTML = `
        <div class="player-avatar">${initials}</div>
        <span class="player-name">${player.name}</span>
        ${isMe ? '<span class="player-you">TÚ</span>' : ''}
      `;
      list.appendChild(div);
    });
  }

  function updateAlivePlayers(publicState) {
    if (!publicState?.players) return;
    const list = document.getElementById('alive-players-day');
    if (!list) return;
    list.innerHTML = '';

    publicState.players.filter(p => p.isAlive).forEach(player => {
      const initials = player.name.substring(0, 2).toUpperCase();
      const div = document.createElement('div');
      div.className = 'player-item';
      div.innerHTML = `
        <div class="player-avatar">${initials}</div>
        <span class="player-name">${player.name}</span>
      `;
      list.appendChild(div);
    });
  }

  // ─── Renderizar Reveal de Rol ──────────────────────────────────────────────

  function renderRoleReveal(role) {
    const display = ROLE_DISPLAY[role.name] || { icon: '🎭', colorClass: 'village', label: role.displayName };

    document.getElementById('role-icon').textContent = display.icon;
    const titleEl = document.getElementById('role-title');
    titleEl.textContent = role.displayName;
    titleEl.className = `role-title ${display.colorClass}`;
    document.getElementById('role-flavor').textContent = role.flavorText;

    const abilitiesEl = document.getElementById('role-abilities');
    abilitiesEl.innerHTML = role.abilities.map(a =>
      `<div class="ability-item"><span class="ability-dot">✦</span><span>${a}</span></div>`
    ).join('');

    // Si es lobo, mostrar compañeros
    if (role.name === 'werewolf' && role.partners?.length > 0) {
      const partnerNames = role.partners.map(p => p.name).join(', ');
      abilitiesEl.innerHTML += `
        <div class="ability-item" style="margin-top:12px;color:#c090d8">
          <span class="ability-dot">🐺</span>
          <span>Compañeros: <strong>${partnerNames}</strong></span>
        </div>`;
    }
  }

  // ─── Cambio de Fase ────────────────────────────────────────────────────────

  function handlePhaseChange(phase, duration, publicState) {
    const PHASES = {
      lobby: 'lobby',
      discussion: 'discussion',
      voting: 'vote',
      night: 'night',
      game_over: null,
    };

    const screenName = PHASES[phase];

    // Resetear timers
    if (duration > 0) {
      if (phase === 'discussion') startTimerBar('discussion-timer-fill', duration);
      if (phase === 'voting') startTimerBar('vote-timer-fill', duration);
    }

    if (publicState) {
      updateAlivePlayers(publicState);
      const badge = document.getElementById('discussion-phase-badge');
      if (badge) badge.textContent = `Noche ${publicState.nightNumber}`;
    }

    if (phase === 'discussion') {
      showToast('📢 Debatid. La votación comenzará pronto.', 5000);
    }

    if (phase === 'night' || phase === 'night_first') {
      // El servidor enviará un 'server:night:prompt' si tenemos acción
      // Si no, mostrar pantalla de espera nocturna
      document.getElementById('night-title').textContent = '🌑 La oscuridad cae...';
      document.getElementById('night-instruction').textContent = 'Cierra los ojos y espera tu llamada.';
      document.getElementById('night-targets').innerHTML = '';
      document.getElementById('btn-night-confirm').style.display = 'none';
      showScreen('night');
      return;
    }

    if (phase === 'voting') {
      state.hasVoted = false;
      document.getElementById('vote-status').style.display = 'none';
      document.getElementById('btn-vote-confirm').style.display = 'none';
      showScreen('vote');
      return;
    }

    if (screenName) showScreen(screenName);
  }

  // ─── Prompt Nocturno ───────────────────────────────────────────────────────

  function renderNightPrompt(prompt) {
    state.selectedTarget = null;
    document.getElementById('night-title').textContent = prompt.title;
    document.getElementById('night-instruction').textContent = prompt.instruction;
    document.getElementById('btn-night-confirm').dataset.actionType = '';

    const targetsEl = document.getElementById('night-targets');
    targetsEl.innerHTML = '';

    if (prompt.type === 'select_target' && prompt.targets) {
      prompt.targets.forEach(target => {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.dataset.targetId = target.id;
        btn.innerHTML = `
          <div class="target-avatar">${target.name.substring(0, 2).toUpperCase()}</div>
          <span>${target.name}</span>
        `;
        btn.addEventListener('click', () => {
          document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          state.selectedTarget = target.id;
          document.getElementById('btn-night-confirm').dataset.actionType = prompt.actionType || 'select';
          document.getElementById('btn-night-confirm').style.display = 'block';
        });
        targetsEl.appendChild(btn);
      });
    }

    if (prompt.type === 'multi_action' && prompt.actions) {
      prompt.actions.forEach(action => {
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.innerHTML = `<span style="flex:1">${action.label}</span>`;
        btn.addEventListener('click', () => {
          if (action.actionType === 'skip') {
            sendNightAction({ actionType: 'skip' });
          } else if (action.requiresTarget) {
            // Mostrar sub-lista de targets para veneno
            renderSubTargets(action.targets, action.actionType);
          } else {
            sendNightAction({ actionType: action.actionType, targetId: action.targetId });
          }
        });
        targetsEl.appendChild(btn);
      });
    }
  }

  function renderSubTargets(targets, actionType) {
    const targetsEl = document.getElementById('night-targets');
    targetsEl.innerHTML = '<div style="color:var(--text-dim);font-style:italic;padding:8px 0">Elige tu objetivo:</div>';
    targets.forEach(target => {
      const btn = document.createElement('button');
      btn.className = 'target-btn';
      btn.innerHTML = `
        <div class="target-avatar">${target.name.substring(0, 2).toUpperCase()}</div>
        <span>${target.name}</span>
      `;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.selectedTarget = target.id;
        document.getElementById('btn-night-confirm').dataset.actionType = actionType;
        document.getElementById('btn-night-confirm').style.display = 'block';
      });
      targetsEl.appendChild(btn);
    });
  }

  function sendNightAction(action) {
    state.socket.emit('client:action:night', action, (result) => {
      if (result?.success) {
        document.getElementById('night-title').textContent = '✓ Acción registrada';
        document.getElementById('night-instruction').textContent = 'Espera a que los demás terminen...';
        document.getElementById('night-targets').innerHTML = '';
        document.getElementById('btn-night-confirm').style.display = 'none';
        showToast('Tu acción ha sido registrada.');
      } else {
        showToast(result?.message || 'Error en la acción.', 3000);
      }
    });
  }

  // ─── Votación ──────────────────────────────────────────────────────────────

  function renderVoteTargets(targets) {
    const el = document.getElementById('vote-targets');
    el.innerHTML = '';
    state.selectedTarget = null;

    targets.filter(t => t.id !== state.playerId).forEach(target => {
      const btn = document.createElement('button');
      btn.className = 'target-btn';
      btn.dataset.targetId = target.id;
      btn.innerHTML = `
        <div class="target-avatar" style="background:var(--surface)">${target.name.substring(0,2).toUpperCase()}</div>
        <span>${target.name}</span>
      `;
      btn.addEventListener('click', () => {
        document.querySelectorAll('#vote-targets .target-btn').forEach(b => b.classList.remove('vote-selected'));
        btn.classList.add('vote-selected');
        state.selectedTarget = target.id;
        document.getElementById('btn-vote-confirm').style.display = 'block';
      });
      el.appendChild(btn);
    });
  }

  function castVote() {
    if (!state.selectedTarget || state.hasVoted) return;
    state.socket.emit('client:vote:cast', { targetId: state.selectedTarget }, (result) => {
      if (result?.success) {
        state.hasVoted = true;
        document.getElementById('vote-status').style.display = 'block';
        document.getElementById('btn-vote-confirm').style.display = 'none';
        document.querySelectorAll('#vote-targets .target-btn').forEach(b => b.disabled = true);
      } else {
        showToast(result?.message || 'Error al votar.', 3000);
      }
    });
  }

  // ─── Game Over ─────────────────────────────────────────────────────────────

  function renderGameOver(winner, reason, rolesReveal) {
    const winnerMessages = {
      villagers: { emoji: '🌅', title: 'Los Aldeanos han ganado', color: '#c9a84c' },
      wolves:    { emoji: '🐺', title: 'Los Lobos han ganado',   color: '#c090d8' },
      lovers:    { emoji: '💘', title: 'Los Amantes han ganado', color: '#e07090' },
    };

    const msg = winnerMessages[winner] || { emoji: '🎭', title: 'Fin del juego', color: '#8a8070' };

    const deadEl = document.getElementById('dead-icon');
    const titleEl = document.getElementById('dead-title');
    const msgEl = document.getElementById('dead-msg');

    if (deadEl) deadEl.textContent = msg.emoji;
    if (titleEl) {
      titleEl.textContent = msg.title;
      titleEl.style.color = msg.color;
    }
    if (msgEl) {
      let rolesText = rolesReveal
        ?.map(r => `${r.name}: ${r.role}`)
        .join(' · ') || '';
      msgEl.innerHTML = `<em>${reason}</em><br><br><small style="opacity:0.6">${rolesText}</small>`;
    }

    showScreen('dead');
    showToast(`${msg.emoji} ${msg.title}!`, 8000);
  }

  // ─── Event Listeners ───────────────────────────────────────────────────────

  document.getElementById('btn-join').addEventListener('click', joinRoom);
  document.getElementById('player-name').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('room-code').focus(); });
  document.getElementById('room-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  document.getElementById('room-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

  document.getElementById('btn-night-confirm').addEventListener('click', () => {
    const actionType = document.getElementById('btn-night-confirm').dataset.actionType;
    if (actionType && state.selectedTarget) {
      sendNightAction({ actionType, targetId: state.selectedTarget });
    } else if (state.selectedTarget) {
      sendNightAction({ actionType: 'select', targetId: state.selectedTarget });
    }
  });

  document.getElementById('btn-vote-confirm').addEventListener('click', castVote);

  // ─── Inicializar ───────────────────────────────────────────────────────────

  prefillRoomCode();
  connect();

})();
