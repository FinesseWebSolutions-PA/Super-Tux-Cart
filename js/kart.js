// Kart: visual model + arcade driving physics shared by the player and AI.

const KART_PHYSICS = {
  maxSpeed: 32,
  reverseMax: 13,
  accel: 22,
  brakeDecel: 42,
  coastDecel: 11,
  turnRate: 2.7,
  driftTurnMult: 1.55,
  offTrackFactor: 0.42,
};

const KART_RADIUS = 1.05;
const BUMP_RESTITUTION = 9;
const BUMP_DECAY = 3.5;

function buildKartMesh(bodyColor) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 0.55, 3.2),
    new THREE.MeshLambertMaterial({ color: bodyColor })
  );
  body.position.y = 0.5;
  body.castShadow = true;
  group.add(body);

  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(1.1, 0.5, 1.3),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  cabin.position.set(0, 0.95, -0.2);
  cabin.castShadow = true;
  group.add(cabin);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 1.0, 4),
    new THREE.MeshLambertMaterial({ color: bodyColor })
  );
  nose.rotation.x = Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  nose.position.set(0, 0.5, 1.85);
  group.add(nose);

  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.35, 12);
  const wheelMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1a });
  const wheels = [];
  const wheelOffsets = [
    [0.85, 0.42, 1.05], [-0.85, 0.42, 1.05],
    [0.85, 0.42, -1.05], [-0.85, 0.42, -1.05],
  ];
  for (const [x, y, z] of wheelOffsets) {
    const w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, y, z);
    w.castShadow = true;
    group.add(w);
    wheels.push(w);
  }

  return { group, wheels, frontWheels: [wheels[0], wheels[1]], body, nose };
}

class Kart {
  constructor({ color, isPlayer, startPoint, startTangent, laneOffset }) {
    this.isPlayer = isPlayer;
    const model = buildKartMesh(color);
    this.mesh = model.group;
    this.wheels = model.wheels;
    this.frontWheels = model.frontWheels;
    this.bodyMesh = model.body;
    this.noseMesh = model.nose;

    const heading = Math.atan2(startTangent.x, startTangent.z);
    const side = new THREE.Vector3(Math.cos(heading), 0, -Math.sin(heading));
    this.position = new THREE.Vector3().copy(startPoint).addScaledVector(side, laneOffset);
    this.heading = heading;
    this.speed = 0;

    this.driftHeld = false;
    this.driftDir = 0;
    this.driftTime = 0;
    this.boostTimer = 0;
    this.boostMultiplier = 1;

    this.bumpVelocity = new THREE.Vector3();

    this.lastIndex = null;
    this.hasStarted = true; // false = spawned behind the line; its first line-crossing doesn't count as a lap
    this.laps = 0;
    this.finished = false;
    this.finishTime = null;
    // Player always races at baseline; AI karts get theirs from setDifficulty() per the chosen CPU difficulty.
    this.aiSkill = 1;
    this.aiLookahead = 9 + Math.floor(Math.random() * 4);

    this._syncMesh();
  }

  _syncMesh() {
    this.mesh.position.set(this.position.x, this.position.y, this.position.z);
    this.mesh.rotation.y = this.heading;
  }

  get offTrack() { return this._offTrack; }

  _integrate(dt, throttle, steerInput, driftHeld, track) {
    const P = KART_PHYSICS;

    const { index } = track.nearestIndex(this.position, this.lastIndex);
    if (this.lastIndex !== null) {
      const N = track.segments;
      let delta = index - this.lastIndex;
      if (delta < -N / 2) {
        if (this.hasStarted) this.laps += 1;
        this.hasStarted = true;
      } else if (delta > N / 2) {
        if (this.hasStarted) this.laps = Math.max(0, this.laps - 1);
      }
    }
    this.lastIndex = index;
    const lateral = track.lateralOffset(this.position, index);
    this._offTrack = Math.abs(lateral) > track.width / 2 + 0.2;
    this.position.y = track.points[index].y; // follow the road's elevation — hills, not free 3D physics

    // Climbing costs top speed, descending gives some back — tangent.y is
    // small for these gentle grades (a few percent), so this stays a light
    // touch rather than a hill you can stall out on.
    const slope = track.tangents[index].y * (this.speed >= 0 ? 1 : -1);

    // Drift & mini-turbo
    const wantsDrift = driftHeld && Math.abs(steerInput) > 0.3 && this.speed > 6;
    let turnMult = 1;
    if (wantsDrift) {
      if (this.driftDir === 0) this.driftDir = Math.sign(steerInput);
      this.driftTime += dt;
      turnMult = P.driftTurnMult;
    } else if (this.driftDir !== 0) {
      if (this.driftTime > 0.9) { this.boostTimer = 1.0; this.boostMultiplier = 1.5; }
      else if (this.driftTime > 0.4) { this.boostTimer = 0.6; this.boostMultiplier = 1.25; }
      this.driftDir = 0;
      this.driftTime = 0;
    }

    if (this.boostTimer > 0) this.boostTimer -= dt;
    const boosted = this.boostTimer > 0;

    let effectiveMax = P.maxSpeed * (boosted ? this.boostMultiplier : 1) * (this.aiSkill || 1);
    effectiveMax *= THREE.MathUtils.clamp(1 - slope * 1.5, 0.7, 1.2);
    if (this._offTrack) effectiveMax *= P.offTrackFactor;

    if (throttle > 0) {
      this.speed += P.accel * throttle * dt;
      this.speed = Math.min(this.speed, effectiveMax);
    } else if (throttle < 0) {
      if (this.speed > 0.5) this.speed -= P.brakeDecel * dt;
      else this.speed = Math.max(this.speed + throttle * P.accel * 0.55 * dt, -P.reverseMax);
    } else {
      if (this.speed > 0) this.speed = Math.max(0, this.speed - P.coastDecel * dt);
      else this.speed = Math.min(0, this.speed + P.coastDecel * dt);
    }
    if (this._offTrack && this.speed > effectiveMax) {
      this.speed = Math.max(effectiveMax, this.speed - P.coastDecel * 2 * dt);
    }

    const speedFactor = Math.min(1, Math.max(0.35, Math.abs(this.speed) / 9));
    const highSpeedDamp = 1 - 0.25 * Math.min(1, Math.abs(this.speed) / P.maxSpeed);
    const dir = this.speed >= 0 ? 1 : -1;
    this.heading += steerInput * P.turnRate * turnMult * speedFactor * highSpeedDamp * dir * dt;

    const forward = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    this.position.addScaledVector(forward, this.speed * dt);

    this.position.addScaledVector(this.bumpVelocity, dt);
    this.bumpVelocity.multiplyScalar(Math.max(0, 1 - BUMP_DECAY * dt));

    for (const w of this.wheels) w.rotation.x -= this.speed * dt * 2.2;
    const steerVisual = THREE.MathUtils.clamp(steerInput * 0.5, -0.5, 0.5);
    for (const w of this.frontWheels) w.rotation.y = steerVisual;

    this._syncMesh();
  }

  updatePlayer(dt, input, track) {
    const throttle = input.up ? 1 : (input.down ? -1 : 0);
    const steer = (input.steer !== undefined && input.steer !== null)
      ? input.steer
      : (input.left ? 1 : 0) - (input.right ? 1 : 0);
    this._integrate(dt, throttle, steer, input.drift, track);
  }

  updateAI(dt, track) {
    const N = track.segments;
    const idx = this.lastIndex == null ? 0 : this.lastIndex;
    const targetIdx = (idx + this.aiLookahead) % N;
    const target = track.points[targetIdx];

    const dx = target.x - this.position.x;
    const dz = target.z - this.position.z;
    const desiredHeading = Math.atan2(dx, dz);
    let deltaAngle = desiredHeading - this.heading;
    while (deltaAngle > Math.PI) deltaAngle -= Math.PI * 2;
    while (deltaAngle < -Math.PI) deltaAngle += Math.PI * 2;

    const steer = THREE.MathUtils.clamp(deltaAngle * 2.2, -1, 1);
    const throttle = Math.abs(deltaAngle) > 0.7 ? 0.55 : 1;
    const drift = Math.abs(deltaAngle) > 0.5 && this.speed > 10;

    this._integrate(dt, throttle, steer, drift, track);
  }

  get progress() {
    return this.laps * 100000 + (this.lastIndex || 0);
  }

  setColor(hex) {
    this.bodyMesh.material.color.setHex(hex);
    this.noseMesh.material.color.setHex(hex);
  }

  setDifficulty(skillMin, skillMax, lookaheadMin, lookaheadMax) {
    this.aiSkill = skillMin + Math.random() * (skillMax - skillMin);
    this.aiLookahead = lookaheadMin + Math.floor(Math.random() * (lookaheadMax - lookaheadMin + 1));
  }

  // Multiplayer: this kart's state as sent over the network. Only the
  // sender ever runs real physics on it — laps travels as an authoritative
  // value rather than being re-derived from position on the receiving end.
  getNetworkState() {
    return {
      x: this.position.x, z: this.position.z, h: this.heading, s: this.speed,
      laps: this.laps, boostTimer: this.boostTimer, driftDir: this.driftDir,
    };
  }

  // Multiplayer: apply a state received for a kart driven elsewhere (a
  // remote human, or AI simulated by the host). Position/heading/laps are
  // taken as given; lastIndex/offTrack are re-derived locally purely for
  // this client's own HUD ranking and collision checks, without touching
  // the authoritative lap count.
  applyNetworkState(state, track) {
    this.position.x = state.x;
    this.position.z = state.z;
    this.heading = state.h;
    this.speed = state.s;
    this.laps = state.laps;
    this.boostTimer = state.boostTimer;
    this.driftDir = state.driftDir;

    const { index } = track.nearestIndex(this.position, this.lastIndex);
    this.lastIndex = index;
    this._offTrack = Math.abs(track.lateralOffset(this.position, index)) > track.width / 2 + 0.2;
    this.position.y = track.points[index].y;

    for (const w of this.wheels) w.rotation.x -= this.speed * (1 / 60) * 2.2;
    this._syncMesh();
  }
}

// Circle-circle collision between kart pairs: separates overlapping karts
// and kicks both away from the impact along the contact normal, so bumping
// another kart actually bounces you off it instead of sliding through.
//
// `movable`, when given (a Set of kart indices), restricts which karts are
// ever allowed to move — a pair where neither side is movable is skipped
// entirely, and within a pair only the movable side gets pushed. In
// multiplayer this lets a client feel an instant local bounce off
// remote-driven karts without fighting the next incoming network snapshot
// (which would otherwise just overwrite any push applied to a kart that
// isn't locally authoritative), and lets a host apply full physics between
// its own kart and the AI it simulates while still treating connected
// humans' karts as fixed for the same reason.
function resolveKartCollisions(karts, movable = null) {
  const minDist = KART_RADIUS * 2;
  for (let i = 0; i < karts.length; i++) {
    for (let j = i + 1; j < karts.length; j++) {
      const aMoves = movable === null || movable.has(i);
      const bMoves = movable === null || movable.has(j);
      if (!aMoves && !bMoves) continue;

      const a = karts[i];
      const b = karts[j];
      const dx = b.position.x - a.position.x;
      const dz = b.position.z - a.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= minDist || dist < 1e-4) continue;

      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;

      const aShare = aMoves && bMoves ? 0.5 : (aMoves ? 1 : 0);
      const bShare = aMoves && bMoves ? 0.5 : (bMoves ? 1 : 0);

      a.position.x -= nx * overlap * aShare;
      a.position.z -= nz * overlap * aShare;
      b.position.x += nx * overlap * bShare;
      b.position.z += nz * overlap * bShare;

      const closingSpeed = Math.max(Math.abs(a.speed), Math.abs(b.speed), 4);
      const impulse = Math.min(BUMP_RESTITUTION, closingSpeed * 0.5);
      if (aMoves) {
        a.bumpVelocity.x -= nx * impulse;
        a.bumpVelocity.z -= nz * impulse;
        a.speed *= 0.8;
        a._syncMesh();
      }
      if (bMoves) {
        b.bumpVelocity.x += nx * impulse;
        b.bumpVelocity.z += nz * impulse;
        b.speed *= 0.8;
        b._syncMesh();
      }
    }
  }
}

// Track obstacles (cones) never move — hitting one only ever pushes and
// slows the kart, same restitution feel as a kart-kart bump. `movable`
// restricts which kart indices are checked at all, matching
// resolveKartCollisions' convention (null = check every kart).
function resolveObstacleCollisions(karts, obstacles, movable = null) {
  for (let i = 0; i < karts.length; i++) {
    if (movable !== null && !movable.has(i)) continue;
    const k = karts[i];
    for (const obs of obstacles) {
      const dx = k.position.x - obs.position.x;
      const dz = k.position.z - obs.position.z;
      const dist = Math.hypot(dx, dz);
      const minDist = KART_RADIUS + obs.radius;
      if (dist >= minDist || dist < 1e-4) continue;

      const nx = dx / dist;
      const nz = dz / dist;
      const overlap = minDist - dist;
      k.position.x += nx * overlap;
      k.position.z += nz * overlap;

      const impulse = Math.min(BUMP_RESTITUTION, Math.max(Math.abs(k.speed), 4) * 0.6);
      k.bumpVelocity.x += nx * impulse;
      k.bumpVelocity.z += nz * impulse;
      k.speed *= 0.6;
      k._syncMesh();
    }
  }
}
