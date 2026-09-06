// Track: builds a closed-loop 3D race track (road ribbon, side walls,
// scenery and boost pads) from a Catmull-Rom curve.

function makeAsphaltTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#3a3d42';
  ctx.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    ctx.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
  }
  // center dashed line
  ctx.fillStyle = '#f2d24b';
  ctx.fillRect(28, 0, 8, 110);
  ctx.fillRect(28, 146, 8, 110);
  // edge lines
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(4, 0, 5, 256);
  ctx.fillRect(55, 0, 5, 256);
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
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, 0, 16, 32);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

class Track {
  constructor() {
    this.width = 15;
    this.segments = 260;

    const rawPoints = [
      [0, -62], [35, -74], [72, -60], [92, -28], [88, 12],
      [58, 30], [40, 14], [20, 20], [4, 42], [-28, 58],
      [-64, 46], [-88, 10], [-84, -32], [-56, -58], [-24, -50],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z));

    this.curve = new THREE.CatmullRomCurve3(rawPoints, true, 'catmullrom', 0.5);

    this.points = this.curve.getSpacedPoints(this.segments);
    this.tangents = this.points.map((_, i) => this.curve.getTangentAt(i / this.segments).normalize());
    this.sides = this.tangents.map(t => new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), t).normalize());

    this.group = new THREE.Group();
    this._buildGround();
    this._buildRoad();
    this._buildWalls();
    this._buildStartLine();
    this._buildScenery();
    this._buildBoostPads();
  }

  _buildGround() {
    const geo = new THREE.PlaneGeometry(700, 700);
    const mat = new THREE.MeshLambertMaterial({ color: 0x4c9a3f });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = -0.05;
    mesh.receiveShadow = true;
    this.group.add(mesh);
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
    tex.repeat.set(1, N / 8);
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  _buildWalls() {
    const tex = makeWallTexture();
    tex.repeat.set(this.segments / 6, 1);
    const mat = new THREE.MeshLambertMaterial({ map: tex });

    [1, -1].forEach(sign => {
      const half = this.width / 2 + 0.35;
      const N = this.segments;
      const positions = [];
      const uvs = [];
      const indices = [];
      for (let i = 0; i <= N; i++) {
        const idx = i % N;
        const p = this.points[idx];
        const side = this.sides[idx];
        const base = new THREE.Vector3().copy(p).addScaledVector(side, half * sign);
        positions.push(base.x, 0.05, base.z, base.x, 0.55, base.z);
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
    mesh.position.set(p.x, 0.03, p.z);
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
    const leafGeo = new THREE.ConeGeometry(1.6, 3.2, 8);
    const leafMat = new THREE.MeshLambertMaterial({ color: 0x2e8b3d });

    const count = 140;
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
    const leaves = new THREE.InstancedMesh(leafGeo, leafMat, count);
    trunks.castShadow = true;
    leaves.castShadow = true;

    const dummy = new THREE.Object3D();
    let placed = 0;
    let attempts = 0;
    while (placed < count && attempts < count * 20) {
      attempts++;
      const angle = Math.random() * Math.PI * 2;
      const radius = 55 + Math.random() * 160;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius * 0.9;

      let minDist = Infinity;
      for (let i = 0; i < this.points.length; i += 4) {
        const d = Math.hypot(this.points[i].x - x, this.points[i].z - z);
        if (d < minDist) minDist = d;
      }
      if (minDist < this.width / 2 + 6) continue;

      const scale = 0.7 + Math.random() * 0.9;
      dummy.position.set(x, 1 * scale, z);
      dummy.scale.set(scale, scale, scale);
      dummy.rotation.y = Math.random() * Math.PI * 2;
      dummy.updateMatrix();
      trunks.setMatrixAt(placed, dummy.matrix);

      dummy.position.set(x, (2 + 1.4) * scale, z);
      dummy.updateMatrix();
      leaves.setMatrixAt(placed, dummy.matrix);
      placed++;
    }
    trunks.count = placed;
    leaves.count = placed;
    this.group.add(trunks, leaves);
  }

  _buildBoostPads() {
    this.boostPads = [];
    const padCount = 8;
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
