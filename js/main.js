// Main: scene setup, input, race flow and the render/physics loop.

const TOTAL_LAPS = 3;
const AI_COUNT = 3;

const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
const isMobile = isTouchDevice && /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent);
if (isTouchDevice) document.body.classList.add('touch');

// iOS/Android browser chrome resizes the viewport without firing 'resize'
// reliably against 100vh, so drive height off a JS-measured custom property.
function setViewportHeight() {
  document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7ec0ee);
scene.fog = new THREE.Fog(0x7ec0ee, 150, 620);

// near=0.5 (not the usual 0.1) plus a log depth buffer: the road sits only
// fractions of a unit above the ground plane, and that gap was falling
// below depth-buffer precision at normal driving distances — especially on
// mobile GPUs' lower-precision buffers — making the road disappear behind
// the grass entirely rather than just look washed out.
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.5, 1200);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x3a6b2a, 0.9);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3d6, 1.0);
sun.position.set(80, 120, 40);
sun.castShadow = true;
const shadowRes = isMobile ? 1024 : 2048;
sun.shadow.mapSize.set(shadowRes, shadowRes);
sun.shadow.camera.left = -190;
sun.shadow.camera.right = 190;
sun.shadow.camera.top = 190;
sun.shadow.camera.bottom = -190;
scene.add(sun);

const track = new Track();
scene.add(track.group);

// ---------------- Audio ----------------
// Browsers won't let audio start outside a user gesture, so the context is
// only created when a button is tapped on the way into a race.
const gameAudio = new GameAudio();
let soundEnabled = true;

const soundToggleSetup = document.getElementById('sound-toggle-setup');
const hudSoundBtn = document.getElementById('hud-sound-btn');
function refreshSoundButtons() {
  soundToggleSetup.textContent = `Sound: ${soundEnabled ? 'On' : 'Off'}`;
  soundToggleSetup.classList.toggle('on', soundEnabled);
  hudSoundBtn.classList.toggle('muted', !soundEnabled);
  hudSoundBtn.title = soundEnabled ? 'Mute sound' : 'Unmute sound';
  hudSoundBtn.setAttribute('aria-label', hudSoundBtn.title);
}
function toggleSound() {
  soundEnabled = !soundEnabled;
  if (soundEnabled) gameAudio.init(); // this toggle is itself a gesture, so it can start the context
  gameAudio.setEnabled(soundEnabled);
  refreshSoundButtons();
}
soundToggleSetup.addEventListener('click', toggleSound);
hudSoundBtn.addEventListener('click', toggleSound);
refreshSoundButtons();

const KART_COLORS = [0xd6322c, 0x2f6fd6, 0x3ca35c, 0x8a3ccf];
const KART_COLOR_PALETTE = [0xd6322c, 0x2f6fd6, 0x3ca35c, 0x8a3ccf, 0xff8c1a, 0x1ac9c9];
const N = track.segments;
const karts = [];
for (let i = 0; i < 1 + AI_COUNT; i++) {
  const row = Math.floor(i / 2);
  const col = i % 2;
  const idx = ((0 - row * 5) % N + N) % N;
  const startPoint = track.points[idx];
  const tangent = track.tangents[idx];
  const lane = col === 0 ? -3 : 3;
  const kart = new Kart({
    color: KART_COLORS[i],
    isPlayer: i === 0,
    startPoint,
    startTangent: tangent,
    laneOffset: lane,
  });
  kart.lastIndex = idx;
  kart.hasStarted = idx === 0;
  scene.add(kart.mesh);
  karts.push(kart);
}
let player = karts[0];

// ---------------- CPU difficulty ----------------
const DIFFICULTY_PRESETS = {
  easy: { skillMin: 0.70, skillMax: 0.82, lookMin: 10, lookMax: 14 },
  normal: { skillMin: 0.90, skillMax: 1.08, lookMin: 9, lookMax: 12 },
  hard: { skillMin: 1.08, skillMax: 1.24, lookMin: 7, lookMax: 10 },
};
let currentDifficulty = 'normal';
function applyDifficultyToSlot(idx, level) {
  const preset = DIFFICULTY_PRESETS[level] || DIFFICULTY_PRESETS.normal;
  karts[idx].setDifficulty(preset.skillMin, preset.skillMax, preset.lookMin, preset.lookMax);
}
function applyDifficulty(level) {
  currentDifficulty = level;
  for (let i = 1; i < karts.length; i++) applyDifficultyToSlot(i, level);
}
applyDifficulty(currentDifficulty);

for (const btn of document.querySelectorAll('.difficulty-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.difficulty-btn')) b.classList.remove('selected');
    btn.classList.add('selected');
    applyDifficulty(btn.dataset.difficulty);
  });
}

// ---------------- Menu / kart select / multiplayer lobby ----------------
// Host-relay model: everyone connects only to the host, never to each
// other. `humanSlots` names which kart indices are driven by a real
// person (the host's own slot 0 is implied, not included) — the host
// builds it directly from join/leave events; clients just mirror whatever
// the host reports in each snapshot, since only the host actually knows.
let netSession = null;
let myKartIndex = 0;
let humanSlots = new Set();
let latestClientStates = {}; // host only: slot -> last received state
let latestSnapshot = null; // client only: last received {karts, humanSlots}
let slotColors = {}; // host only: slot -> chosen color hex, for connected humans
let pendingFlow = null; // 'solo' | 'host' | 'join' — which path kart-select was entered from
let myKartColor = KART_COLOR_PALETTE[0];

const screenMenu = document.getElementById('screen-menu');
const screenKartSelect = document.getElementById('screen-kart-select');
const mpHostPanel = document.getElementById('mp-host-panel');
const mpJoinPanel = document.getElementById('mp-join-panel');
const mpWaitingPanel = document.getElementById('mp-waiting-panel');
const mpCodeEl = document.getElementById('mp-code');
const mpSlotsEl = document.getElementById('mp-slots');
const mpJoinStatusEl = document.getElementById('mp-join-status');
const mpMySlotEl = document.getElementById('mp-my-slot');
const difficultyPickerEl = document.getElementById('difficulty-picker');
const kartSwatchesEl = document.getElementById('kart-swatches');
const ALL_SCREENS = [screenMenu, screenKartSelect, mpHostPanel, mpJoinPanel, mpWaitingPanel];

function showScreen(screen) {
  for (const s of ALL_SCREENS) s.classList.add('hidden');
  screen.classList.remove('hidden');
}

function hexToCss(hex) { return '#' + hex.toString(16).padStart(6, '0'); }

function renderKartSwatches() {
  kartSwatchesEl.innerHTML = '';
  for (const color of KART_COLOR_PALETTE) {
    const btn = document.createElement('button');
    btn.className = 'kart-swatch' + (color === myKartColor ? ' selected' : '');
    btn.style.setProperty('--kart-color', hexToCss(color));
    btn.setAttribute('aria-label', 'Choose this kart color');
    btn.addEventListener('click', () => { myKartColor = color; renderKartSwatches(); });
    kartSwatchesEl.appendChild(btn);
  }
}
renderKartSwatches();

function renderHostSlots() {
  mpSlotsEl.innerHTML = '';
  for (let i = 0; i < karts.length; i++) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'slot-dot';
    if (i === 0) {
      dot.style.background = hexToCss(myKartColor);
      li.append(dot, 'Player 1 — You (Host)');
      li.className = 'filled';
    } else if (humanSlots.has(i)) {
      dot.style.background = hexToCss(slotColors[i] ?? KART_COLORS[i]);
      li.append(dot, `Player ${i + 1} — Connected`);
      li.className = 'filled';
    } else {
      dot.style.background = hexToCss(KART_COLORS[i]);
      li.append(dot, `Player ${i + 1} — CPU`);
      li.className = 'empty';
    }
    mpSlotsEl.appendChild(li);
  }
}

function teardownNet() {
  if (netSession) netSession.disconnect();
  netSession = null;
  myKartIndex = 0;
  humanSlots = new Set();
  latestClientStates = {};
  latestSnapshot = null;
  slotColors = {};
  player = karts[0];
}

function returnToMenu() {
  teardownNet();
  hud.classList.remove('active');
  touchControlsEl.classList.remove('active');
  resultsEl.classList.add('hidden');
  gameState = 'intro';
  introEl.classList.remove('hidden');
  showScreen(screenMenu);
}

document.getElementById('menu-solo-btn').addEventListener('click', () => {
  pendingFlow = 'solo';
  teardownNet();
  difficultyPickerEl.hidden = false;
  renderKartSwatches();
  showScreen(screenKartSelect);
});

document.getElementById('mp-host-btn').addEventListener('click', () => {
  pendingFlow = 'host';
  teardownNet();
  difficultyPickerEl.hidden = false;
  renderKartSwatches();
  showScreen(screenKartSelect);
});

document.getElementById('mp-join-btn').addEventListener('click', () => {
  pendingFlow = 'join';
  teardownNet();
  showScreen(mpJoinPanel);
  mpJoinStatusEl.textContent = '';
  mpCodeInput.value = '';
});

document.getElementById('kart-select-back-btn').addEventListener('click', () => {
  teardownNet();
  showScreen(screenMenu);
});

document.getElementById('kart-select-continue-btn').addEventListener('click', () => {
  if (soundEnabled) gameAudio.init(); // a real tap — the only place a browser will let audio start
  karts[myKartIndex].setColor(myKartColor);

  if (pendingFlow === 'solo') {
    teardownNet();
    beginRaceUi();
    return;
  }

  if (pendingFlow === 'host') {
    netSession = new NetSession();
    humanSlots = new Set();
    slotColors = { 0: myKartColor };
    showScreen(mpHostPanel);
    mpCodeEl.textContent = '.....';
    renderHostSlots();

    netSession.onHostReady = (code) => { mpCodeEl.textContent = code; };
    netSession.onError = (msg) => { showToast(msg); showScreen(screenMenu); teardownNet(); };
    netSession.onPlayerJoined = (slot) => { humanSlots.add(slot); renderHostSlots(); };
    netSession.onPlayerLeft = (slot) => {
      humanSlots.delete(slot);
      delete latestClientStates[slot];
      delete slotColors[slot];
      applyDifficultyToSlot(slot, currentDifficulty);
      karts[slot].setColor(KART_COLORS[slot]);
      renderHostSlots();
    };
    netSession.onHostState = (slot, state) => { latestClientStates[slot] = state; };
    netSession.onPlayerColor = (slot, color) => {
      slotColors[slot] = color;
      karts[slot].setColor(color);
      renderHostSlots();
    };
    netSession.host();
    return;
  }

  if (pendingFlow === 'join') {
    netSession.sendColor(myKartColor);
    showScreen(mpWaitingPanel);
  }
});

document.getElementById('mp-host-cancel-btn').addEventListener('click', () => {
  teardownNet();
  showScreen(screenMenu);
});

document.getElementById('mp-host-start-btn').addEventListener('click', () => {
  if (soundEnabled) gameAudio.init();
  netSession.broadcastStart(slotColors);
  beginRaceUi();
});

document.getElementById('mp-join-cancel-btn').addEventListener('click', () => {
  teardownNet();
  showScreen(screenMenu);
});
document.getElementById('mp-waiting-cancel-btn').addEventListener('click', () => {
  teardownNet();
  showScreen(screenMenu);
});

const mpCodeInput = document.getElementById('mp-code-input');
mpCodeInput.addEventListener('input', () => { mpCodeInput.value = mpCodeInput.value.toUpperCase(); });

document.getElementById('mp-join-connect-btn').addEventListener('click', () => {
  const code = mpCodeInput.value.trim();
  if (code.length < 5) { mpJoinStatusEl.textContent = 'Enter the 5-character code.'; return; }
  teardownNet();
  netSession = new NetSession();
  mpJoinStatusEl.textContent = 'Connecting…';

  netSession.onError = (msg) => {
    showScreen(mpJoinPanel);
    mpJoinStatusEl.textContent = msg;
  };
  netSession.onConnected = (kartIndex) => {
    myKartIndex = kartIndex;
    player = karts[myKartIndex];
    mpMySlotEl.textContent = String(kartIndex + 1);
    difficultyPickerEl.hidden = true; // joiners don't control AI difficulty, only their own kart
    renderKartSwatches();
    showScreen(screenKartSelect);
  };
  netSession.onSnapshot = (kartsState, hostHumanSlots) => {
    latestSnapshot = kartsState;
    if (hostHumanSlots) humanSlots = new Set(hostHumanSlots);
  };
  netSession.onHostStart = (colors) => {
    if (colors) { for (const idx in colors) karts[idx].setColor(colors[idx]); }
    beginRaceUi();
  };
  netSession.join(code);
});

// ---------------- Input ----------------
const input = { up: false, down: false, left: false, right: false, drift: false, steer: null };
window.addEventListener('keydown', e => setKey(e.code, true));
window.addEventListener('keyup', e => setKey(e.code, false));
function setKey(code, val) {
  switch (code) {
    case 'ArrowUp': case 'KeyW': input.up = val; break;
    case 'ArrowDown': case 'KeyS': input.down = val; break;
    case 'ArrowLeft': case 'KeyA': input.left = val; break;
    case 'ArrowRight': case 'KeyD': input.right = val; break;
    case 'ShiftLeft': case 'ShiftRight': case 'Space': input.drift = val; break;
    case 'KeyR': if (val && gameState === 'finished' && !netSession) restartRace(); break;
  }
}

// Touch buttons drive the same `input` flags as the keyboard handler above.
function bindTouchButton(id, flag) {
  const el = document.getElementById(id);
  const set = (val) => (e) => {
    e.preventDefault();
    input[flag] = val;
    el.classList.toggle('pressed', val);
  };
  el.addEventListener('pointerdown', set(true));
  el.addEventListener('pointerup', set(false));
  el.addEventListener('pointercancel', set(false));
  el.addEventListener('pointerleave', set(false));
}
if (isTouchDevice) {
  bindTouchButton('btn-left', 'left');
  bindTouchButton('btn-right', 'right');
  bindTouchButton('btn-gas', 'up');
  bindTouchButton('btn-brake', 'down');
  bindTouchButton('btn-drift', 'drift');
}

// ---------------- Orientation lock ----------------
const rotateOverlay = document.getElementById('rotate-overlay');
function isPortraitBlocked() {
  return isTouchDevice && window.innerHeight > window.innerWidth;
}
function updateOrientationGate() {
  rotateOverlay.classList.toggle('active', isPortraitBlocked());
}
window.addEventListener('resize', updateOrientationGate);
window.addEventListener('orientationchange', updateOrientationGate);
updateOrientationGate();

// ---------------- Tilt steering (opt-in, falls back to buttons) ----------------
const TILT_SUPPORTED = typeof window.DeviceOrientationEvent !== 'undefined';
const TILT_MAX_ANGLE = 26; // degrees of tilt for full steering lock
const TILT_CURVE_EXPONENT = 0.6; // <1 = progressive: a given tilt produces more steering than a flat linear mapping would, so less physical tilt is needed for a strong turn
let tiltEnabled = false;
let tiltNeutral = null;
let tiltRaw = 0;
let tiltEventSeen = false;
let tiltWatchdog = null;

function tiltAngleFromEvent(e) {
  const angle = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  if (angle === 90) return e.beta || 0;
  if (angle === -90 || angle === 270) return -(e.beta || 0);
  return e.gamma || 0; // portrait fallback; gameplay itself is landscape-only
}

if (TILT_SUPPORTED) {
  window.addEventListener('deviceorientation', (e) => {
    tiltEventSeen = true;
    tiltRaw = tiltAngleFromEvent(e);
    if (tiltNeutral === null) tiltNeutral = tiltRaw;
  });
}

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, ms = 2400) {
  toastEl.textContent = msg;
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), ms);
}

const tiltButtons = [document.getElementById('tilt-toggle-intro'), document.getElementById('tilt-toggle-race')];
function refreshTiltButtons() {
  for (const btn of tiltButtons) {
    if (!btn) continue;
    btn.classList.toggle('on', tiltEnabled);
    if (btn.id === 'tilt-toggle-intro') btn.textContent = `Tilt Steering: ${tiltEnabled ? 'On' : 'Off'}`;
    else btn.textContent = tiltEnabled ? 'TILT ON' : 'TILT OFF';
  }
  document.body.classList.toggle('tilt-on', tiltEnabled);
}

function activateTilt() {
  tiltEnabled = true;
  tiltNeutral = null; // calibrate off whatever angle the player is holding right now
  tiltEventSeen = false;
  refreshTiltButtons();
  clearTimeout(tiltWatchdog);
  tiltWatchdog = setTimeout(() => {
    if (!tiltEventSeen) {
      tiltEnabled = false;
      refreshTiltButtons();
      showToast('Tilt steering unavailable here — using buttons');
    }
  }, 1200);
}

function deactivateTilt() {
  tiltEnabled = false;
  input.steer = null;
  refreshTiltButtons();
}

function toggleTilt() {
  if (tiltEnabled) { deactivateTilt(); return; }
  if (!TILT_SUPPORTED) { showToast('Tilt steering not supported on this device'); return; }
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(state => { if (state === 'granted') activateTilt(); else showToast('Tilt permission denied — using buttons'); })
      .catch(() => showToast('Tilt steering unavailable — using buttons'));
  } else {
    activateTilt();
  }
}

if (isTouchDevice && TILT_SUPPORTED) {
  for (const btn of tiltButtons) { if (btn) btn.hidden = false; }
  for (const btn of tiltButtons) { if (btn) btn.addEventListener('click', toggleTilt); }
}

// ---------------- HUD ----------------
const hud = document.getElementById('hud');
const lapEl = document.getElementById('lap');
const placeEl = document.getElementById('place');
const timerEl = document.getElementById('timer');
const speedEl = document.getElementById('speed');
const boostFill = document.getElementById('boost-fill');
const countdownEl = document.getElementById('countdown');
const resultsEl = document.getElementById('results');
const resultsList = document.getElementById('results-list');
const resultsPlayAgainBtn = document.getElementById('results-play-again-btn');
const resultsMenuBtn = document.getElementById('results-menu-btn');
const introEl = document.getElementById('intro');

resultsPlayAgainBtn.addEventListener('click', () => restartRace());
resultsMenuBtn.addEventListener('click', () => returnToMenu());

function ordinal(n) {
  return ['', '1st', '2nd', '3rd', '4th'][n] || `${n}th`;
}

function updateHud() {
  const lapShown = Math.min(player.laps + 1, TOTAL_LAPS);
  lapEl.textContent = `LAP ${lapShown} / ${TOTAL_LAPS}`;

  const ranked = [...karts].sort((a, b) => b.progress - a.progress);
  const place = ranked.indexOf(player) + 1;
  placeEl.textContent = ordinal(place);

  const kmh = Math.round(Math.abs(player.speed) * 4);
  speedEl.innerHTML = `${kmh} <span>km/h</span>`;

  let fill = 0;
  if (player.driftDir !== 0) fill = Math.min(player.driftTime / 1.0, 1) * 100;
  else if (player.boostTimer > 0) fill = (player.boostTimer / 1.2) * 100;
  boostFill.style.width = `${fill}%`;

  if (raceStartTime !== null) {
    const elapsed = (player.finishTime !== null ? player.finishTime : (performance.now() - raceStartTime)) / 1000;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = (elapsed % 60).toFixed(2).padStart(5, '0');
    timerEl.textContent = `${mm}:${ss}`;
  }
}

// ---------------- Camera ----------------
const CAMERA_BASE_FOV = 65;
const CAMERA_MAX_FOV = 82; // widening with speed is what actually sells the sense of pace
let cameraShake = 0; // decaying impulse, topped up by impacts
let camFov = CAMERA_BASE_FOV;
let camLateral = 0; // trails the turn so you see into the corner
let camRoll = 0;

function addCameraShake(amount) {
  cameraShake = Math.min(1.2, cameraShake + amount);
}

function updateCamera(dt) {
  const forward = new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
  const right = new THREE.Vector3(Math.cos(player.heading), 0, -Math.sin(player.heading));
  const speedFrac = THREE.MathUtils.clamp(Math.abs(player.speed) / KART_PHYSICS.maxSpeed, 0, 1);
  const boosting = player.boostTimer > 0;

  // FOV opens up with speed (and a little extra on boost), which reads as
  // acceleration far more strongly than the speed number changing does.
  const targetFov = CAMERA_BASE_FOV + speedFrac * (CAMERA_MAX_FOV - CAMERA_BASE_FOV) + (boosting ? 5 : 0);
  camFov += (targetFov - camFov) * Math.min(1, dt * 3);
  if (Math.abs(camera.fov - camFov) > 0.01) {
    camera.fov = camFov;
    camera.updateProjectionMatrix();
  }

  // Swing wide of the turn and roll into it, both trailing the kart.
  const targetLateral = -player.visualYaw * 3.2 - player.visualRoll * 6;
  camLateral += (targetLateral - camLateral) * Math.min(1, dt * 4);
  const targetRoll = player.visualRoll * 0.55;
  camRoll += (targetRoll - camRoll) * Math.min(1, dt * 4);

  const distance = 8.5 + speedFrac * 1.6; // pull back a touch at speed
  const desired = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(forward, -distance)
    .addScaledVector(right, camLateral)
    .add(new THREE.Vector3(0, 3.6, 0));

  // Off-road adds a constant rumble on top of any impact shake.
  const rumble = player.offTrack ? speedFrac * 0.35 : 0;
  const shake = cameraShake + rumble;
  if (shake > 0.001) {
    desired.x += (Math.random() - 0.5) * shake * 0.9;
    desired.y += (Math.random() - 0.5) * shake * 0.7;
    desired.z += (Math.random() - 0.5) * shake * 0.9;
  }
  cameraShake = Math.max(0, cameraShake - dt * 2.6);

  const lerp = 1 - Math.pow(0.001, dt);
  camera.position.lerp(desired, lerp);

  const lookTarget = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(forward, 4)
    .add(new THREE.Vector3(0, 1.2, 0));
  camera.lookAt(lookTarget);
  camera.rotateZ(camRoll); // after lookAt, which overwrites rotation
}

// ---------------- Race flow ----------------
let gameState = 'intro'; // intro | countdown | racing | finished
let raceStartTime = null;
let standingsSnapshot = null;

if (isTouchDevice) {
  document.getElementById('controls-keyboard').hidden = true;
  document.getElementById('controls-touch').hidden = false;
}
const touchControlsEl = document.getElementById('touch-controls');

const hudRestartBtn = document.getElementById('hud-restart-btn');
function refreshHudRestartButton() {
  if (netSession) {
    hudRestartBtn.textContent = 'X';
    hudRestartBtn.title = 'Leave race';
    hudRestartBtn.setAttribute('aria-label', 'Leave race');
  } else {
    hudRestartBtn.textContent = 'R';
    hudRestartBtn.title = 'Restart race';
    hudRestartBtn.setAttribute('aria-label', 'Restart race');
  }
}
hudRestartBtn.addEventListener('click', () => {
  if (netSession) returnToMenu();
  else restartRace();
});

function beginRaceUi() {
  introEl.classList.add('hidden');
  hud.classList.add('active');
  touchControlsEl.classList.add('active');
  refreshHudRestartButton();
  startCountdown();
}

function startCountdown() {
  gameState = 'countdown';
  if (tiltEnabled) tiltNeutral = null; // recalibrate to however the player is holding the phone now
  countdownEl.classList.add('active');
  const steps = ['3', '2', '1', 'GO!'];
  let i = 0;
  countdownEl.textContent = steps[i];
  const interval = setInterval(() => {
    i++;
    if (i < steps.length) {
      countdownEl.textContent = steps[i];
    } else {
      clearInterval(interval);
      countdownEl.classList.remove('active');
      gameState = 'racing';
      raceStartTime = performance.now();
    }
  }, 800);
}

function finishRace() {
  gameState = 'finished';
  standingsSnapshot = [...karts].sort((a, b) => b.progress - a.progress);
  resultsList.innerHTML = '';
  standingsSnapshot.forEach((k, i) => {
    const li = document.createElement('li');
    const idx = karts.indexOf(k);
    if (k === player) {
      const t = k.finishTime / 1000;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      li.textContent = `${ordinal(i + 1)} — You — ${mm}:${ss}`;
      li.style.color = '#ffd23f';
    } else if (netSession && humanSlots.has(idx)) {
      li.textContent = `${ordinal(i + 1)} — Player ${idx + 1}`;
    } else {
      li.textContent = `${ordinal(i + 1)} — CPU Racer`;
    }
    resultsList.appendChild(li);
  });
  resultsPlayAgainBtn.classList.toggle('hidden', !!netSession);
  resultsMenuBtn.classList.toggle('hidden', !netSession);
  resultsEl.classList.remove('hidden');
}

function restartRace() {
  resultsEl.classList.add('hidden');
  for (let i = 0; i < karts.length; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const idx = ((0 - row * 5) % N + N) % N;
    const startPoint = track.points[idx];
    const tangent = track.tangents[idx];
    const lane = col === 0 ? -3 : 3;
    const heading = Math.atan2(tangent.x, tangent.z);
    const side = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    const k = karts[i];
    k.position.copy(startPoint).addScaledVector(side, lane);
    k.heading = heading;
    k.speed = 0;
    k.laps = 0;
    k.lastIndex = idx;
    k.hasStarted = idx === 0;
    k.finished = false;
    k.finishTime = null;
    k.boostTimer = 0;
    k.driftDir = 0;
    k.driftTime = 0;
    k.bumpVelocity.set(0, 0, 0);
    k._syncMesh();
  }
  for (const pad of track.boostPads) { pad.active = true; pad.mesh.visible = true; }
  applyDifficulty(currentDifficulty);
  raceStartTime = null;
  startCountdown();
}

// Only checked against karts this client actually simulates: in multiplayer,
// a remote human's or the host's own kart's boost state comes over the
// network, so touching a pad locally for one of those would just get
// overwritten by the next snapshot anyway.
function checkBoostPads(activeKarts) {
  for (const pad of track.boostPads) {
    if (!pad.active) continue;
    for (const k of activeKarts) {
      const d = Math.hypot(k.position.x - pad.position.x, k.position.z - pad.position.z);
      if (d < 2.3) {
        k.boostTimer = 1.1;
        k.boostMultiplier = 1.4;
        pad.active = false;
        pad.mesh.visible = false;
        pad.cooldown = 4;
        break;
      }
    }
  }
}

// ---------------- Main loop ----------------
const clock = new THREE.Clock();
let wasBlocked = false;
let blockStartedAt = 0;
let netTickAccumulator = 0;
let prevBoostTimer = 0; // edge-detects a boost starting, for the whoosh
const NET_TICK_INTERVAL = 1 / 15; // send/broadcast state 15x/sec — plenty for kart positions, keeps bandwidth trivial

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  const blocked = isPortraitBlocked();
  if (blocked && !wasBlocked) blockStartedAt = performance.now();
  if (!blocked && wasBlocked && raceStartTime !== null) raceStartTime += performance.now() - blockStartedAt;
  wasBlocked = blocked;

  // In multiplayer, other participants' races keep going even after this
  // client's own kart has finished — so the network relay and (for the
  // host) AI simulation must not stop just because gameState flipped to
  // 'finished' here. Only this client's own input/physics stop.
  const netKeepsRunning = netSession && gameState === 'finished';

  if ((gameState === 'racing' || netKeepsRunning) && !blocked) {
    if (gameState === 'racing') {
      if (tiltEnabled && tiltNeutral !== null) {
        const norm = THREE.MathUtils.clamp((tiltNeutral - tiltRaw) / TILT_MAX_ANGLE, -1, 1);
        input.steer = Math.sign(norm) * Math.pow(Math.abs(norm), TILT_CURVE_EXPONENT);
      } else {
        input.steer = null;
      }
      player.updatePlayer(dt, input, track);
    }

    let activeKarts; // karts this client actually simulates locally, for boost-pad/obstacle checks
    let movable; // kart indices this client is allowed to physically move via collisions
    if (netSession && netSession.isHost) {
      const aiIndices = [];
      for (let i = 0; i < karts.length; i++) {
        if (i === myKartIndex) continue;
        if (humanSlots.has(i)) {
          const st = latestClientStates[i];
          if (st) karts[i].applyNetworkState(st, track, dt);
        } else {
          karts[i].updateAI(dt, track);
          aiIndices.push(i);
        }
      }
      activeKarts = [player, ...aiIndices.map(i => karts[i])];
      movable = new Set([myKartIndex, ...aiIndices]);
    } else if (netSession && !netSession.isHost) {
      for (let i = 0; i < karts.length; i++) {
        if (i === myKartIndex) continue;
        const st = latestSnapshot && latestSnapshot[i];
        if (st) karts[i].applyNetworkState(st, track, dt);
      }
      activeKarts = [player];
      movable = new Set([myKartIndex]);
    } else {
      for (let i = 0; i < karts.length; i++) { if (i !== myKartIndex) karts[i].updateAI(dt, track); }
      activeKarts = karts;
      movable = null;
    }
    resolveKartCollisions(karts, movable);
    resolveObstacleCollisions(karts, track.obstacles, movable);

    track.updateBoostPads(dt);
    checkBoostPads(activeKarts);

    // Anything that hit the player this frame shakes the camera and thumps.
    if (player.impactMagnitude > 0.01) {
      addCameraShake(0.35 + player.impactMagnitude * 0.6);
      gameAudio.impact(0.4 + player.impactMagnitude);
    }
    for (const k of karts) k.impactMagnitude = 0;

    // Boost fired this frame (drift turbo or a pad) — rising whoosh.
    if (player.boostTimer > 0 && prevBoostTimer <= 0) gameAudio.boost();
    prevBoostTimer = player.boostTimer;

    gameAudio.update({
      speed: player.speed,
      maxSpeed: KART_PHYSICS.maxSpeed,
      throttle: input.up ? 1 : (input.down ? -1 : 0),
      drifting: player.driftDir !== 0,
      offTrack: player.offTrack,
    });

    if (netSession) {
      netTickAccumulator += dt;
      if (netTickAccumulator >= NET_TICK_INTERVAL) {
        netTickAccumulator = 0;
        if (netSession.isHost) netSession.broadcastSnapshot(karts.map(k => k.getNetworkState()), [...humanSlots]);
        else netSession.sendState(karts[myKartIndex].getNetworkState());
      }
    }

    if (gameState === 'racing') {
      if (player.laps >= TOTAL_LAPS && player.finishTime === null) {
        player.finishTime = performance.now() - raceStartTime;
        finishRace();
      }
      updateHud();
    }
  } else if (gameState === 'countdown' && !blocked) {
    track.updateBoostPads(dt);
    gameAudio.update({ speed: 0, maxSpeed: KART_PHYSICS.maxSpeed, throttle: 0, drifting: false, offTrack: false });
  } else {
    gameAudio.idle(); // menus and results: fade the engine out rather than leaving it droning
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}

animate();
