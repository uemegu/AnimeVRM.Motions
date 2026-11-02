/**
 * モーションの一覧から選ぶと、右にアオイを立たせて動かす。呼吸の強さを変えると、その強さで FBX を作り直して見せる。
 * ダウンロードも同じ FBX（ブラウザの中で作ったもの）を渡す
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { StageManager } from '../engine/src/stage/StageManager';
import { registerEnvironment } from '../engine/src/stage/environments';
import { configureAssets } from '../engine/src/utils/path';
import type { LocationVisualPreset, TimeOfDayPreset } from '../engine/src/schema/visual';
import { type FbxFile, readFbx, writeFbx } from './fbx/binary.ts';
import { withBreath } from './fbx/breath.ts';
import { withContact, type ContactProfile } from './fbx/contact.ts';
import { readBones, worldPose } from './fbx/skeleton.ts';
import { previewPlacement, type PreviewPlacement, type PreviewPose } from './previewPlacement.ts';
import { disposePaintedAoiRoom, loadPaintedAoiRoom } from './sets/painted-aoi-room/PaintedAoiRoom';
import { STANDING_ORIGIN } from './sets/painted-aoi-room/layout';
import day from './day.json';
import motions from './motions.json';
import contactProfiles from './contactProfiles.json';

interface Motion {
  id: string;
  number: string;
  line: 'full' | 'upper';
  name: string;
  category: string;
}

const base = import.meta.env.BASE_URL;
/** 手で回すカメラの画角 */
const FOV = 35;
/** 床のプレビューは、会話の立ち位置より少しテーブルから離す。 */
const PREVIEW_FORWARD_OFFSET = 0.55;
const list = motions as Motion[];
const contacts = contactProfiles as unknown as Record<string, ContactProfile>;

// 待機モーションは使わない（選んだモーションだけを流す）
configureAssets({ idleMotion: null });

registerEnvironment('painted-aoi-room', { load: loadPaintedAoiRoom, dispose: disposePaintedAoiRoom });

/** 本体の aoi_house_frontlit の順光。プレビューのため、テーブルから少し離れた床を原点にする。 */
const aoiRoom: LocationVisualPreset = {
  id: 'aoi_house_frontlit',
  name: 'アオイの部屋（順光・簡易3D）',
  isIndoor: true,
  layers: { background: { url: '/textures/painted-classroom/sky-only.png' } },
  environment: {
    model: 'builtin:painted-aoi-room',
    position: { x: -STANDING_ORIGIN[0], y: -STANDING_ORIGIN[1], z: -STANDING_ORIGIN[2] - PREVIEW_FORWARD_OFFSET },
    rotationY: 0, scale: 1,
  },
  light: { direction: { x: 0.8, y: 1.3, z: 2 }, shadow: { color: '#8a6450', opacity: 0.4, softness: 3 } },
  stage: {
    postProcessing: { sunShafts: false, lensFlare: false },
    camera: { fov: FOV, depthOfField: { aperture: 0.01, maxBlur: 0.004, sharpRange: 10 } },
  },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const loading = $('loading');
const breath = $<HTMLInputElement>('breath');
const breathValue = $<HTMLOutputElement>('breathValue');
const download = $<HTMLButtonElement>('download');

const stage = new StageManager({
  canvas,
  presets: { timeOfDay: { day: day as TimeOfDayPreset }, locations: { [aoiRoom.id]: aoiRoom } },
  initialTimeOfDay: 'day',
  initialLocationId: aoiRoom.id,
});
const resize = () => stage.resize(canvas.clientWidth, canvas.clientHeight);
new ResizeObserver(resize).observe(canvas);
resize();

// ---- FBX を作る ----

const sources = new Map<string, Promise<FbxFile>>();
/** 作った FBX（モーション id と強さごと）。同じ組み合わせなら同じ URL を返し、描画側の読み込みも使い回させる */
const baked = new Map<string, { blob: Blob; url: string }>();

function source(id: string): Promise<FbxFile> {
  let file = sources.get(id);
  if (!file) {
    file = fetch(`${base}motions/${id}.fbx`).then(async (res) => {
      if (!res.ok) throw new Error(`${id}.fbx を読めません（${res.status}）`);
      return readFbx(await res.arrayBuffer());
    });
    sources.set(id, file);
  }
  return file;
}

async function bake(id: string, percent: number): Promise<{ blob: Blob; url: string }> {
  const key = `${id}@${percent}`;
  let result = baked.get(key);
  if (!result) {
    const strength = percent / 100;
    const file = await source(id);
    const bytes = writeFbx(withBreath(withContact(file, contacts[id]), strength));
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    result = { blob, url: URL.createObjectURL(blob) };
    baked.set(key, result);
  }
  return result;
}

// ---- 一覧 ----

const filters = $('filters');
const grid = $('grid');
const categories = ['すべて', ...new Set(list.map((m) => m.category))];
let filter = 'すべて';
let current = list[0];

function renderFilters() {
  filters.replaceChildren(...categories.map((name) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.textContent = name;
    button.setAttribute('aria-selected', String(name === filter));
    button.addEventListener('click', () => {
      filter = name;
      renderFilters();
      renderGrid();
    });
    return button;
  }));
}

function renderGrid() {
  grid.replaceChildren(...list.filter((m) => filter === 'すべて' || m.category === filter).map((m) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'card';
    button.dataset.id = m.id;
    button.setAttribute('aria-current', String(m.id === current.id));
    const img = document.createElement('img');
    img.src = `${base}thumbs/${m.id}.avif`;
    img.alt = '';
    img.loading = 'lazy';
    const meta = document.createElement('span');
    meta.className = 'meta';
    const id = document.createElement('span');
    id.className = 'id';
    id.textContent = `${m.line === 'full' ? '全身' : '上半身'} ${m.number}`;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = m.name;
    meta.append(id, label);
    button.append(img, meta);
    button.addEventListener('click', () => {
      select(m);
      // 縦に並ぶ狭い画面では、一覧の下の方から選んだときにプレビューまで戻す
      if (matchMedia('(max-width: 820px)').matches) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    item.append(button);
    return item;
  }));
}

// ---- プレビュー ----

/**
 * 1 フレーム目の骨の位置から、体の範囲（足元が原点）と頭の位置を求める。
 * 描画を待たずに選んだ時点で構図を決められる（FBX の骨はアオイの体型に合わせてある）
 */
function poseOf(file: FbxFile): PreviewPose {
  const bones = readBones(file);
  const box = new THREE.Box3();
  for (const bone of bones.values()) box.expandByPoint(worldPose(bone).position);
  // 骨は体の中を通っているので、肉付きと服の分だけ広げる（床より下には広げない）
  box.expandByScalar(0.1);
  box.min.y = Math.max(box.min.y, 0);
  const head = bones.get('Head');
  const hips = bones.get('Hips');
  return {
    box,
    head: head ? worldPose(head).position : new THREE.Vector3(0, 1.37, 0),
    hips: hips ? worldPose(hips).position : new THREE.Vector3(0, 0.8, 0),
  };
}

let request = 0;
let controls: OrbitControls | null = null;

async function show() {
  const ticket = ++request;
  const motion = current;
  loading.hidden = false;
  try {
    const { url } = await bake(motion.id, Number(breath.value));
    if (ticket !== request) return;
    const pose = poseOf(withContact(await source(motion.id), contacts[motion.id]));
    if (ticket !== request) return;
    const placement = previewPlacement(motion, pose, aoiRoom.environment!.position);
    await stage.setCast([{
      id: 'aoi', modelUrl: `${base}models/aoi.vrm`,
      position: placement.position.toArray(), rotationY: placement.rotationY,
      expression: 'neutral', expressionWeight: 1, motion: url, motionLoop: true,
    }]);
    // 置き直すと構図の画角に戻るので、描かれる前に構図ごと決め直す
    if (ticket !== request) return;
    const avatar = await stage.loadAvatar('aoi', `${base}models/aoi.vrm`);
    if (ticket !== request) return;
    // 腿への接触を FBX で合わせた姿勢は、前腕の太さを一律に使う押し出しで再び浮かせない。
    const onThigh = Object.values(contacts[motion.id]?.hands ?? {}).some(hand => hand?.surface === 'thigh');
    avatar.setHandClearance(onThigh ? 'off' : stage.getQuality().handClearance);
    if (motion.line === 'upper') {
      // 上半身はポーズで頭が前後するので、頭の位置に正面から寄る
      const head = pose.head.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotationY).add(placement.position);
      frame(new THREE.Vector3(head.x, head.y - 0.12, head.z), 0.75, 0);
    } else {
      frameBody(pose.box, placement);
    }
  } catch (error) {
    console.error(error);
  } finally {
    if (ticket === request) loading.hidden = true;
  }
}

/** 全身を、体の範囲が収まるように撮る */
function frameBody(box: THREE.Box3, placement: PreviewPlacement) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3())
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), placement.rotationY).add(placement.position);
  // 低い姿勢（座り・寝そべりなど）は少し上から見下ろす。前後に長い寝そべりは斜め横から撮る
  const low = size.y < 1.2;
  const side = size.y < 0.6 && size.z > size.x * 1.3 ? 0.9 : 0;
  const length = side ? size.z * 0.8 : size.z * 0.75;
  const pitch = placement.lying ? 0.95 : placement.onBed ? 0.55 : low ? 0.4 : 0.08;
  const bounds = box.clone().applyMatrix4(
    new THREE.Matrix4().makeRotationY(placement.rotationY).setPosition(placement.position),
  );
  frame(center, Math.max(size.y, size.x * 0.75, length) * 1.2, pitch, side + placement.rotationY, bounds);
}

function select(motion: Motion) {
  current = motion;
  if (filter !== 'すべて' && motion.category !== filter) {
    filter = 'すべて';
    renderFilters();
    renderGrid();
  }
  for (const card of grid.querySelectorAll<HTMLElement>('.card')) {
    card.setAttribute('aria-current', String(card.dataset.id === motion.id));
  }
  grid.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  $('number').textContent = `${motion.line === 'full' ? '全身' : '上半身'} ${motion.number}`;
  $('name').textContent = motion.name;
  $('category').textContent = motion.category;
  history.replaceState(null, '', `#${motion.id}`);
  void show();
}

/** 手で回すカメラの画角にする（キャラを置き直すと、手で回しているあいだも構図の画角に戻るため） */
function applyFov() {
  const camera = stage.viewCamera;
  if (camera.fov === FOV) return;
  camera.fov = FOV;
  camera.updateProjectionMatrix();
}

/**
 * target を中心に、高さ span（m）が画面に収まる距離から撮り、手で回せるようにする。
 * 向きは、手で回していればその向きのまま（見下ろす角度 pitch は最初だけ）、まだなら正面から
 */
function frame(target: THREE.Vector3, span: number, pitch: number, yaw = 0, bounds?: THREE.Box3) {
  const camera = stage.viewCamera;
  applyFov();
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
  let distance = span / 2 / tan;
  const direction = controls
    ? camera.position.clone().sub(controls.target).normalize()
    : front(pitch, yaw);
  if (!controls) {
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.addEventListener('change', () => stage.setFreeCameraTarget(controls!.target));
    stage.setFreeCamera(true);
    const tick = () => {
      controls!.update();
      requestAnimationFrame(tick);
    };
    tick();
  } else if (!userOrbited) {
    direction.copy(front(pitch, yaw));
  }
  // 回転した寝姿と縦長の画面でも手足が切れない距離。各隅の奥行きも含めて透視投影で合わせる。
  if (bounds) {
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right).normalize();
    for (const x of [bounds.min.x, bounds.max.x]) {
      for (const y of [bounds.min.y, bounds.max.y]) {
        for (const z of [bounds.min.z, bounds.max.z]) {
          const point = new THREE.Vector3(x, y, z).sub(target);
          distance = Math.max(distance, point.dot(direction) + Math.max(
            Math.abs(point.dot(up)) / tan,
            Math.abs(point.dot(right)) / (tan * camera.aspect),
          ));
        }
      }
    }
    distance *= 1.05;
  }
  camera.position.copy(target).addScaledVector(direction, distance);
  controls.target.copy(target);
  controls.update();
  stage.setFreeCameraTarget(target);
}

/** 正面（+z）から yaw だけ横へ回り、pitch だけ見下ろす向き */
function front(pitch: number, yaw: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
}

/** 手でカメラを回したか（回したら、選び直しても向きを保つ） */
let userOrbited = false;
canvas.addEventListener('pointerdown', () => { userOrbited = true; });
canvas.addEventListener('wheel', () => { userOrbited = true; }, { passive: true });

let breathTimer = 0;
breath.addEventListener('input', () => {
  breathValue.textContent = `${breath.value}%`;
  clearTimeout(breathTimer);
  breathTimer = window.setTimeout(show, 150);
});

download.addEventListener('click', async () => {
  download.disabled = true;
  try {
    const { url } = await bake(current.id, Number(breath.value));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${current.id}_breath${breath.value}.fbx`;
    link.click();
  } finally {
    download.disabled = false;
  }
});

renderFilters();
renderGrid();
select(list.find((m) => m.id === location.hash.slice(1)) ?? list[0]);
window.addEventListener('hashchange', () => {
  const motion = list.find((m) => m.id === location.hash.slice(1));
  if (motion && motion !== current) select(motion);
});
