import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { MeshBVH, MeshBVHUniformStruct, shaderStructs, shaderIntersectFunction } from 'three-mesh-bvh';

// 고리 하나의 형태: 가로 a(반원 반지름), 직선부 s, 철사 두께 r — 피치(고리 간 거리)는 안쪽 길이와 같다
const A = 0.42, S = 0.72, R = 0.175;
const PITCH = S + 2 * A - 2 * R;
const HALF = PITCH / 2;
const N = 9;
const MID = (N / 2) | 0; // 펜으로 그려지는 첫 고리 — 짝수 번째라 카메라를 정면으로 마주한다
// 그림 → 철 과정의 타임라인(buildT 0→1). 기다리면 저절로 진행되고, 스크롤하면 앞당겨진다
const BUILD_MS = 6200;
const T = {
  outer: [0.03, 0.30], hop: [0.30, 0.34], inner: [0.34, 0.50],
  hatch: [0.50, 0.66],
  // 빗금이 다 채워지면 고리 전체가 빛을 머금었다가(glowIn) 번쩍인 뒤 빛이 걷히며(glowOut) 실물이 한 번에 드러난다
  glowIn: [0.645, 0.695], glowOut: [0.70, 0.775], chrome: [0.685, 0.72], inflate: [0.675, 0.72],
  lineFade: [0.66, 0.72], wave: [0.80, 1.0], camera: [0.78, 1.0], physics: 0.80,
  set: [0.715, 0.75], // 가운데 고리의 다이아몬드·발이 한꺼번에 박히는 구간
};
// 무게감: 고리 하나가 약 1.9 단위 — 실제 크기로 치면 중력이 훨씬 세야 '무거운 쇠'로 보인다(약하면 달 위처럼 둥실 뜬다).
// 그래서 중력을 크게 두어 놓으면 툭 떨어지고 축 늘어지며, 질량도 커서 쳐도 조금만 밀리고 금방 제자리로 쳐진다
const SLACK = 0.02;
const FOV = 30;
const GRAVITY = -45;
const LINK_MASS = 50;
const DRAG_FORCE = 2500; // 잡아당기는 힘의 상한 — 고리 무게(50×45)와 비슷해 버티듯 느리게 딸려 온다
const DRAG_REACH = 0.4; // 끌어서 옮길 수 있는 최대 거리(고리 길이의 약 1/5)
const NUDGE = 0.05; // 마우스가 훑을 때 고리에 전해지는 속도 비율(5%)
const NUDGE_MAX_SPEED = 4; // 마우스를 휙 지나가도 이 속도 이상은 전하지 않는다
const IMPULSE = 2.5; // 탭·스크롤로 주는 힘의 배율 — 질량이 10배라 실제로는 전보다 훨씬 덜 움직인다
const LINK = 1, POINTER = 2;
// 맞물린 고리는 이웃에 대해 마음대로 돌 수 없다 — 철사 굵기(2R)와 구멍 폭(2(A-R))이 허락하는 만큼만 비틀리고 꺾인다
// 비틀림: 0.175/cosφ + 0.175·tanφ ≤ 0.245 를 풀면 약 19°, 꺾임: 반원 안쪽을 미끄러져 직선부에 닿기 전까지
const TWIST_MAX = THREE.MathUtils.degToRad(18);
const SWING_MAX = THREE.MathUtils.degToRad(62);
const LOOP = 2 * S + 2 * Math.PI * A; // 고리 중심선 한 바퀴 길이
// 가운데 고리: 플래티넘(로듐 도금) 고리에 라운드 브릴리언트 컷 다이아몬드를 촘촘히 박은 파베 세팅.
// 기둥(열) 수, 돌 반지름, 같은 열 안 돌 간격, 고리 안쪽(구멍 쪽)에서 비워 두는 각도(이웃 고리가 지나가는 자리)
const PAVE_COLS = 10, STONE_R = 0.046, STONE_GAP = 0.101, PAVE_SKIP = 0.6;

const canvas = document.getElementById('chain-canvas');
const pin = document.getElementById('hero-pin');
if (canvas && pin) init();

function stadiumCurve() {
  const curve = new THREE.Curve();
  const total = LOOP;
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
  return curve;
}

function stadium() {
  return new THREE.TubeGeometry(stadiumCurve(), 120, R, 28, true);
}

// 라운드 브릴리언트 컷(57면에 가까운 실제 컷 구조) — 거들 반지름 1, 돌의 위쪽이 +Y.
// 테이블(8각) · 스타 8 · 베젤(카이트) 8 · 상부 거들 16 · 거들 띠 · 하부 거들 16 · 파빌리온 메인 8 → 큘릿.
// 비율은 이상적 컷(Tolkowsky)에 가깝게: 테이블 56%, 크라운 높이 16%, 파빌리온 깊이 43%
function brilliantGeometry() {
  const TABLE = 0.56, CROWN = 0.16, PAV = 0.43, GIRD = 0.015, STAR_R = 0.78, LOWER_R = 0.45;
  const crownY = (r) => GIRD + CROWN * (1 - r) / (1 - TABLE);
  const pavY = (r) => -GIRD - PAV * (1 - r);
  const pt = (r, a, y) => [r * Math.cos(a), y, r * Math.sin(a)];
  const T = [], Sx = [], G = [], Gb = [], L = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    T.push(pt(TABLE, a, GIRD + CROWN));
    Sx.push(pt(STAR_R, a + Math.PI / 8, crownY(STAR_R)));
    L.push(pt(LOWER_R, a + Math.PI / 8, pavY(LOWER_R)));
  }
  for (let j = 0; j < 16; j++) {
    const a = (j * Math.PI) / 8;
    G.push(pt(1, a, GIRD));
    Gb.push(pt(1, a, -GIRD));
  }
  const top = [0, GIRD + CROWN, 0], culet = [0, -GIRD - PAV, 0];
  const tris = [];
  const w = (i, n) => (i + n) % n;
  for (let k = 0; k < 8; k++) {
    const k1 = w(k + 1, 8), km = w(k - 1, 8), g0 = 2 * k, g1 = w(2 * k + 1, 16), g2 = w(2 * k + 2, 16);
    tris.push([top, T[k], T[k1]]); // 테이블
    tris.push([T[k], Sx[k], T[k1]]); // 스타
    tris.push([T[k], Sx[km], G[g0]], [T[k], G[g0], Sx[k]]); // 베젤(카이트)
    tris.push([Sx[k], G[g0], G[g1]], [Sx[k], G[g1], G[g2]]); // 상부 거들
    tris.push([Gb[g0], Gb[g1], L[k]], [Gb[g1], Gb[g2], L[k]]); // 하부 거들
    tris.push([Gb[g2], culet, L[k]], [culet, Gb[g0], L[k]]); // 파빌리온 메인
  }
  for (let j = 0; j < 16; j++) {
    const j1 = w(j + 1, 16);
    tris.push([G[j], Gb[j], Gb[j1]], [G[j], Gb[j1], G[j1]]); // 거들 띠
  }
  const pos = [];
  const v = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), c = new THREE.Vector3();
  for (const [a, b, d] of tris) {
    // 모든 면이 바깥을 보도록 감는 방향을 맞춘다(볼록한 돌이라 면 중심과 법선이 같은 쪽이면 바깥)
    e1.fromArray(b).sub(v.fromArray(a));
    e2.fromArray(d).sub(v.fromArray(a));
    c.fromArray(a).add(v.fromArray(b)).add(v.fromArray(d));
    if (e1.cross(e2).dot(c) < 0) pos.push(...a, ...d, ...b); else pos.push(...a, ...b, ...d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // 면마다 고정된 난수(반짝임 주기·반짝이는 면 여부)
  const tri = pos.length / 9, facet = new Float32Array(tri * 9);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < tri; t++) {
    const a = rnd(), b = rnd(), d = rnd();
    for (let k = 0; k < 3; k++) facet.set([a, b, d], (t * 3 + k) * 3);
  }
  geo.setAttribute('aFacet', new THREE.BufferAttribute(facet, 3));
  return geo;
}

// 파베 배치: 철사 둘레를 여러 열로 나눠, 열마다 그 열이 지나는 실제 길이를 따라 돌을 같은 간격으로 놓는다
// (반원 안쪽 열은 길이가 짧아 돌이 적게, 바깥 열은 많이 들어가 겹치지 않는다). 돌 사이마다 고정용 발(구슬)을 둔다
function paveLayout() {
  const curve = stadiumCurve();
  const NF = 800;
  // 고리는 xy 평면 위를 반시계로 도는 곡선 — 법선은 '고리 안쪽(구멍)', 종법선은 z(정면)로 직접 잡는다
  const P = [], tangents = [], normals = [], binormals = [];
  const Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i <= NF; i++) {
    P.push(curve.getPointAt(i / NF));
    const t = curve.getTangentAt(i / NF);
    tangents.push(t);
    normals.push(new THREE.Vector3().crossVectors(Z, t).normalize());
    binormals.push(Z);
  }
  const span = 2 * Math.PI - 2 * PAVE_SKIP, step = span / (PAVE_COLS - 1);
  const dirAt = (i, th, out) => out.copy(normals[i % NF]).multiplyScalar(Math.cos(th)).addScaledVector(binormals[i % NF], Math.sin(th));
  const stones = [], beads = [];
  const d = new THREE.Vector3(), x = new THREE.Vector3(), z = new THREE.Vector3(), p = new THREE.Vector3(), m = new THREE.Matrix4();
  for (let j = 0; j < PAVE_COLS; j++) {
    const th = PAVE_SKIP + j * step;
    const len = [0];
    const q = new THREE.Vector3(), q0 = new THREE.Vector3();
    for (let i = 1; i <= NF; i++) {
      q0.copy(P[i - 1]).addScaledVector(dirAt(i - 1, th, d), R);
      q.copy(P[i]).addScaledVector(dirAt(i, th, d), R);
      len.push(len[i - 1] + q.distanceTo(q0));
    }
    const total = len[NF], n = Math.max(1, Math.floor(total / STONE_GAP)), gap = total / n;
    const indexAt = (s) => { let lo = 0, hi = NF; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (len[mid] < s) lo = mid; else hi = mid; } return lo; };
    for (let k = 0; k < n; k++) {
      const s = (k + (j % 2 ? 0.5 : 0)) * gap;
      const i = indexAt(s);
      dirAt(i, th, d).normalize();
      x.copy(tangents[i % NF]).addScaledVector(d, -tangents[i % NF].dot(d)).normalize();
      z.crossVectors(x, d);
      p.copy(P[i]).addScaledVector(d, R + STONE_R * 0.04);
      m.makeBasis(x, d, z).scale(new THREE.Vector3(STONE_R, STONE_R, STONE_R)).setPosition(p);
      stones.push({ m: m.clone(), u: i / NF });
      // 발: 이 돌과 옆 열 돌 사이(반 칸 옆, 반 간격 뒤)
      if (j < PAVE_COLS - 1) {
        const ib = indexAt((s + gap / 2) % total);
        const db = dirAt(ib, th + step / 2, new THREE.Vector3()).normalize();
        beads.push({ p: new THREE.Vector3().copy(P[ib]).addScaledVector(db, R + 0.004), u: ib / NF });
      }
    }
  }
  return { stones, beads };
}

// HDR을 웹용으로 가볍게: 보통 밝기(base, sRGB JPG)와 밝은 부분만 1/64로 줄여 담은 JPG(high) 두 장을 받아
// 브라우저에서 다시 HDR(반정밀 부동소수) 텍스처로 합친다 — 2K 기준 약 0.3MB(원본 .hdr은 6MB)
function loadHdrJpg(name, done) {
  const load = (k) => new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = new URL(`../assets/hdr/${name}_${k}.jpg`, import.meta.url).href;
  });
  Promise.all([load('base'), load('high')]).then(([b, h]) => {
    const W = b.width, H = b.height;
    const read = (im) => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.drawImage(im, 0, 0); return x.getImageData(0, 0, W, H).data; };
    const B = read(b), Hi = read(h);
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    const out = new Uint16Array(W * H * 4);
    const one = THREE.DataUtils.toHalfFloat(1);
    for (let y = 0; y < H; y++) {
      // 등장방형 텍스처는 v=1이 하늘 — 이미지 위쪽 줄을 텍스처 마지막 줄로 넣는다
      const row = (H - 1 - y) * W * 4, src = y * W * 4;
      for (let xx = 0; xx < W; xx++) {
        const o = row + xx * 4, s = src + xx * 4;
        for (let ch = 0; ch < 3; ch++) {
          const vb = B[s + ch];
          const v = vb < 250 ? lin[vb] : Math.max(lin[vb], lin[Hi[s + ch]] * 64);
          out[o + ch] = THREE.DataUtils.toHalfFloat(v);
        }
        out[o + 3] = one;
      }
    }
    const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.colorSpace = THREE.LinearSRGBColorSpace;
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    done(tex);
  });
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

  // 실사 환경 반사: Poly Haven 'studio_small_09'(CC0, 4K 원본을 2K로) — 팔각 소프트박스와 흰 호리존트가 있는 실제 사진 스튜디오.
  // 주얼리 촬영과 같은 조명이라 다이아몬드에 흰빛·검은 면의 대비가 또렷하게 생긴다.
  // 쇠·플래티넘은 이를 흐린 반사(PMREM)로, 다이아몬드는 원본을 광선 방향으로 직접 읽는다. 받는 동안은 위의 합성 스튜디오로 먼저 그린다
  const ENV_ROT = 0.6;
  loadHdrJpg('studio2k', (tex) => {
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = pm.fromEquirectangular(tex).texture;
    pm.dispose();
    stoneU.envMap.value = tex;
    needsRender = true;
  });
  scene.environmentRotation.set(0, ENV_ROT, 0);

  // 일반 고리: ambientCG 실사 PBR 세트 Metal024(CC0) — 색·거칠기·금속도·노멀 네 장을 모두 써서 쓸린 자국과 얼룩이 있는 진짜 쇠로 만든다
  const MET = 'metal024';
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 1, envMapIntensity: 1.0 });
  const texLoader = new THREE.TextureLoader();
  const maxAniso = renderer.capabilities.getMaxAnisotropy();
  const metalTex = (kind, apply) => texLoader.load(new URL(`../assets/tex/${MET}_${kind}.jpg`, import.meta.url).href, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4, 1); // 철사 길이 방향 4번, 둘레 1번 — 한 장이 약 1×1.1 단위로 거의 정사각형으로 붙는다
    t.anisotropy = maxAniso;
    apply(t);
    material.needsUpdate = true;
    needsRender = true;
  });
  metalTex('color', (t) => { t.colorSpace = THREE.SRGBColorSpace; material.map = t; });
  metalTex('roughness', (t) => { material.roughnessMap = t; });
  metalTex('metalness', (t) => { material.metalnessMap = t; });
  metalTex('normal', (t) => { material.normalMap = t; material.normalScale.set(1, 1); });

  // ----- 그림 → 철 전환 셰이더 -----
  // 펜이 그린 순서(철사 길이 방향 uv.x)를 따라 빗금이 채워지고, 같은 방향으로 납작한 평면이 둥근 철사로 부풀며 크롬이 된다.
  // 펜이 그린 가운데 고리(다이아몬드)는 uHatch·uChrome·uInflate를 그대로 따르고, 나머지 고리는 uWave에 맞춰 차례로 같은 과정을 빠르게 거친다
  // 가운데 고리(MID)는 따로 떼어 낸 메시라, 인스턴스는 나머지 고리만 담는다
  const OTHERS = [...Array(N).keys()].filter((i) => i !== MID);
  const geometry = stadium();
  const uvAttr = geometry.attributes.uv;
  const along = new Float32Array(uvAttr.count);
  for (let i = 0; i < uvAttr.count; i++) along[i] = uvAttr.getX(i);
  geometry.setAttribute('aU', new THREE.BufferAttribute(along, 1));
  const delays = new Float32Array(OTHERS.map((i) => Math.abs(i - MID) * 0.15));
  geometry.setAttribute('aDelay', new THREE.InstancedBufferAttribute(delays, 1));
  const morph = {
    uHatch: { value: 0 }, uChrome: { value: 0 }, uInflate: { value: 0 }, uWave: { value: 0 }, uSet: { value: 0 }, uGlow: { value: 0 },
    uPR: { value: 1 },
    uFill: { value: new THREE.Vector3(0x0e / 255, 0x12 / 255, 0x1a / 255) },
    uLine: { value: new THREE.Vector3(0x5a / 255, 0xa6 / 255, 0xff / 255) },
  };
  // hero=true: 가운데 고리 — 펜이 그린 그 고리라 uHatch·uChrome·uInflate를 그대로 따른다
  function patchMorph(sh, hero = false) {
    Object.assign(sh.uniforms, morph);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aU;
${hero ? '' : 'attribute float aDelay;'}
uniform float uHatch, uChrome, uInflate, uWave, uGlow;
varying float vU;
flat varying float vHatchP, vChromeP, vGlowP;`)
      .replace('#include <beginnormal_vertex>', `float inflateP;
${hero ? 'vHatchP = uHatch; vChromeP = uChrome; vGlowP = uGlow; inflateP = uInflate;' : `
float w = clamp((uWave - aDelay) / 0.4, 0.0, 1.0);
vHatchP = w > 0.0 ? 1.01 : -1.0;
// 나머지 고리도 각자 통째로 번쩍이며 바뀐다(물결처럼 차례로)
vGlowP = exp(-pow((w - 0.45) / 0.2, 2.0));
vChromeP = smoothstep(0.38, 0.62, w);
inflateP = smoothstep(0.33, 0.67, w);`}
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
flat varying float vHatchP, vChromeP, vGlowP;`)
      .replace('void main() {', `void main() {
  if (vHatchP <= 0.0 || vU >= vHatchP) discard;`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  // 실물(금속)은 위치와 상관없이 고리 전체가 한 번에 드러난다
  float chromeAmt = clamp(vChromeP, 0.0, 1.0);
  vec2 fc = gl_FragCoord.xy / uPR;
  float d = abs(fract((fc.x + fc.y) / 11.0) - 0.5) * 11.0;
  float line = 1.0 - smoothstep(0.7, 1.6, d);
  // 충전: 빗금선과 바탕이 점점 빛을 머금고 → 번쩍: 고리 전체가 흰 푸른빛에 잠겼다가 걷히면 실물이 남는다
  vec3 glowCol = vec3(0.62, 0.82, 1.0);
  vec3 flatCol = mix(uFill + glowCol * vGlowP * 0.3, uLine + glowCol * vGlowP * 1.1, line);
  float front = vHatchP < 1.0 ? exp(-abs(vU - vHatchP) * 160.0) : 0.0;
  // 번쩍임은 실물이 드러난 뒤엔 덜 덮어, 빛 속으로 금속 결이 비쳐 보이게 한다
  gl_FragColor.rgb = mix(flatCol, gl_FragColor.rgb, chromeAmt) + glowCol * (pow(vGlowP, 1.6) * mix(0.95, 0.45, chromeAmt) + front * 0.6);
  gl_FragColor.a = 1.0;`);
  }
  material.onBeforeCompile = (sh) => patchMorph(sh);

  const mesh = new THREE.InstancedMesh(geometry, material, OTHERS.length);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // ----- 가운데 고리: 파베 다이아몬드 주얼리 -----
  // 플래티넘(로듐 도금) 고리 + 라운드 브릴리언트 컷 다이아몬드 수백 알 + 돌을 잡는 발(구슬).
  // 고리는 다른 고리처럼 펜 인트로를 거치고(빗금 → 금속), 다이아몬드와 발은 그 뒤 펜이 그린 순서대로 박힌다
  const heroFx = { uTime: { value: 0 }, uEnergy: { value: 1 } };
  const heroGroup = new THREE.Group();
  scene.add(heroGroup);
  const platinum = { color: 0xe4e6eb, metalness: 1, roughness: 0.3, envMapIntensity: 1.1 };

  const tubeGeo = new THREE.TubeGeometry(stadiumCurve(), 360, R, 64, true);
  {
    const uv = tubeGeo.attributes.uv, au = new Float32Array(uv.count);
    for (let i = 0; i < uv.count; i++) au[i] = uv.getX(i);
    tubeGeo.setAttribute('aU', new THREE.BufferAttribute(au, 1));
  }
  const tubeMat = new THREE.MeshPhysicalMaterial(platinum);
  // 손때와 헤어라인 흠집: Metal009 거칠기 맵을 약하게 — 거울 같은 반사 속에 결이 살짝 비친다
  texLoader.load(new URL('../assets/tex/metal009_roughness.jpg', import.meta.url).href, (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(10, 1);
    t.anisotropy = maxAniso;
    tubeMat.roughnessMap = t;
    tubeMat.needsUpdate = true;
    needsRender = true;
  });
  tubeMat.onBeforeCompile = (sh) => patchMorph(sh, true);
  const heroTube = new THREE.Mesh(tubeGeo, tubeMat);
  heroTube.frustumCulled = false;
  heroGroup.add(heroTube);

  const { stones, beads } = paveLayout();
  // 다이아몬드: 픽셀마다 시선을 돌 속으로 굴절시킨 뒤, 실제 브릴리언트 컷 형상(BVH, three-mesh-bvh)에 부딪히며
  // 전반사로 최대 4번 튕기다 빠져나간 방향의 스튜디오 조명을 읽는다. 빨강·초록·파랑의 굴절률을 달리 추적해 무지개빛이 갈라진다
  // (@react-three/drei MeshRefractionMaterial과 같은 방식, MIT). 돌마다 행렬이 달라 인스턴스별로 광선을 돌 좌표로 옮긴다
  const stoneGeo = brilliantGeometry();
  const stoneBVH = new MeshBVH(stoneGeo);
  const bvhStruct = new MeshBVHUniformStruct();
  bvhStruct.updateFrom(stoneBVH);
  const stoneU = {
    envMap: { value: null },
    bvh: { value: bvhStruct },
    bounces: { value: 4 },
    ior: { value: 2.42 },
    aberrationStrength: { value: 0.018 },
    uExposure: { value: 1.3 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uEnvRot: { value: new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(-ENV_ROT)) },
  };
  // 휴대폰(터치 기기)은 GPU가 약해 내부 반사 횟수를 2번으로 줄인다 — 화면이 작아 차이는 거의 보이지 않는다
  if (matchMedia('(pointer: coarse)').matches) stoneU.bounces.value = 2;
  const stoneMat = new THREE.ShaderMaterial({
    uniforms: { ...stoneU, ...heroFx, uSet: morph.uSet, uInflate: morph.uInflate },
    vertexShader: /* glsl */ `
uniform float uInflate, uSet;
attribute vec3 aFacet;
attribute float aU, aSeed;
varying vec3 vWorldPosition, vNormal;
varying mat4 vM, vMinv;
flat varying vec3 vFacet;
flat varying float vSeed;
void main() {
  // 빛이 걷히며 고리가 실물이 되는 순간, 모든 돌이 한꺼번에 박힌다(uSet). 납작함(uInflate)도 고리와 똑같이 따른다
  float reveal = uSet;
  mat4 m = modelMatrix * instanceMatrix;
  vM = m;
  vMinv = inverse(m);
  vec4 lp = instanceMatrix * vec4(position * reveal, 1.0);
  lp.z *= max(uInflate, 0.03);
  vec4 wp = modelMatrix * lp;
  vWorldPosition = wp.xyz;
  vNormal = normalize(mat3(m) * normal);
  vFacet = aFacet;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`,
    fragmentShader: /* glsl */ `
precision highp isampler2D;
precision highp usampler2D;
varying vec3 vWorldPosition, vNormal;
varying mat4 vM, vMinv;
flat varying vec3 vFacet;
flat varying float vSeed;
uniform sampler2D envMap;
uniform float bounces, ior, aberrationStrength, uExposure;
${shaderStructs}
${shaderIntersectFunction}
uniform BVH bvh;
uniform mat3 uEnvRot;
uniform vec3 uTint;
uniform float uTime, uEnergy;

// 돌 속으로 굴절해 들어간 광선이 안쪽 면에 부딪힐 때마다, 빠져나갈 수 있으면 굴절해 나가고 아니면(전반사) 다시 튕긴다
vec3 totalInternalReflection(vec3 rd, vec3 normal, float eta) {
  vec3 rayDirection = refract(rd, normal, 1.0 / eta);
  vec3 rayOrigin = (vMinv * vec4(vWorldPosition + rayDirection * 0.0005, 1.0)).xyz;
  rayDirection = normalize((vMinv * vec4(rayDirection, 0.0)).xyz);
  for (float i = 0.0; i < bounces; i++) {
    uvec4 faceIndices = uvec4(0u);
    vec3 faceNormal = vec3(0.0, 0.0, 1.0);
    vec3 barycoord = vec3(0.0);
    float side = 1.0;
    float dist = 0.0;
    bvhIntersectFirstHit(bvh, rayOrigin, rayDirection, faceIndices, faceNormal, barycoord, side, dist);
    vec3 hitPos = rayOrigin + rayDirection * max(dist - 0.001, 0.0);
    vec3 tempDir = refract(rayDirection, faceNormal, eta);
    if (length(tempDir) != 0.0) { rayDirection = tempDir; break; }
    rayDirection = reflect(rayDirection, faceNormal);
    rayOrigin = hitPos + rayDirection * 0.01;
  }
  return normalize((vM * vec4(rayDirection, 0.0)).xyz);
}

#include <common>

// 굴절 방향은 면 경계에서 크게 튀므로, 밉맵 기울기는 매끈한 시선 방향으로 계산해 경계에 줄무늬가 생기지 않게 한다
vec3 sampleEnv(vec3 dir, vec3 smoothDir) {
  vec2 uvv = equirectUv(uEnvRot * dir);
  vec2 suv = equirectUv(uEnvRot * smoothDir);
  return textureGrad(envMap, uvv, dFdx(suv), dFdy(suv)).rgb;
}

void main() {
  vec3 normal = normalize(vNormal);
  vec3 rd = normalize(vWorldPosition - cameraPosition);
  if (dot(rd, normal) > 0.0) normal = -normal;
  vec3 dG = totalInternalReflection(rd, normal, ior);
  vec3 dR = totalInternalReflection(rd, normal, ior * (1.0 - aberrationStrength));
  vec3 dB = totalInternalReflection(rd, normal, ior * (1.0 + aberrationStrength));
  vec3 col = vec3(sampleEnv(dR, rd).r, sampleEnv(dG, rd).g, sampleEnv(dB, rd).b) * uExposure * uTint;
  // 겉면 반사(프레넬, 굴절률 2.42 → 정면에서도 17%)
  vec3 rf = reflect(rd, normal);
  float F = 0.172 + 0.828 * pow(1.0 - clamp(dot(-rd, normal), 0.0, 1.0), 5.0);
  col = mix(col, sampleEnv(rf, rd) * uExposure, F);
  // 반짝임: 일부 면이 돌마다 제각각 주기로 번쩍 — 올리면(uEnergy↑) 반짝이는 면이 늘고 세진다
  vec3 h = vFacet;
  float tw = pow(max(0.0, sin(uTime * (1.2 + h.y * 2.4) + h.x * 60.0 + vSeed * 37.0)), 40.0)
           * step(0.8 - 0.12 * (uEnergy - 1.0), fract(h.z + vSeed * 7.31));
  col += vec3(1.0, 0.97, 0.92) * tw * 3.0 * uEnergy;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const stoneMesh = new THREE.InstancedMesh(stoneGeo, stoneMat, stones.length);
  {
    const au = new Float32Array(stones.length), seed = new Float32Array(stones.length);
    stones.forEach((s, i) => { stoneMesh.setMatrixAt(i, s.m); au[i] = s.u; seed[i] = (i * 0.618034) % 1; });
    stoneGeo.setAttribute('aU', new THREE.InstancedBufferAttribute(au, 1));
    stoneGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seed, 1));
  }
  stoneMesh.frustumCulled = false;
  stoneMesh.raycast = () => {};
  heroGroup.add(stoneMesh);

  // 발(프롱): 돌 사이마다 작은 플래티넘 구슬 — 실제 파베 세팅처럼 돌을 눌러 잡는다
  const beadGeo = new THREE.SphereGeometry(0.014, 12, 8);
  beadGeo.setAttribute('aU', new THREE.InstancedBufferAttribute(new Float32Array(beads.map((b) => b.u)), 1));
  const beadMat = new THREE.MeshPhysicalMaterial({ ...platinum, roughness: 0.18 });
  beadMat.onBeforeCompile = (sh) => {
    sh.uniforms.uSet = morph.uSet;
    sh.uniforms.uInflate = morph.uInflate;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float aU;
uniform float uSet, uInflate;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed *= uSet;`)
      .replace('#include <project_vertex>', `vec4 mvPosition = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition.z *= max(uInflate, 0.03);
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`);
  };
  const beadMesh = new THREE.InstancedMesh(beadGeo, beadMat, beads.length);
  {
    const bm = new THREE.Matrix4();
    beads.forEach((b, i) => beadMesh.setMatrixAt(i, bm.makeTranslation(b.p.x, b.p.y, b.p.z)));
  }
  beadMesh.frustumCulled = false;
  beadMesh.raycast = () => {};
  heroGroup.add(beadMesh);
  let energyTarget = 1, heroHover = false, flash = 0, setFlashed = false;

  // ----- 물리: 양 끝을 화면 밖 대각선 위아래에 고정한 체인 -----
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, GRAVITY, 0) });
  world.solver.iterations = 30;
  world.defaultContactMaterial.restitution = 0.02;
  world.defaultContactMaterial.friction = 0.4;

  const PIV_TOP = new CANNON.Vec3(0, HALF, 0);
  const PIV_BOTTOM = new CANNON.Vec3(0, -HALF, 0);
  const ZERO = new CANNON.Vec3();
  const shape = new CANNON.Box(new CANNON.Vec3(A + R, S / 2 + A + R, R));
  const ghost = { collisionFilterGroup: 0, collisionFilterMask: 0 };
  const anchorA = new CANNON.Body({ type: CANNON.Body.KINEMATIC, ...ghost });
  const anchorB = new CANNON.Body({ type: CANNON.Body.KINEMATIC, ...ghost });
  world.addBody(anchorA);
  world.addBody(anchorB);
  const dragBody = new CANNON.Body({ type: CANNON.Body.KINEMATIC, position: new CANNON.Vec3(0, 99, 0), ...ghost });
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
        mass: LINK_MASS, shape,
        position: new CANNON.Vec3(baseA.x + dir.x * d, baseA.y + dir.y * d, 0),
        linearDamping: 0.3, angularDamping: 0.7,
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
    morph.uPR.value = renderer.getPixelRatio();    camera.aspect = W / H;
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
  // 인트로 시계: 실제 경과 시간이 아니라 '그려진 프레임'의 시간(프레임당 최대 1/30초)만 센다 —
  // 새로고침 직후 셰이더 컴파일·텍스처 업로드로 화면이 잠깐 멈춰도 그 사이 인트로가 건너뛰어 중간부터 보이지 않게 한다
  let introClock = 0;
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
    const fade = reduceMotion ? 1 : clamp01(introClock / 0.5);
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
    morph.uChrome.value = smooth(span01(buildT, T.chrome));
    morph.uGlow.value = smooth(span01(buildT, T.glowIn)) * (1 - smooth(span01(buildT, T.glowOut)));
    morph.uInflate.value = smooth(span01(buildT, T.inflate));
    morph.uWave.value = span01(buildT, T.wave);
    morph.uSet.value = smooth(span01(buildT, T.set));
  }
  // 시간이 흐르면 저절로, 스크롤하면 앞당겨 진행 — 한 번 만든 철은 되돌아가지 않고, 크게 건너뛰어도 1.2초 이상에 걸쳐 따라간다
  let buildFrozen = false;
  function advanceBuild(dt) {
    if (buildT >= 1 || buildFrozen) return;
    const byTime = (introClock * 1000) / BUILD_MS;
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
  let lastNudge = null, nudgeAt = 0, pointerOverUi = false;
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
    const hit = raycaster.intersectObjects([mesh, heroTube], false)[0];
    if (!hit) return null;
    if (hit.object === heroTube) hit.index = MID;
    else if (hit.instanceId !== undefined) hit.index = OTHERS[hit.instanceId];
    else return null;
    return hit;
  }

  addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || !visible) return;
    const inside = setRay(e);
    pointerOverUi = !!interactive(e.target);
    if (drag) {
      // 무거운 쇠는 끌어도 잡은 자리에서 조금만 딸려 온다 — 커서가 멀리 가도 당기는 목표는 DRAG_REACH 안에 머문다
      if (inside && raycaster.ray.intersectPlane(dragPlane, hitPt)) {
        drag.target.copy(hitPt).sub(drag.origin);
        if (drag.target.length() > DRAG_REACH) drag.target.setLength(DRAG_REACH);
        drag.target.add(drag.origin);
      }
      return;
    }
    if (!inside) { lastNudge = null; return; }
    hoverDirty = true;
    // 마우스가 고리 위를 훑고 지나가면 그 방향으로 아주 약하게만 툭 — 무거운 쇠라 손이 스쳐도 거의 꿈쩍하지 않는다
    const now = performance.now();
    if (!physicsOn() || now - nudgeAt < 40) return;
    facePlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmpV).negate(), new THREE.Vector3());
    if (!raycaster.ray.intersectPlane(facePlane, hitPt)) return;
    if (lastNudge) {
      const dtm = Math.max((now - nudgeAt) / 1000, 1 / 120);
      const hit = hitLink();
      if (hit) {
        const b = links[hit.index];
        let vx = (hitPt.x - lastNudge.x) / dtm, vy = (hitPt.y - lastNudge.y) / dtm, vz = (hitPt.z - lastNudge.z) / dtm;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > NUDGE_MAX_SPEED) { const s = NUDGE_MAX_SPEED / sp; vx *= s; vy *= s; vz *= s; }
        const k = LINK_MASS * NUDGE;
        b.applyImpulse(new CANNON.Vec3(vx * k, vy * k, vz * k), new CANNON.Vec3(hit.point.x, hit.point.y, hit.point.z));
      }
    }
    lastNudge = (lastNudge || new THREE.Vector3()).copy(hitPt);
    nudgeAt = now;
  }, { passive: true });

  addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !visible || !physicsOn() || interactive(e.target) || !setRay(e)) return;
    const hit = hitLink();
    if (!hit) return;
    const body = links[hit.index];
    if (hit.index === MID) flash = 1;
    const at = new CANNON.Vec3(hit.point.x, hit.point.y, hit.point.z);
    if (e.pointerType === 'touch') {
      body.applyImpulse(new CANNON.Vec3(perp.x * 22 * IMPULSE * (Math.random() < 0.5 ? -1 : 1), perp.y * 22 * IMPULSE, (Math.random() - 0.5) * 18 * IMPULSE), at);
      return;
    }
    e.preventDefault();
    dragBody.position.copy(at);
    dragBody.velocity.setZero();
    const c = new CANNON.PointToPointConstraint(body, body.pointToLocalFrame(at), dragBody, new CANNON.Vec3(), DRAG_FORCE);
    world.addConstraint(c);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(tmpV).negate(), hit.point);
    drag = { c, target: hit.point.clone(), origin: hit.point.clone() };
    lastNudge = null;
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
    const k = Math.min(Math.abs(dy), 60) * 0.04 * IMPULSE * (Math.random() - 0.5) * 2;
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
    const swayA = Math.sin(clock * 0.42) * 0.1, swayB = Math.sin(clock * 0.31 + 2) * 0.1;
    tA.set(baseA.x + perp.x * swayA, baseA.y + perp.y * swayA, Math.sin(clock * 0.25) * 0.12);
    tB.set(baseB.x + perp.x * swayB, baseB.y + perp.y * swayB, Math.cos(clock * 0.22) * 0.12);
    steer(anchorA, tA, dt);
    steer(anchorB, tB, dt);
    if (drag) steer(dragBody, drag.target, dt);
    world.step(1 / 120, dt, 6);
    keepConnected();
  }

  const dummy = new THREE.Object3D();
  function sync() {
    OTHERS.forEach((li, k) => {
      const b = links[li];
      dummy.position.set(b.position.x, b.position.y, b.position.z);
      dummy.quaternion.set(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
      dummy.updateMatrix();
      mesh.setMatrixAt(k, dummy.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    const h = links[MID];
    heroGroup.position.set(h.position.x, h.position.y, h.position.z);
    heroGroup.quaternion.set(h.quaternion.x, h.quaternion.y, h.quaternion.z, h.quaternion.w);
  }

  // 빛줄기는 늘 흐르고, 올리면 세지고(1.9배), 잡는 순간 번쩍였다가 가라앉는다. 움직임 줄이기 설정이면 멈춘 한 장면으로 둔다
  function updateHeroFx(elapsed) {
    const dt = Math.min(elapsed, 0.1);
    if (!reduceMotion) heroFx.uTime.value += dt;
    else heroFx.uTime.value = 2.2;
    // 빛이 걷히며 다이아몬드가 박히는 순간 한 번 번쩍 반짝인다
    if (!setFlashed && buildT >= T.set[0]) { setFlashed = true; flash = 1; }
    energyTarget = drag && links.indexOf(drag.c.bodyA) === MID ? 2.4 : heroHover ? 1.9 : 1;
    flash = Math.max(0, flash - dt * 1.6);
    const e = heroFx.uEnergy.value;
    heroFx.uEnergy.value = e + (energyTarget + flash * 2.5 - e) * (1 - Math.exp(-dt / 0.18));
  }

  let needsRender = true, last = performance.now(), frame = 0;
  layout();
  if (/chaindebug/.test(location.search)) window.__chain = { get links() { return links; }, limits, simulate, perp, anchorA, anchorB, setBuild: (v) => { buildT = v; buildFrozen = v !== null; }, get buildT() { return buildT; }, morph, heroFx, heroGroup, heroTube, stoneMesh, beadMesh, stoneU, renderer, world, CANNON, dragBody, snap: () => { sync(); updateMorph(); trackChain(10); placeCamera(); renderer.render(scene, camera); return canvas.toDataURL(); } };
  if (reduceMotion) {
    for (let i = 0; i < 360; i++) simulate(1 / 120);
  } else {
    links.forEach((b, i) => { const s = Math.sin((i / N) * Math.PI) * 1.2; b.velocity.set(-perp.x * s, -perp.y * s, 0.6); });
  }
  sync();

  function loop(now) {
    requestAnimationFrame(loop);
    const elapsed = (now - last) / 1000;
    const dt = Math.min(elapsed, 1 / 30);
    last = now;
    if (document.hidden || !visible) return;
    introClock += dt;
    advanceBuild(dt);
    if (!reduceMotion) {
      if (physicsOn()) simulate(dt);
      sync();
      needsRender = true;
    }
    updateMorph();
    updateHeroFx(elapsed);
    trackChain(reduceMotion ? 10 : elapsed);
    placeCamera();
    updatePen();
    if (hoverDirty && !drag && physicsOn() && ++frame % 3 === 0) {
      hoverDirty = false;
      const hit = pointerOverUi ? null : hitLink();
      const over = !!hit;
      heroHover = !!hit && hit.index === MID;
      if (over !== hovering) { hovering = over; document.documentElement.classList.toggle('chain-hover', over); }
    }
    if (needsRender) { renderer.render(scene, camera); needsRender = false; }
  }
  // 무거운 셰이더(다이아몬드 광선 추적 등)를 먼저 다 컴파일해 두고 시작 — 첫 프레임이 멈칫하지 않는다
  placeCamera();
  renderer.compileAsync(scene, camera).catch(() => {}).then(() => {
    last = performance.now();
    requestAnimationFrame(loop);
  });
}
