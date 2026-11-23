import * as THREE from 'three';
import * as CANNON from 'cannon-es';

// 고리 하나의 형태: 가로 a(반원 반지름), 직선부 s, 철사 두께 r — 피치(고리 간 거리)는 안쪽 길이와 같다
const A = 0.42, S = 0.72, R = 0.16;
const PITCH = S + 2 * A - 2 * R;
const HALF = PITCH / 2;
const N = 9;
const MID = (N / 2) | 0; // 펜으로 그려지는 첫 고리 — 짝수 번째라 카메라를 정면으로 마주한다
// 그림 → 철 과정의 타임라인(buildT 0→1). 기다리면 저절로 진행되고, 스크롤하면 앞당겨진다
const BUILD_MS = 6200;
const T = {
  outer: [0.03, 0.30], hop: [0.30, 0.34], inner: [0.34, 0.50],
  hatch: [0.50, 0.66], chrome: [0.64, 0.84], inflate: [0.62, 0.82],
  lineFade: [0.66, 0.78], wave: [0.80, 1.0], camera: [0.78, 1.0], physics: 0.80,
};
const SLACK = 0.012;
const FOV = 30;
const GRAVITY = -2.5;
const DRAG_FORCE = 160;
const LINK = 1, POINTER = 2;
// 맞물린 고리는 이웃에 대해 마음대로 돌 수 없다 — 철사 굵기(2R)와 구멍 폭(2(A-R))이 허락하는 만큼만 비틀리고 꺾인다
// 비틀림: 0.16/cosφ + 0.16·tanφ ≤ 0.26 을 풀면 약 27°, 꺾임: 반원 안쪽을 미끄러져 직선부에 닿기 전까지
const TWIST_MAX = THREE.MathUtils.degToRad(25);
const SWING_MAX = THREE.MathUtils.degToRad(62);

const canvas = document.getElementById('chain-canvas');
const pin = document.getElementById('hero-pin');
if (canvas && pin) init();

function stadium() {
  const curve = new THREE.Curve();
  const total = 2 * S + 2 * Math.PI * A;
  curve.getPoint = (t, target = new THREE.Vector3()) => {
    let d = t * total;
    if (d < S) return target.set(A, -S / 2 + d, 0);
    d -= S;
    if (d < Math.PI * A) { const th = d / A; return target.set(A * Math.cos(th), S / 2 + A * Math.sin(th), 0); }
    d -= Math.PI * A;
    if (d < S) return target.set(-A, S / 2 - d, 0);
    d -= S;
    const th = Math.PI + d / A;
    return target.set(A * Math.cos(th), -S / 2 + A * Math.sin(th), 0);
  };
  return new THREE.TubeGeometry(curve, 120, R, 28, true);
}

// 크롬은 비치는 환경이 곧 색이다 — 어두운 스튜디오에 밝은 조명 띠를 둘러 대비 강한 반사를 만든다
function chromeStudio() {
  const env = new THREE.Scene();
  // 위는 밝고 수평선 아래로 갈수록 어두워지는 하늘 — 크롬 표면에 부드러운 명암 그라데이션이 생긴다
  const sky = new THREE.SphereGeometry(50, 48, 24);
  const top = new THREE.Color(0x8a919e), mid = new THREE.Color(0x2c3038), bottom = new THREE.Color(0x0b0c10);
  const colors = [];
  const pos = sky.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 50;
    const c = h > 0 ? mid.clone().lerp(top, Math.pow(h, 0.7)) : mid.clone().lerp(bottom, Math.pow(-h, 0.6));
    colors.push(c.r, c.g, c.b);
  }
  sky.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  env.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const strip = (w, h, x, y, z, intensity, tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.lookAt(0, 0, 0);
    env.add(m);
  };
  strip(60, 14, 0, 22, 6, 3.2);
  strip(6, 34, -22, 2, 12, 2.6);
  strip(5, 34, 22, 0, 8, 3);
  strip(40, 6, 0, -18, 14, 1.2);
  strip(26, 20, 0, 4, 26, 1.6, 0xe6ecf7);
  strip(20, 20, 0, 4, -26, 0.6);
  return env;
}

function init() {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch {
    canvas.remove();
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(chromeStudio(), 0.035).texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(6, 10, 9);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 200);
  const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));

  const material = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, metalness: 1, roughness: 0.08, envMapIntensity: 1.15 });
  // 블렌더 라이브러리의 ambientCG Metal009(브러시드 스틸, CC0) — 결이 철사 길이 방향으로 흐르게 붙이고,
  // 거칠기는 크롬답게 0.11~0.24 범위로 눌러 반사는 살리되 클로즈업에서 미세한 결과 흠집이 보이게 한다
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const metalTex = (url, apply) => texLoader.load(new URL(url, import.meta.url).href, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 1);
    t.anisotropy = maxAniso;
    apply(t);
    material.needsUpdate = true;
    needsRender = true;
  });
  metalTex('../assets/tex/metal009_roughness.jpg', (t) => { material.roughnessMap = t; material.roughness = 0.35; });
  metalTex('../assets/tex/metal009_normal.jpg', (t) => { material.normalMap = t; material.normalScale.set(0.35, 0.35); });

  // ----- 그림 → 철 전환 셰이더 -----
  // 펜이 그린 순서(철사 길이 방향 uv.x)를 따라 빗금이 채워지고, 같은 방향으로 납작한 평면이 둥근 철사로 부풀며 크롬이 된다.
  // 첫 고리(aDelay < 0)는 uHatch·uChrome·uInflate를 그대로 따르고, 나머지 고리는 uWave에 맞춰 차례로 같은 과정을 빠르게 거친다
  const geometry = stadium();
  const uvAttr = geometry.attributes.uv;
  const along = new Float32Array(uvAttr.count);
  for (let i = 0; i < uvAttr.count; i++) along[i] = uvAttr.getX(i);
  geometry.setAttribute('aU', new THREE.BufferAttribute(along, 1));
  const delays = new Float32Array(N);
  for (let i = 0; i < N; i++) delays[i] = i === MID ? -1 : Math.abs(i - MID) * 0.15;
  geometry.setAttribute('aDelay', new THREE.InstancedBufferAttribute(delays, 1));
  const morph = {
    uHatch: { value: 0 }, uChrome: { value: 0 }, uInflate: { value: 0 }, uWave: { value: 0 },
    uPR: { value: 1 },
    uFill: { value: new THREE.Vector3(0x0e / 255, 0x12 / 255, 0x1a / 255) },
    uLine: { value: new THREE.Vector3(0x5a / 255, 0xa6 / 255, 0xff / 255) },
  };
  material.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, morph);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aU;
attribute float aDelay;
uniform float uHatch, uChrome, uInflate, uWave;
varying float vU;
flat varying float vHatchP, vChromeP;`)
      .replace('#include <beginnormal_vertex>', `float inflateP;
if (aDelay < 0.0) { vHatchP = uHatch; vChromeP = uChrome; inflateP = uInflate; }
else {
  float w = clamp((uWave - aDelay) / 0.4, 0.0, 1.0);
  vHatchP = w > 0.0 ? 1.01 : -1.0;
  vChromeP = smoothstep(0.2, 0.9, w) * 1.04;
  inflateP = smoothstep(0.15, 0.85, w);
}
// 완전히 0이면 삼각형이 선처럼 찌그러져 보간 오차가 점으로 새어 나온다 — 정면에선 보이지 않을 만큼의 두께를 남긴다
inflateP = max(inflateP, 0.03);
vU = aU;
#include <beginnormal_vertex>
objectNormal = normalize(mix(vec3(0.0, 0.0, 1.0), objectNormal, inflateP));`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed.z *= inflateP;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uPR;
uniform vec3 uFill, uLine;
varying float vU;
flat varying float vHatchP, vChromeP;`)
      .replace('void main() {', `void main() {
  if (vHatchP <= 0.0 || vU >= vHatchP) discard;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  float edge = vChromeP;
  float chromeAmt = 1.0 - smoothstep(edge - 0.012, edge, vU);
  vec2 fc = gl_FragCoord.xy / uPR;
  float d = abs(fract((fc.x + fc.y) / 11.0) - 0.5) * 11.0;
  float line = 1.0 - smoothstep(0.7, 1.6, d);
  vec3 flatCol = mix(uFill, uLine, line);
  float seam = edge > 0.001 && edge < 1.0 ? exp(-abs(vU - edge) * 90.0) : 0.0;
  float front = vHatchP < 1.0 ? exp(-abs(vU - vHatchP) * 160.0) : 0.0;
  gl_FragColor.rgb = mix(flatCol, gl_FragColor.rgb, chromeAmt) + (seam * 0.9 + front * 0.6) * vec3(0.55, 0.78, 1.0);
  gl_FragColor.a = 1.0;`);
  };

  const mesh = new THREE.InstancedMesh(geometry, material, N);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // ----- 물리: 양 끝을 화면 밖 대각선 위아래에 고정한 체인 -----
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.solver.iterations = 30;
  world.defaultContactMaterial.restitution = 0.35;
  world.defaultContactMaterial.friction = 0.1;

  const PIV_TOP = new CANNON.Vec3(0, HALF, 0);
  const PIV_BOTTOM = new CANNON.Vec3(0, -HALF, 0);
  const ZERO = new CANNON.Vec3();
  const shape = new CANNON.Box(new CANNON.Vec3(A + R, S / 2 + A + R, R));
  const ghost = { collisionFilterGroup: 0, collisionFilterMask: 0 };
  const anchorA = new CANNON.Body({ type: CANNON.Body.KINEMATIC, ...ghost });
  const anchorB = new CANNON.Body({ type: CANNON.Body.KINEMATIC, ...ghost });
  world.addBody(anchorA);
  world.addBody(anchorB);
  const pointer = new CANNON.Body({ type: CANNON.Body.KINEMATIC, shape: new CANNON.Sphere(0.24), position: new CANNON.Vec3(0, 99, 0), collisionFilterGroup: POINTER, collisionFilterMask: LINK });
  const dragBody = new CANNON.Body({ type: CANNON.Body.KINEMATIC, position: new CANNON.Vec3(0, 99, 0), ...ghost });
  world.addBody(pointer);
  world.addBody(dragBody);

  let links = [], joints = [], dir = new CANNON.Vec3(), perp = new CANNON.Vec3(), baseA = new CANNON.Vec3(), baseB = new CANNON.Vec3();
  let builtAngle = null;

  function build(angleDeg) {
    links.forEach((b) => world.removeBody(b));
    joints.forEach((c) => world.removeConstraint(c));
    links = [];
    joints = [];
    const th = THREE.MathUtils.degToRad(angleDeg);
    dir.set(Math.cos(th), -Math.sin(th), 0);
    perp.set(Math.sin(th), Math.cos(th), 0);
    const span = N * PITCH * (1 - SLACK);
    baseA.set(-dir.x * span / 2, -dir.y * span / 2, 0);
    baseB.set(dir.x * span / 2, dir.y * span / 2, 0);
    anchorA.position.copy(baseA);
    anchorB.position.copy(baseB);
    // 고리의 -Y(아래 걸림점)가 체인 진행 방향을 향하도록 Z축으로 돌리고, 짝수/홀수 고리는 자기 축으로 90° 엇갈린다
    const qz = new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI / 2 - th);
    const qTwist = qz.mult(new CANNON.Quaternion().setFromAxisAngle(new CANNON.Vec3(0, 1, 0), Math.PI / 2));
    // 양 끝 고정점도 '보이지 않는 고리'로 방향을 가져, 끝 고리가 고정점에서 팽이처럼 돌지 않는다
    anchorA.quaternion.copy(qTwist);
    anchorB.quaternion.copy(N % 2 ? qTwist : qz);
    anchorA.angularVelocity.setZero();
    anchorB.angularVelocity.setZero();
    for (let i = 0; i < N; i++) {
      const d = (HALF + i * PITCH) * (1 - SLACK);
      const b = new CANNON.Body({
        mass: 1, shape,
        position: new CANNON.Vec3(baseA.x + dir.x * d, baseA.y + dir.y * d, 0),
        linearDamping: 0.22, angularDamping: 0.45,
        collisionFilterGroup: LINK, collisionFilterMask: POINTER,
      });
      b.quaternion.copy(i % 2 ? qTwist : qz);
      world.addBody(b);
      links.push(b);
    }
    for (let i = 0; i <= N; i++) {
      const c = i === 0 ? new CANNON.PointToPointConstraint(anchorA, ZERO, links[0], PIV_TOP)
        : i === N ? new CANNON.PointToPointConstraint(links[N - 1], PIV_BOTTOM, anchorB, ZERO)
        : new CANNON.PointToPointConstraint(links[i - 1], PIV_BOTTOM, links[i], PIV_TOP);
      world.addConstraint(c);
      joints.push(c);
    }
    builtAngle = angleDeg;
  }

  // ----- 화면 배치 -----
  let W = 1, H = 1, portrait = false;
  function layout() {
    W = canvas.clientWidth || 1;
    H = canvas.clientHeight || 1;
    renderer.setSize(W, H, false);
    morph.uPR.value = renderer.getPixelRatio();
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    portrait = W / H < 0.9;
    const angle = portrait ? 64 : 30;
    if (angle !== builtAngle) { release(); build(angle); sync(); }
    needsRender = true;
  }

  const lerp = THREE.MathUtils.lerp;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const smooth = (x) => x * x * (3 - 2 * x);
  function progress() {
    if (!document.documentElement.classList.contains('hero-pinned')) return 1;
    const r = pin.getBoundingClientRect();
    return clamp01(-r.top / (r.height - innerHeight));
  }

  // 처음엔 고리 2~3개만 화면을 채우는 클로즈업, 제목이 올라오는 동안 오른쪽으로 물러나며 조금 멀어진다
  // 첫 진입: 멀리서 서서히 밝아지며 클로즈업까지 다가온다
  const introStart = performance.now();
  let buildT = reduceMotion ? 1 : 0;
  const span01 = (t, [a, b]) => clamp01((t - a) / (b - a));
  const physicsOn = () => buildT >= T.physics;
  // 체인 가운데 고리를 카메라가 늦게 따라가, 처지거나 흔들려도 화면 중심에 머물고 손으로 흔든 순간의 움직임은 살아 있다
  const follow = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  function trackChain(dt) {
    centroid.set(0, 0, 0);
    const mid = (N / 2) | 0;
    for (let i = mid - 1; i <= mid + 1; i++) centroid.add(links[i].position);
    centroid.divideScalar(3);
    centroid.z = 0;
    if (!physicsOn()) follow.copy(centroid);
    else follow.lerp(centroid, 1 - Math.exp(-dt / 1.1));
  }
  // 그리는 동안: 첫 고리를 정면에서 마주 보는 자세 — 고리 평면이 화면과 평행해 펜 외곽선과 3D 외곽선이 정확히 겹친다
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camUp = new THREE.Vector3();
  const bPos = new THREE.Vector3(), bLook = new THREE.Vector3(), bUp = new THREE.Vector3();
  function buildPose() {
    const hero = links[MID].position;
    const visH = portrait ? 4.2 : 2.7;
    const dist = visH / (2 * tanHalf);
    bLook.set(hero.x, hero.y, hero.z);
    bPos.set(hero.x, hero.y, hero.z + dist);
    const roll = portrait ? -0.35 : -0.9;
    bUp.set(Math.sin(roll), Math.cos(roll), 0);
  }
  function placeCamera() {
    normalPose();
    const k = smooth(span01(buildT, T.camera));
    if (k < 1) {
      buildPose();
      camPos.lerpVectors(bPos, camPos, k);
      camLook.lerpVectors(bLook, camLook, k);
      camUp.lerpVectors(bUp, camUp, k).normalize();
    }
    camera.position.copy(camPos);
    camera.up.copy(camUp);
    camera.lookAt(camLook);
    camera.updateMatrixWorld();
    const fade = clamp01((performance.now() - introStart) / 500);
    const o = ((portrait ? 0.32 : 1) * fade).toFixed(3);
    canvas.style.opacity = o;
    penSvg.style.opacity = o;
  }
  // 다 만든 뒤: 처음엔 고리 2~3개 클로즈업, 제목이 올라오는 동안 오른쪽으로 물러나며 조금 멀어진다
  function normalPose() {
    const p = smooth(clamp01((progress() - 0.3) / 0.55));
    const visH = portrait ? lerp(3.2, 5.6, p) : lerp(2.5, 4.0, p);
    const dist = visH / (2 * tanHalf);
    const ndcX = portrait ? lerp(0, 0.42, p) : lerp(0.04, 0.66, p);
    // 제목이 들어서는 동안 화면을 기울여, 오른쪽에서 체인이 더 세로로 서 제목을 가로지르지 않게 한다
    const roll = portrait ? 0 : lerp(0, -0.6, p);
    camUp.set(Math.sin(roll), Math.cos(roll), 0);
    const halfW = (visH / 2) * camera.aspect;
    const yaw = lerp(-0.22, 0.12, p);
    // 화면 기준 오른쪽·위쪽(롤로 기울어진 축)으로 비켜야 기울기와 상관없이 의도한 자리에 놓인다
    const rx = Math.cos(roll), ry = -Math.sin(roll), ux = Math.sin(roll), uy = Math.cos(roll);
    const shiftR = -ndcX * halfW, shiftU = lerp(0.32, -0.15, p);
    const lx = follow.x + rx * shiftR + ux * shiftU, ly = follow.y + ry * shiftR + uy * shiftU;
    camPos.set(lx + Math.sin(yaw) * dist, ly, Math.cos(yaw) * dist);
    camLook.set(lx, ly, 0);
  }

  // ----- 펜툴 레이어 -----
  // 첫 고리의 바깥·안쪽 외곽선(스타디움)을 피그마 펜툴과 같은 베지어 구조로 만들어, 고리 좌표에서 화면으로 투영해 그린다
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const penSvg = document.createElementNS(SVG_NS, 'svg');
  penSvg.setAttribute('class', 'pen-layer');
  penSvg.setAttribute('aria-hidden', 'true');
  canvas.after(penSvg);
  const KAPPA = 0.5523;
  function contour(r) {
    const h = S / 2, k = KAPPA * r, q = (Math.PI * r) / 2;
    const anchors = [[r, -h], [r, h], [0, h + r], [-r, h], [-r, -h], [0, -h - r]];
    // 구간 i는 앵커 i → i+1, 곡선 구간은 [c1, c2]
    const segs = [null, [[r, h + k], [k, h + r]], [[-k, h + r], [-r, h + k]], null, [[-r, -h - k], [-k, -h - r]], [[k, -h - r], [r, -h - k]]];
    const lens = [S, q, q, S, q, q];
    const total = lens.reduce((a, b) => a + b, 0);
    let acc = 0;
    const at = lens.map((l) => { const v = acc / total; acc += l; return v; });
    return { anchors, segs, at };
  }
  const contours = [contour(A + R), contour(A - R)];
  const el = (tag, attrs, parent = penSvg) => { const e = document.createElementNS(SVG_NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.appendChild(e); return e; };
  const penParts = contours.map((c) => {
    const path = el('path', { class: 'pen-path' });
    const nodes = c.anchors.map(() => {
      const g = el('g', { class: 'pen-handle' });
      const lines = [el('line', {}, g), el('line', {}, g)];
      const knobs = [el('rect', { width: 7, height: 7 }, g), el('rect', { width: 7, height: 7 }, g)];
      const dot = el('circle', { class: 'pen-anchor', r: 4.5 }, g);
      return { g, lines, knobs, dot };
    });
    return { c, path, nodes };
  });
  const cursor = el('g', {});
  const nib = el('g', { transform: 'rotate(40) scale(1.7)' }, cursor);
  el('path', { class: 'pen-nib', d: 'M0 0 L-6.5 -11 L-6.5 -17 L6.5 -17 L6.5 -11 Z' }, nib);
  el('path', { class: 'pen-nib', d: 'M-5.5 -20.5 H5.5 V-23.5 H-5.5 Z' }, nib);
  el('line', { class: 'pen-nib-slit', x1: 0, y1: -1.5, x2: 0, y2: -8 }, nib);
  el('circle', { class: 'pen-nib', r: 2, cy: -9.5 }, nib);

  const pv = new CANNON.Vec3(), pw3 = new CANNON.Vec3(), pt3 = new THREE.Vector3();
  function toScreen([x, y]) {
    pv.set(x, y, 0);
    links[MID].pointToWorldFrame(pv, pw3);
    pt3.set(pw3.x, pw3.y, pw3.z).project(camera);
    return [(pt3.x + 1) * 0.5 * W, (1 - pt3.y) * 0.5 * H];
  }
  const fmt = ([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`;
  function pathD({ anchors, segs }) {
    const s = anchors.map(toScreen);
    let d = `M${fmt(s[0])}`;
    for (let i = 0; i < 6; i++) {
      const to = s[(i + 1) % 6];
      d += segs[i] ? ` C${fmt(toScreen(segs[i][0]))} ${fmt(toScreen(segs[i][1]))} ${fmt(to)}` : ` L${fmt(to)}`;
    }
    return { d: d + ' Z', s };
  }
  function setHandle(node, side, from, ctl, on) {
    const line = node.lines[side], knob = node.knobs[side];
    if (!on || !ctl) { line.style.display = knob.style.display = 'none'; return; }
    const [cx, cy] = toScreen(ctl);
    line.style.display = knob.style.display = '';
    line.setAttribute('x1', from[0]); line.setAttribute('y1', from[1]);
    line.setAttribute('x2', cx); line.setAttribute('y2', cy);
    knob.setAttribute('transform', `translate(${cx} ${cy}) rotate(45) translate(-3.5 -3.5)`);
  }
  // 그리는 진행도 f(0→1)에 맞춰 선을 늘리고, 지나간 앵커를 찍고, 방금 찍은 앵커의 핸들을 펼친다
  function drawContour(part, f, anchorsOn) {
    const { d, s } = pathD(part.c);
    part.path.setAttribute('d', d);
    const L = part.path.getTotalLength();
    part.path.style.strokeDasharray = `${L} ${L}`;
    part.path.style.strokeDashoffset = String(L * (1 - f));
    part.path.style.display = f > 0 ? '' : 'none';
    let last = -1;
    part.c.at.forEach((a, i) => { if (f > 0 && f >= a) last = i; });
    part.nodes.forEach((node, i) => {
      const shown = anchorsOn && f > 0 && f >= part.c.at[i];
      node.g.style.display = shown ? '' : 'none';
      if (!shown) return;
      node.dot.setAttribute('cx', s[i][0]); node.dot.setAttribute('cy', s[i][1]);
      const active = i === last && f < 1;
      const inCtl = part.c.segs[(i + 5) % 6] && part.c.segs[(i + 5) % 6][1];
      const outCtl = part.c.segs[i] && part.c.segs[i][0];
      setHandle(node, 0, s[i], inCtl, active);
      setHandle(node, 1, s[i], outCtl, active);
    });
    return L;
  }
  function updatePen() {
    if (buildT >= T.lineFade[1]) { penSvg.style.display = 'none'; return; }
    penSvg.style.display = '';
    penSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const fo = smooth(span01(buildT, T.outer)), fi = smooth(span01(buildT, T.inner));
    const anchorsOn = buildT < T.hatch[0] + 0.04;
    const Lo = drawContour(penParts[0], fo, anchorsOn);
    const Li = drawContour(penParts[1], fi, anchorsOn);
    penParts.forEach((p) => { p.path.style.opacity = String(1 - span01(buildT, T.lineFade)); });
    // 펜 커서: 바깥선 끝 → 안쪽 시작점으로 건너뛰기 → 안쪽선 끝, 다 그리면 사라진다
    let pt;
    if (buildT < T.hop[0]) pt = penParts[0].path.getPointAtLength(Lo * fo);
    else if (buildT < T.hop[1]) {
      const a = penParts[0].path.getPointAtLength(Lo), b = toScreen(contours[1].anchors[0]);
      const h = smooth(span01(buildT, T.hop));
      pt = { x: lerp(a.x, b[0], h), y: lerp(a.y, b[1], h) - Math.sin(h * Math.PI) * 24 };
    } else pt = penParts[1].path.getPointAtLength(Li * fi);
    cursor.setAttribute('transform', `translate(${pt.x.toFixed(2)} ${pt.y.toFixed(2)})`);
    const cIn = span01(buildT, [0, T.outer[0]]), cOut = 1 - span01(buildT, [T.inner[1], T.inner[1] + 0.04]);
    cursor.style.opacity = String(Math.min(cIn, cOut));
  }
  function updateMorph() {
    morph.uHatch.value = span01(buildT, T.hatch) * 1.001;
    morph.uChrome.value = smooth(span01(buildT, T.chrome)) * 1.04;
    morph.uInflate.value = smooth(span01(buildT, T.inflate));
    morph.uWave.value = span01(buildT, T.wave);
  }
  // 시간이 흐르면 저절로, 스크롤하면 앞당겨 진행 — 한 번 만든 철은 되돌아가지 않고, 크게 건너뛰어도 1.2초 이상에 걸쳐 따라간다
  let buildFrozen = false;
  function advanceBuild(dt) {
    if (buildT >= 1 || buildFrozen) return;
    const byTime = (performance.now() - introStart) / BUILD_MS;
    const pinned = document.documentElement.classList.contains('hero-pinned');
    const byScroll = pinned ? progress() / 0.3 : 0;
    const target = Math.min(1, Math.max(byTime, byScroll));
    if (target > buildT) buildT = Math.min(target, buildT + dt / 1.2);
  }

  // ----- 입력 -----
  const raycaster = new THREE.Raycaster();
  const ndcPt = new THREE.Vector2();
  const facePlane = new THREE.Plane();
  const dragPlane = new THREE.Plane();
  const hitPt = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  let pointerTarget = null, lastMove = 0, pointerActive = false, pointerOverUi = false;
  let drag = null, hoverDirty = false, hovering = false, visible = true;
  const interactive = (el) => el && el.closest && el.closest('a, button, input, textarea, select, label, [role="button"]');

  function setRay(e) {
    const r = canvas.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return false;
    ndcPt.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndcPt, camera);
    return true;
  }
  function hitLink() {
    mesh.computeBoundingSphere();
    const hit = raycaster.intersectObject(mesh, false)[0];
    return hit && hit.instanceId !== undefined ? hit : null;
  }

  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !visible) return;
    const inside = setRay(e);
    pointerOverUi = !!interactive(e.target);
    if (drag) {
      if (inside && raycaster.ray.intersectPlane(dragPlane, hitPt)) drag.target.copy(hitPt);
      return;
    }
    if (!inside) { pointerActive = false; return; }
    facePlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmpV).negate(), new THREE.Vector3());
    if (raycaster.ray.intersectPlane(facePlane, hitPt)) {
      if (!pointerActive) { pointer.position.set(hitPt.x, hitPt.y, hitPt.z); pointer.velocity.setZero(); }
      pointerTarget = hitPt.clone();
      pointerActive = true;
      lastMove = performance.now();
    }
    hoverDirty = true;
  }, { passive: true });

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !visible || !physicsOn() || interactive(e.target) || !setRay(e)) return;
    const hit = hitLink();
    if (!hit) return;
    const body = links[hit.instanceId];
    const at = new CANNON.Vec3(hit.point.x, hit.point.y, hit.point.z);
    if (e.pointerType === 'touch') {
      body.applyImpulse(new CANNON.Vec3(perp.x * 9 * (Math.random() < 0.5 ? -1 : 1), perp.y * 9, (Math.random() - 0.5) * 8), at);
      return;
    }
    e.preventDefault();
    dragBody.position.copy(at);
    dragBody.velocity.setZero();
    const c = new CANNON.PointToPointConstraint(body, body.pointToLocalFrame(at), dragBody, new CANNON.Vec3(), DRAG_FORCE);
    world.addConstraint(c);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmpV).negate(), hit.point);
    drag = { c, target: hit.point.clone() };
    pointerActive = false;
    pointer.position.set(0, 99, 0);
    document.documentElement.classList.add('chain-grabbing');
  });

  function release() {
    if (!drag) return;
    world.removeConstraint(drag.c);
    dragBody.position.set(0, 99, 0);
    drag = null;
    document.documentElement.classList.remove('chain-grabbing');
  }
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  addEventListener('blur', release);

  let lastScroll = scrollY;
  addEventListener('scroll', () => {
    const dy = scrollY - lastScroll;
    lastScroll = scrollY;
    needsRender = true;
    if (reduceMotion || !visible || !physicsOn()) return;
    const k = Math.min(Math.abs(dy), 60) * 0.015 * (Math.random() - 0.5) * 2;
    const b = links[(Math.random() * N) | 0];
    b.applyImpulse(new CANNON.Vec3(perp.x * k, perp.y * k, (Math.random() - 0.5) * Math.abs(k)), b.position);
  }, { passive: true });
  addEventListener('resize', layout);
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (!visible) release(); }).observe(canvas);

  // ----- 시뮬레이션 -----
  const pw = new CANNON.Vec3(), cw = new CANNON.Vec3();
  // 이웃 고리 사이의 상대 회전을 '비틀림(긴 축)'과 '꺾임'으로 나눠, 맞물린 철사가 허락하는 범위 밖이면 경계로 되돌린다
  const Y = new THREE.Vector3(0, 1, 0);
  const qRel0 = new THREE.Quaternion().setFromAxisAngle(Y, Math.PI / 2);
  const qRel0Inv = qRel0.clone().invert();
  const qp = new THREE.Quaternion(), qc = new THREE.Quaternion(), dev = new THREE.Quaternion();
  const tw = new THREE.Quaternion(), sw = new THREE.Quaternion(), tgt = new THREE.Quaternion();
  const delta = new THREE.Quaternion(), part = new THREE.Quaternion(), jointFrame = new THREE.Quaternion();
  const axis = new THREE.Vector3();
  const limits = { twist: 0, swing: 0 };
  function wrapHalf(a) { return a > Math.PI / 2 ? a - Math.PI : a < -Math.PI / 2 ? a + Math.PI : a; }
  function removeSpin(pb, cb, wp, wc, n, outward) {
    const rel = (cb.angularVelocity.x - pb.angularVelocity.x) * n.x + (cb.angularVelocity.y - pb.angularVelocity.y) * n.y + (cb.angularVelocity.z - pb.angularVelocity.z) * n.z;
    if (rel * outward <= 0) return;
    cb.angularVelocity.x -= n.x * rel * wc; cb.angularVelocity.y -= n.y * rel * wc; cb.angularVelocity.z -= n.z * rel * wc;
    pb.angularVelocity.x += n.x * rel * wp; pb.angularVelocity.y += n.y * rel * wp; pb.angularVelocity.z += n.z * rel * wp;
  }
  function limitJoint(pb, cb, wp, wc) {
    qp.set(pb.quaternion.x, pb.quaternion.y, pb.quaternion.z, pb.quaternion.w);
    qc.set(cb.quaternion.x, cb.quaternion.y, cb.quaternion.z, cb.quaternion.w);
    // 이상적인 맞물림(긴 축으로 90° 엇갈림)에서 얼마나 벗어났는지
    dev.copy(qp).invert().multiply(qc).premultiply(qRel0Inv);
    const tl = Math.hypot(dev.y, dev.w);
    if (tl < 1e-6) return;
    const phi = 2 * Math.atan2(dev.y, dev.w);
    tw.set(0, dev.y / tl, 0, dev.w / tl);
    sw.copy(dev).multiply(tw.clone().invert());
    if (sw.w < 0) sw.set(-sw.x, -sw.y, -sw.z, -sw.w);
    // 고리는 긴 축으로 180° 돌리면 같은 모양이라, 비틀림은 ±90° 범위로 접어서 잰다
    const phiW = wrapHalf(((phi + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI);
    const theta = 2 * Math.acos(Math.min(1, sw.w));
    limits.twist = Math.max(limits.twist, Math.abs(phiW));
    limits.swing = Math.max(limits.swing, theta);
    const overT = Math.abs(phiW) > TWIST_MAX, overS = theta > SWING_MAX;
    if (!overT && !overS) return;
    jointFrame.copy(qp).multiply(qRel0);
    if (overT) {
      tw.setFromAxisAngle(Y, phi - phiW + Math.sign(phiW) * TWIST_MAX);
      axis.copy(Y).applyQuaternion(jointFrame);
      removeSpin(pb, cb, wp, wc, axis, Math.sign(phiW));
    }
    if (overS) {
      axis.set(sw.x, sw.y, sw.z).normalize();
      sw.setFromAxisAngle(axis, SWING_MAX);
      axis.applyQuaternion(jointFrame);
      removeSpin(pb, cb, wp, wc, axis, 1);
    }
    tgt.copy(qp).multiply(qRel0).multiply(sw).multiply(tw);
    delta.copy(tgt).multiply(qc.clone().invert());
    if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
    if (wc > 0) { part.identity().slerp(delta, wc).multiply(qc); cb.quaternion.set(part.x, part.y, part.z, part.w); }
    if (wp > 0) { part.identity().slerp(delta.clone().invert(), wp).multiply(qp); pb.quaternion.set(part.x, part.y, part.z, part.w); }
  }
  function limitTwist() {
    for (let j = 0; j <= N; j++) {
      const pb = j === 0 ? anchorA : links[j - 1];
      const cb = j === N ? anchorB : links[j];
      limitJoint(pb, cb, j === 0 ? 0 : j === N ? 1 : 0.5, j === 0 ? 1 : j === N ? 0 : 0.5);
    }
  }

  function keepConnected() {
    // 구속이 강한 힘에 밀려 벌어져도 양 끝에서 번갈아 다시 붙여, 클로즈업에서도 틈이 보이지 않게 한다
    // 앞 4번은 회전 제한과 번갈아, 뒤 4번은 위치만 다시 맞춰 마지막에 틈이 남지 않게 한다
    for (let pass = 0; pass < 20; pass++) {
      if (pass < 4) limitTwist();
      for (let j = 0; j <= N; j++) {
        if (j === 0) pw.copy(anchorA.position); else links[j - 1].pointToWorldFrame(PIV_BOTTOM, pw);
        if (j === N) cw.copy(anchorB.position); else links[j].pointToWorldFrame(PIV_TOP, cw);
        const dx = pw.x - cw.x, dy = pw.y - cw.y, dz = pw.z - cw.z;
        if (dx * dx + dy * dy + dz * dz < 1e-6) continue;
        const parentFixed = j === 0, childFixed = j === N;
        const wp = parentFixed ? 0 : childFixed ? 1 : 0.5;
        const wc = 1 - wp;
        if (!parentFixed) { const b = links[j - 1].position; b.x -= dx * wp; b.y -= dy * wp; b.z -= dz * wp; }
        if (!childFixed) { const b = links[j].position; b.x += dx * wc; b.y += dy * wc; b.z += dz * wc; }
      }
    }
  }

  function steer(body, target, dt) {
    body.velocity.set((target.x - body.position.x) / dt, (target.y - body.position.y) / dt, (target.z - body.position.z) / dt);
  }

  // 손대지 않아도 양 끝이 천천히 엇갈려 움직여 체인이 계속 살아 있는 것처럼 출렁인다
  const tA = new CANNON.Vec3(), tB = new CANNON.Vec3();
  let clock = 0;
  function simulate(dt) {
    clock += dt;
    const swayA = Math.sin(clock * 0.7) * 0.22, swayB = Math.sin(clock * 0.53 + 2) * 0.22;
    tA.set(baseA.x + perp.x * swayA, baseA.y + perp.y * swayA, Math.sin(clock * 0.41) * 0.25);
    tB.set(baseB.x + perp.x * swayB, baseB.y + perp.y * swayB, Math.cos(clock * 0.37) * 0.25);
    steer(anchorA, tA, dt);
    steer(anchorB, tB, dt);
    if (drag) steer(dragBody, drag.target, dt);
    if (pointerActive && !drag) {
      if (performance.now() - lastMove > 120) pointer.velocity.setZero();
      else steer(pointer, pointerTarget, dt);
    }
    world.step(1 / 120, dt, 6);
    keepConnected();
  }

  const dummy = new THREE.Object3D();
  function sync() {
    for (let i = 0; i < links.length; i++) {
      const b = links[i];
      dummy.position.set(b.position.x, b.position.y, b.position.z);
      dummy.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  let needsRender = true, last = performance.now(), frame = 0;
  layout();
  if (/chaindebug/.test(location.search)) window.__chain = { get links() { return links; }, limits, simulate, perp, anchorA, anchorB, setBuild: (v) => { buildT = v; buildFrozen = v !== null; }, get buildT() { return buildT; }, morph, snap: () => { renderer.render(scene, camera); return canvas.toDataURL(); } };
  if (reduceMotion) {
    for (let i = 0; i < 360; i++) simulate(1 / 120);
  } else {
    links.forEach((b, i) => { const s = Math.sin((i / N) * Math.PI) * 3; b.velocity.set(-perp.x * s, -perp.y * s, 1.5); });
  }
  sync();

  function loop(now) {
    requestAnimationFrame(loop);
    const elapsed = (now - last) / 1000;
    const dt = Math.min(elapsed, 1 / 30);
    last = now;
    if (document.hidden || !visible) return;
    advanceBuild(elapsed);
    if (!reduceMotion) {
      if (physicsOn()) simulate(dt);
      sync();
      needsRender = true;
    }
    updateMorph();
    trackChain(reduceMotion ? 10 : elapsed);
    placeCamera();
    updatePen();
    if (hoverDirty && !drag && physicsOn() && ++frame % 3 === 0) {
      hoverDirty = false;
      const over = !pointerOverUi && !!hitLink();
      if (over !== hovering) { hovering = over; document.documentElement.classList.toggle('chain-hover', over); }
    }
    if (needsRender) { renderer.render(scene, camera); needsRender = false; }
  }
  requestAnimationFrame(loop);
}
