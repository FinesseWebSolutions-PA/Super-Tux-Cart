// Track: builds a closed-loop 3D race track (road ribbon, side walls,
// scenery and boost pads) from a Catmull-Rom curve.

function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6b7078';
  ctx.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 500; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
  }
  for (let i = 0; i < 250; i++) {
    ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
  }
  // center dashed line
  ctx.fillStyle = '#ffd93d';
  ctx.fillRect(27, 0, 10, 110);
  ctx.fillRect(27, 146, 10, 110);
  // edge lines
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(2, 0, 8, 256);
  ctx.fillRect(54, 0, 8, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeWallTexture() {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 32;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#d43b3b';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#f7f7f7';
  ctx.fillRect(0, 0, 16, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

class Track {
  constructor() {
    this.width = 15;
    this.segments = 440;

    const rawPoints = [
      [0, -105], [60, -126], [122, -102], [156, -48], [172, -14], [150, 20],
      [99, 51], [68, 24], [34, 34], [7, 71], [-48, 99], [-109, 78],
      [-150, 17], [-165, -18], [-143, -54], [-95, -99], [-41, -85],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));

    this.curve = new THREE.CatmullRomCurve3(rawPoints, true, 'catmullrom', 0.5);

    this.points = this.curve.getSpacedPoints(this.segments);
    this.tangents = this.points.map((_, i) => this.curve.getTangentAt(i / this.segments).normalize());
    this.sides = this.tangents.map(t => new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize());

    this.lakeCenter = new THREE.Vector2(230, 80);
    this.lakeRadius = 46;

    this.group = new THREE.Group();
    this._buildGround();
    this._buildLake();
    this._buildRoad();
    this._buildWalls();
    this._buildStartLine();
    this._buildScenery();
    this._buildMountains();
    this._buildBoostPads();
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry(1200, 1200);
    const mat = new THREE.MeshLambertMaterial({ color: 0x479238 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.3;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildLake() {
    const geo = new THREE.CircleGeometry(this.lakeRadius, 40);
    const mat = new THREE.MeshLambertMaterial({ color: 0x2f7fc1, transparent: true, opacity: 0.88 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(this.lakeCenter.x, -0.15, this.lakeCenter.y);
    this.group.add(mesh);

    const shoreGeo = new THREE.RingGeometry(this.lakeRadius, this.lakeRadius + 3, 40);
    const shoreMat = new THREE.MeshLambertMaterial({ color: 0xd8c68a });
    const shore = new THREE.Mesh(shoreGeo, shoreMat);
    shore.rotation.x = -Math.PI / 2;
    shore.position.set(this.lakeCenter.x, -0.2, this.lakeCenter.y);
    this.group.add(shore);
  }

  _isClearOfTrack(x, z, margin) {
    let minDist = Infinity;
    for (let i = 0; i < this.points.length; i += 4) {
      const d = Math.hypot(this.points[i].x - x, this.points[i].z - z);
      if (d < minDist) minDist = d;
    }
    return minDist > this.width / 2 + margin;
  }

  _isClearOfLake(x, z, margin) {
    return Math.hypot(x - this.lakeCenter.x, z - this.lakeCenter.y) > this.lakeRadius + margin;
  }

  _buildRoad() {
    const half = this.width / 2;
    const N = this.segments;
    const positions = [];
    const uvs = [];
    const indices = [];

    for (let i = 0; i <= N; i++) {
      const idx = i % N;
      const p = this.points[idx];
      const side = this.sides[idx];
      const left = new THREE.Vector3().copy(p).addScaledVector(side, half);
      const right = new THREE.Vector3().copy(p).addScaledVector(side, -half);
      positions.push(left.x, 0.02, left.z, right.x, 0.02, right.z);
      const v = i / 8;
      uvs.push(0, v, 1, v);
    }

    for (let i = 0; i < N; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      indices.push(a, c, b, b, c, d);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    const tex = makeAsphaltTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const tex = makeWallTexture();
    const mat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });

    [1, -1].forEach(sign => {
      const half = this.width / 2 + 0.2;
      const N = this.segments;
      const positions = [];
      const uvs = [];
      const indices = [];
      for (let i = 0; i <= N; i++) {
        const idx = i % N;
        const p = this.points[idx];
        const side = this.sides[idx];
        const base = new THREE.Vector3().copy(p).addScaledVector(side, half * sign);
        positions.push(base.x, 0.12, base.z, base.x, 0.75, base.z);
        const u = i / 6;
        uvs.push(u, 0, u, 1);
      }
      for (let i = 0; i < N; i++) {
        const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
        if (sign > 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      this.group.add(mesh);
    });
  }

  _buildStartLine() {
    const p = this.points[0];
    const side = this.sides[0];
    const tangent = this.tangents[0];
    const geo = new THREE.PlaneGeometry(this.width, 2.2);
    const c = document.createElement('canvas');
    c.width = 64; c.height = 16;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 2; y++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? '#111' : '#fff';
        ctx.fillRect(x * 8, y * 8, 8, 8);
      }
    }
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.MeshBasicMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const angle = Math.atan2(tangent.x, tangent.z);
    mesh.rotation.z = -angle;
    mesh.position.set(p.x, 0.08, p.z);
    this.group.add(mesh);

    // start banner posts
    [1, -1].forEach(sign => {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.2, 0.2, 5, 8),
        new THREE.MeshLambertMaterial({ color: 0xffffff })
      );
      const pos = new THREE.Vector3().copy(p).addScaledVector(side, sign * (this.width / 2 + 1));
      post.position.set(pos.x, 2.5, pos.z);
      this.group.add(post);
    });
  }

  _buildScenery() {
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.3, 2, 6);
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4423 });
    const pineLeafGeo = new THREE.ConeGeometry(1.6, 3.2, 8);
    const pineLeafMat = new THREE.MeshLambertMaterial({ color: 0x2e8b3d });
    const roundLeafGeo = new THREE.SphereGeometry(1.7, 8, 6);
    const roundLeafMat = new THREE.MeshLambertMaterial({ color: 0x5fae4a });

    const rockGeo = new THREE.DodecahedronGeometry(1.1, 0);
    const rockMat = new THREE.MeshLambertMaterial({ color: 0x8c8c86 });

    const count = 260;
    const rockCount = 40;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const pineLeaves = new THREE.InstancedMesh(pineLeafGeo, pineLeafMat, count);
    const roundLeaves = new THREE.InstancedMesh(roundLeafGeo, roundLeafMat, count);
    const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
    trunks.castShadow = true;
    pineLeaves.castShadow = true;
    roundLeaves.castShadow = true;
    rocks.castShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0, pineCount = 0, roundCount = 0, attempts = 0;
    while (placed < count && attempts < count * 20) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const radius = 60 + Math.random() * 230;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 0.95;

      if (!this._isClearOfTrack(x, z, 6) || !this._isClearOfLake(x, z, 10)) continue;

      const scale = 0.7 + Math.random() * 0.9;
      dummy.position.set(x, 1 * scale, z);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      trunks.setMatrixAt(placed, dummy.matrix);

      if (Math.random() < 0.6) {
        dummy.position.set(x, (2 + 1.4) * scale, z);
        dummy.updateMatrix();
        pineLeaves.setMatrixAt(pineCount, dummy.matrix);
        pineCount++;
      } else {
        dummy.position.set(x, (2 + 1.3) * scale, z);
        dummy.updateMatrix();
        roundLeaves.setMatrixAt(roundCount, dummy.matrix);
        roundCount++;
      }
      placed++;
    }
    trunks.count = placed;
    pineLeaves.count = pineCount;
    roundLeaves.count = roundCount;
    this.group.add(trunks, pineLeaves, roundLeaves);

    let rocksPlaced = 0;
    attempts = 0;
    while (rocksPlaced < rockCount && attempts < rockCount * 20) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const radius = 40 + Math.random() * 150;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 0.95;
      if (!this._isClearOfTrack(x, z, 5) || !this._isClearOfLake(x, z, 6)) continue;

      const scale = 0.6 + Math.random() * 1.1;
      dummy.position.set(x, 0.5 * scale, z);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
      dummy.updateMatrix();
      rocks.setMatrixAt(rocksPlaced, dummy.matrix);
      rocksPlaced++;
    }
    rocks.count = rocksPlaced;
    this.group.add(rocks);
  }

  _buildMountains() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x9fb6d4 });
    const count = 20;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.15;
      const radius = 430 + Math.random() * 90;
      const height = 90 + Math.random() * 130;
      const base = 60 + Math.random() * 50;
      const geo = new THREE.ConeGeometry(base, height, 5);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Math.cos(angle) * radius, height / 2 - 6, Math.sin(angle) * radius);
      mesh.rotation.y = Math.random() * Math.PI;
      this.group.add(mesh);
    }
  }

  _buildBoostPads() {
    this.boostPads = [];
    const padCount = 10;
    const N = this.segments;
    const step = Math.floor(N / padCount);
    const geo = new THREE.TorusGeometry(1.1, 0.28, 8, 16);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });

    for (let i = 1; i <= padCount; i++) {
      const idx = (i * step + Math.floor(step / 2)) % N;
      const p = this.points[idx];
      const mesh = new THREE.Mesh(geo, mat.clone());
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(p.x, 0.5, p.z);
      this.group.add(mesh);
      this.boostPads.push({ mesh, index: idx, position: p.clone(), active: true, cooldown: 0 });
    }
  }

  updateBoostPads(dt) {
    for (const pad of this.boostPads) {
      pad.mesh.rotation.z += dt * 2;
      if (!pad.active) {
        pad.cooldown -= dt;
        if (pad.cooldown <= 0) {
          pad.active = true;
          pad.mesh.visible = true;
        }
      } else {
        pad.mesh.position.y = 0.5 + Math.sin(performance.now() / 300 + pad.index) * 0.15;
      }
    }
  }

  // Find nearest sample index to a world position, searching a window
  // around `hint` (previous index) for efficiency, wrapping around the loop.
  nearestIndex(position, hint) {
    const N = this.segments;
    let best = -1;
    let bestDist = Infinity;
    const range = hint == null ? N : 20;
    const start = hint == null ? 0 : hint - range / 2;
    for (let k = 0; k < (hint == null ? N : range); k++) {
      const idx = ((start + k) % N + N) % N;
      const p = this.points[idx];
      const d = (p.x - position.x) ** 2 + (p.z - position.z) ** 2;
      if (d < bestDist) { bestDist = d; best = idx; }
    }
    return { index: best, distance: Math.sqrt(bestDist) };
  }

  lateralOffset(position, index) {
    const p = this.points[index];
    const side = this.sides[index];
    const dx = position.x - p.x;
    const dz = position.z - p.z;
    return dx * side.x + dz * side.z;
  }
}
