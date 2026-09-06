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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !isMobile });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobile ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x7ec0ee);
scene.fog = new THREE.Fog(0x7ec0ee, 120, 420);

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);

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
sun.shadow.camera.left = -140;
sun.shadow.camera.right = 140;
sun.shadow.camera.top = 140;
sun.shadow.camera.bottom = -140;
scene.add(sun);

const track = new Track();
scene.add(track.group);

const KART_COLORS = [0xd6322c, 0x2f6fd6, 0x3ca35c, 0x8a3ccf];
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
const player = karts[0];

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
    case 'KeyR': if (val && gameState === 'finished') restartRace(); break;
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
const TILT_MAX_ANGLE = 22; // degrees of tilt for full steering lock
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
const introEl = document.getElementById('intro');

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
function updateCamera(dt) {
  const forward = new THREE.Vector3(Math.sin(player.heading), 0, Math.cos(player.heading));
  const desired = new THREE.Vector3()
    .copy(player.position)
    .addScaledVector(forward, -8.5)
    .add(new THREE.Vector3(0, 3.6, 0));
  const lerp = 1 - Math.pow(0.001, dt);
  camera.position.lerp(desired, lerp);
  const lookTarget = new THREE.Vector3().copy(player.position).addScaledVector(forward, 4).add(new THREE.Vector3(0, 1.2, 0));
  camera.lookAt(lookTarget);
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

document.getElementById('start-btn').addEventListener('click', () => {
  introEl.classList.add('hidden');
  hud.classList.add('active');
  touchControlsEl.classList.add('active');
  startCountdown();
});

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
    if (k.isPlayer) {
      const t = k.finishTime / 1000;
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = (t % 60).toFixed(2).padStart(5, '0');
      li.textContent = `${ordinal(i + 1)} — You — ${mm}:${ss}`;
      li.style.color = '#ffd23f';
    } else {
      li.textContent = `${ordinal(i + 1)} — CPU Racer`;
    }
    resultsList.appendChild(li);
  });
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
    k._syncMesh();
  }
  for (const pad of track.boostPads) { pad.active = true; pad.mesh.visible = true; }
  raceStartTime = null;
  startCountdown();
}

function checkBoostPads() {
  for (const pad of track.boostPads) {
    if (!pad.active) continue;
    for (const k of karts) {
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  const blocked = isPortraitBlocked();
  if (blocked && !wasBlocked) blockStartedAt = performance.now();
  if (!blocked && wasBlocked && raceStartTime !== null) raceStartTime += performance.now() - blockStartedAt;
  wasBlocked = blocked;

  if (gameState === 'racing' && !blocked) {
    input.steer = (tiltEnabled && tiltNeutral !== null)
      ? THREE.MathUtils.clamp((tiltNeutral - tiltRaw) / TILT_MAX_ANGLE, -1, 1)
      : null;
    player.updatePlayer(dt, input, track);
    for (let i = 1; i < karts.length; i++) karts[i].updateAI(dt, track);
    track.updateBoostPads(dt);
    checkBoostPads();

    if (player.laps >= TOTAL_LAPS && player.finishTime === null) {
      player.finishTime = performance.now() - raceStartTime;
      finishRace();
    }
    updateHud();
  } else if (gameState === 'countdown' && !blocked) {
    track.updateBoostPads(dt);
  }

  updateCamera(dt);
  renderer.render(scene, camera);
}

animate();
