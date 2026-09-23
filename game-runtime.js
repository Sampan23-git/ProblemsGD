(function () {
  'use strict';

  // Each song page sets window.RHYTHM_GAME_CONFIG before including this file:
  //   { beatmapPath: './БІти/song.json', menuHref: 'index.html', baseFallSpeed: 430 }
  const config = window.RHYTHM_GAME_CONFIG || {};
  const beatmapPath = config.beatmapPath;
  const menuHref = config.menuHref || 'index.html';
  const missesLimit = config.missesLimit || 100;
  const roundDurationMsFallback = config.roundDurationMs || 3 * 60 * 1000;

  // --- Tunable difficulty/feel constants -----------------------------------
  const baseFallSpeed = Number(config.baseFallSpeed) || 430; // px/sec baseline
  const hitWindowSec = 0.14;   // +/- how forgiving a hit is, in seconds of real audio time
  const minLeadTimeSec = 0.35; // never give the player less reaction time than this
  // ---------------------------------------------------------------------------

  const engine = window.beatmapEngine;

  const buttons = document.querySelectorAll('.arrow-button');
  const laneButtons = document.querySelectorAll('.lane-button');
  const lanes = document.querySelectorAll('.lane');
  const screenEl = document.querySelector('.screen');
  const laneControlsEl = document.querySelector('.lane-controls');

  const comboText = document.getElementById('combo');
  const scoreText = document.getElementById('score');
  const missesText = document.getElementById('misses');
  const accuracyText = document.getElementById('accuracy');
  const timeLeftText = document.getElementById('timeLeft');
  const message = document.getElementById('message');
  const startButton = document.getElementById('startButton');
  const stopButton = document.getElementById('stopButton');
  const mainMenuBtn = document.getElementById('mainMenuBtn');
  const volumeControl = document.getElementById('volumeControl');
  const bgAudio = document.getElementById('bgAudio');
  const endModal = document.getElementById('endModal');
  const endModalTitle = document.getElementById('endModalTitle');
  const endModalMsg = document.getElementById('endModalMsg');
  const playAgainBtn = document.getElementById('playAgainBtn');
  const closeModalBtn = document.getElementById('closeModalBtn');

  const physicalKeyMap = {
    ArrowLeft: 0, ArrowDown: 1, ArrowUp: 2, ArrowRight: 3,
    KeyA: 0, KeyS: 1, KeyW: 2, KeyD: 3
  };
  const arrowGlyphs = ['←', '↓', '↑', '→'];
  const spawnY = -60;

  let beatmap = null;
  let chart = [];          // full note chart for the round, sorted by spawnTime
  let nextChartIndex = 0;  // walk pointer into `chart`
  let spawned = [];        // notes currently visible on screen
  let activeGroups = [];   // chord groups still in play

  let combo = 0, score = 0, misses = 0, hits = 0, totalNotes = 0;
  let playing = false;
  let roundDurationMs = roundDurationMsFallback;
  let roundTimeout = null;
  let rafId = null;

  window.addEventListener('error', (ev) => {
    try { message.textContent = 'Error: ' + (ev.message || ev.error || 'unknown'); message.style.color = '#ff3333'; } catch (e) {}
  });
  window.addEventListener('unhandledrejection', (ev) => {
    try { message.textContent = 'Promise rejection: ' + (ev.reason && ev.reason.message ? ev.reason.message : ev.reason); message.style.color = '#ff3333'; } catch (e) {}
  });

  async function ensureBeatmap() {
    if (beatmap || !engine || !beatmapPath) return beatmap;
    try {
      beatmap = await engine.loadBeatmap(beatmapPath);
    } catch (e) {
      beatmap = null;
    }
    return beatmap;
  }
  ensureBeatmap();

  // Used only if the JSON beatmap can't be loaded, so the page still works.
  function buildFallbackChart(durationSec) {
    const notes = [];
    const step = 60 / 120;
    let lane = 0;
    for (let t = 1.5; t < durationSec - 1; t += step) {
      notes.push({ time: t, lane, source: 'beat', hit: false, missed: false, groupId: null });
      lane = (lane + 1) % 4;
    }
    return notes;
  }

  function clamp01(v) { return Math.min(1, Math.max(0, v)); }
  function formatScore(n) { return String(n).padStart(6, '0'); }
  function formatTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(s / 60), sec = s % 60;
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function getScreenRect() { return screenEl.getBoundingClientRect(); }

  // The "hit line" is the row of on-screen lane buttons; all four sit at the
  // same height, so one measurement covers every lane.
  function getHitLineY() {
    const screenRect = getScreenRect();
    if (laneControlsEl) {
      const r = laneControlsEl.getBoundingClientRect();
      return (r.top - screenRect.top) + r.height / 2 - 20;
    }
    return screenEl.clientHeight - 90;
  }

  function getFallSpeedAt(t) {
    if (!beatmap || !engine) return baseFallSpeed;
    return engine.getFallSpeed(beatmap, t, baseFallSpeed);
  }

  // This is the key to perfect sync: a note's on-screen position is computed
  // purely from (currentAudioTime - spawnTime) / (hitTime - spawnTime), so it
  // is mathematically guaranteed to reach the hit line exactly when the audio
  // clock reaches note.time - no per-frame velocity accumulation, no drift.
  function scheduleNote(note) {
    const hitY = getHitLineY();
    const speed = getFallSpeedAt(note.time);
    const distance = Math.max(60, hitY - spawnY);
    const leadTimeSec = Math.max(minLeadTimeSec, distance / speed);
    note.spawnTime = note.time - leadTimeSec;
    note.hitY = hitY;
    return note;
  }

  function createNoteElement(note) {
    const laneEl = lanes[note.lane];
    const el = document.createElement('div');
    el.className = 'note';
    el.textContent = arrowGlyphs[note.lane];
    el.style.left = '50%';
    el.style.top = '0';
    el.style.transform = 'translate(-50%, ' + spawnY + 'px)';
    laneEl.appendChild(el);
    note.el = el;
    spawned.push(note);
    totalNotes++;

    if (note.groupId) {
      let group = activeGroups.find((g) => g.id === note.groupId);
      if (!group) {
        group = { id: note.groupId, notes: [], hitLanes: new Set(), resolved: false };
        activeGroups.push(group);
      }
      group.notes.push(note);
    }
  }

  function spawnFlyingNote(laneIndex, type) {
    try {
      if (!screenEl) return;
      const el = document.createElement('div');
      el.className = 'flying-note ' + (type || 'hit');
      el.textContent = arrowGlyphs[laneIndex] || '';
      const btn = laneButtons[laneIndex];
      const screenRect = getScreenRect();
      const rect = btn ? btn.getBoundingClientRect() : null;
      const left = rect ? (rect.left + rect.right) / 2 - screenRect.left : screenEl.clientWidth / 2;
      const top = rect ? (rect.top + rect.height / 2) - screenRect.top : screenEl.clientHeight - 80;
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      const duration = 600;
      el.style.animationDuration = duration + 'ms';
      screenEl.appendChild(el);
      setTimeout(() => { try { el.remove(); } catch (e) {} }, duration + 300);
    } catch (e) {}
  }

  function updateUI(remainingMs) {
    comboText.textContent = combo;
    scoreText.textContent = formatScore(score);
    missesText.textContent = misses;
    accuracyText.textContent = (totalNotes === 0 ? 100 : Math.round((hits / totalNotes) * 100)) + '%';
    if (typeof remainingMs === 'number') timeLeftText.textContent = formatTime(remainingMs);
  }

  function removeNote(note, disabledClass) {
    if (note.el) {
      const el = note.el;
      if (disabledClass) {
        el.classList.add(disabledClass);
        setTimeout(() => { try { el.remove(); } catch (e) {} }, 700);
      } else {
        try { el.remove(); } catch (e) {}
      }
    }
    spawned = spawned.filter((n) => n !== note);
  }

  function resolveGroupIfComplete(group) {
    if (!group || group.resolved) return;
    if (group.hitLanes.size >= group.notes.length) {
      group.resolved = true;
      const reward = 120 + group.notes.length * 50;
      score += reward;
      combo += 1;
      message.textContent = group.notes.length >= 4 ? 'PERFECT!' : 'DOUBLE!';
      message.style.color = '#7cffb2';
      activeGroups = activeGroups.filter((g) => g.id !== group.id);
      updateUI();
    }
  }

  function registerMissSilently(note) {
    if (note.missed || note.hit) return;
    note.missed = true;
    removeNote(note, 'disabled');
  }

  function registerMiss(note) {
    if (note.missed || note.hit) return;
    note.missed = true;
    misses++; combo = 0;
    message.textContent = 'MISS!'; message.style.color = '#ff6b6b';
    removeNote(note, 'disabled');
    updateUI();

    if (note.groupId) {
      const group = activeGroups.find((g) => g.id === note.groupId);
      if (group && !group.resolved) {
        group.resolved = true;
        group.notes.forEach((n) => { if (n !== note) registerMissSilently(n); });
        activeGroups = activeGroups.filter((g) => g.id !== group.id);
      }
    }

    if (misses >= missesLimit) endRound('too many misses');
  }

  function flashButton(laneIndex) {
    try {
      if (buttons[laneIndex]) { buttons[laneIndex].classList.add('active'); setTimeout(() => buttons[laneIndex].classList.remove('active'), 100); }
      const lb = laneButtons[laneIndex];
      if (lb) { lb.classList.add('active'); setTimeout(() => lb.classList.remove('active'), 100); }
    } catch (e) {}
  }

  function triggerHit(laneIndex) {
    if (!playing) return;
    if (laneButtons[laneIndex] && laneButtons[laneIndex].disabled) return;
    flashButton(laneIndex);

    const currentTime = bgAudio.currentTime || 0;
    let best = null, bestDiff = Infinity;
    for (const note of spawned) {
      if (note.lane !== laneIndex || note.hit || note.missed) continue;
      const diff = Math.abs(currentTime - note.time);
      if (diff < bestDiff) { bestDiff = diff; best = note; }
    }

    if (!best || bestDiff > hitWindowSec) {
      misses++; combo = 0;
      const early = best && best.time > currentTime;
      message.textContent = early ? 'EARLY' : 'MISS!';
      message.style.color = early ? '#ffd86b' : '#ff6b6b';
      spawnFlyingNote(laneIndex, 'miss');
      updateUI();
      if (misses >= missesLimit) endRound('too many misses');
      return;
    }

    best.hit = true;

    if (best.groupId) {
      const group = activeGroups.find((g) => g.id === best.groupId);
      if (group) {
        hits++; // still counts toward accuracy, even though score comes from the group bonus
        group.hitLanes.add(laneIndex);
        spawnFlyingNote(laneIndex, 'group');
        removeNote(best, null);
        resolveGroupIfComplete(group);
        updateUI();
        return;
      }
    }

    hits++; combo++;
    const accuracyFactor = clamp01(1 - bestDiff / hitWindowSec);
    score += Math.round(100 * (0.5 + accuracyFactor * 0.5));
    message.textContent = 'GOOD!'; message.style.color = '#7cffb2';
    spawnFlyingNote(laneIndex, 'hit');
    removeNote(best, null);
    updateUI();
  }

  buttons.forEach((btn, i) => btn.addEventListener('click', () => triggerHit(i)));
  laneButtons.forEach((btn) => { const i = Number(btn.dataset.lane); btn.addEventListener('click', () => triggerHit(i)); });
  document.addEventListener('keydown', (e) => {
    const idx = physicalKeyMap[e.code];
    if (idx !== undefined) { e.preventDefault(); triggerHit(idx); }
  }, { passive: false });

  function gameLoop() {
    if (!playing) return;
    const currentTime = bgAudio.currentTime || 0;

    while (nextChartIndex < chart.length && chart[nextChartIndex].spawnTime <= currentTime) {
      createNoteElement(chart[nextChartIndex]);
      nextChartIndex++;
    }

    for (const note of [...spawned]) {
      if (note.hit || note.missed) continue;
      const span = note.time - note.spawnTime;
      const progress = span > 0 ? clamp01((currentTime - note.spawnTime) / span) : 1;
      const y = spawnY + progress * (note.hitY - spawnY);
      note.el.style.transform = 'translate(-50%, ' + y + 'px)';
      if (currentTime > note.time + hitWindowSec) {
        registerMiss(note);
      }
    }

    updateUI(Math.max(0, roundDurationMs - currentTime * 1000));

    const chartExhausted = nextChartIndex >= chart.length && spawned.length === 0;
    if (chartExhausted && (bgAudio.ended || currentTime * 1000 >= roundDurationMs)) {
      endRound('time');
      return;
    }

    rafId = requestAnimationFrame(gameLoop);
  }

  function stopLoop() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  async function startRound() {
    await ensureBeatmap();

    const durationSec = (bgAudio && isFinite(bgAudio.duration) && bgAudio.duration > 0)
      ? bgAudio.duration
      : roundDurationMsFallback / 1000;
    roundDurationMs = durationSec * 1000;

    chart = beatmap ? engine.buildChart(beatmap) : buildFallbackChart(durationSec);
    chart.forEach(scheduleNote);
    chart.sort((a, b) => a.spawnTime - b.spawnTime);
    nextChartIndex = 0;

    combo = 0; score = 0; misses = 0; hits = 0; totalNotes = 0;
    spawned.forEach((n) => { try { n.el && n.el.remove(); } catch (e) {} });
    spawned = [];
    activeGroups = [];
    updateUI(roundDurationMs);

    try { laneButtons.forEach((b) => { b.disabled = false; b.classList.remove('disabled'); }); } catch (e) {}

    bgAudio.volume = Number(volumeControl.value);
    bgAudio.currentTime = 0;

    playing = true;
    stopButton.disabled = false; stopButton.style.display = 'inline-block';
    startButton.style.display = 'none';
    message.textContent = 'Гра почалась!'; message.style.color = '#d64c9b';

    if (roundTimeout) clearTimeout(roundTimeout);
    roundTimeout = setTimeout(() => endRound('time'), roundDurationMs + 2000);

    try { await bgAudio.play(); } catch (e) { /* needs a user gesture; Start click already provided one */ }

    stopLoop();
    rafId = requestAnimationFrame(gameLoop);
  }

  function endRound(reason) {
    if (!playing) return;
    playing = false;
    stopLoop();
    if (roundTimeout) { clearTimeout(roundTimeout); roundTimeout = null; }

    stopButton.disabled = true; stopButton.style.display = 'none';
    startButton.style.display = 'inline-block'; startButton.disabled = false;

    try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) {}

    message.style.color = '#ffd86b';
    let reasonText = '';
    if (reason === 'too many misses') reasonText = `Гру завершено — забагато помилок (${misses}). `;
    else if (reason === 'stopped') reasonText = 'Гра зупинена. ';
    message.textContent = `${reasonText}Підсумок: ${scoreText.textContent} очок. Натисніть "Почати гру" щоб зіграти ще.`;
    startButton.textContent = 'Грати ще раз';

    if (reason === 'time') {
      try {
        endModalTitle.textContent = 'Вітаємо!';
        endModalMsg.textContent = `Раунд завершено. Ваш рахунок: ${scoreText.textContent} очок.`;
        endModal.classList.add('visible'); endModal.setAttribute('aria-hidden', 'false');
      } catch (e) {}
    }
  }

  startButton.addEventListener('click', () => {
    if (bgAudio && (!isFinite(bgAudio.duration) || bgAudio.duration === 0)) {
      const onMeta = () => { startRound(); bgAudio.removeEventListener('loadedmetadata', onMeta); };
      bgAudio.addEventListener('loadedmetadata', onMeta, { once: true });
      try { bgAudio.load(); } catch (e) {}
      try { bgAudio.play().catch(() => {}); } catch (e) {}
    } else {
      startRound();
    }
  });
  stopButton.addEventListener('click', () => endRound('stopped'));
  volumeControl.addEventListener('input', () => { bgAudio.volume = Number(volumeControl.value); });

  try {
    playAgainBtn.addEventListener('click', () => {
      endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true');
      startRound();
    });
    closeModalBtn.addEventListener('click', () => {
      endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true');
    });
    endModal.addEventListener('click', (e) => {
      if (e.target === endModal) { endModal.classList.remove('visible'); endModal.setAttribute('aria-hidden', 'true'); }
    });
  } catch (e) {}

  mainMenuBtn.addEventListener('click', () => {
    stopLoop();
    if (roundTimeout) clearTimeout(roundTimeout);
    playing = false;
    try { bgAudio.pause(); bgAudio.currentTime = 0; } catch (e) {}
    window.location.href = menuHref;
  });
})();
