/**
 * ポーズの FBX の腕を直す。曲線の値だけを書き換える（全フレームに同じ回転を掛ける）。
 *
 * 使い方: node scripts/pose_edit.ts scripts/pose_fixes.json
 * pose_fixes.json の各項目（public/motions/<id>.fbx をその場で書き換える。直しは元の FBX に対して一度だけ当てる）:
 *   { "id": "full_P018", "move": { "side": "Right", "effector": "Hand", "offset": [x, y, z] } }
 *     1 フレーム目で effector（Hand・HandIndex4 など）が offset（m。キャラの足元基準・+x は左手側・+z は正面）
 *     だけ動くよう、上腕（<side>Arm）を肩の周りに回す
 *   { "id": "full_P032", "mirror": { "from": "Left" } }
 *     反対の腕を、from の腕の鏡写しにする（肩から指先まで）
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { readFbx, writeFbx } from '../src/fbx/binary.ts';
import { type Bone, DEG, localQuaternion, readBones, worldPose } from '../src/fbx/skeleton.ts';

function near(angle: number, reference: number): number {
  return angle - 360 * Math.round((angle - reference) / 360);
}

/** 四元数を、元のキーに近い方のオイラー角（度）にする（補間で一回りしないように） */
function toEuler(q: THREE.Quaternion, original: number[]): number[] {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const a = [e.x * DEG, e.y * DEG, e.z * DEG];
  const b = [a[0] + 180, 180 - a[1], a[2] + 180];
  const fitA = a.map((v, j) => near(v, original[j]));
  const fitB = b.map((v, j) => near(v, original[j]));
  const cost = (v: number[]) => v.reduce((sum, x, j) => sum + Math.abs(x - original[j]), 0);
  return cost(fitA) <= cost(fitB) ? fitA : fitB;
}

/** 全フレームの局所回転に、左から一定の回転 left を掛ける */
function premultiply(bone: Bone, left: THREE.Quaternion) {
  if (!bone.rotation || !bone.setRotation) throw new Error(`${bone.name} に回転の曲線がありません`);
  const [xs, ys, zs] = bone.rotation;
  const out: [Float32Array, Float32Array, Float32Array] = [new Float32Array(xs.length), new Float32Array(xs.length), new Float32Array(xs.length)];
  for (let i = 0; i < xs.length; i++) {
    const original = [xs[i], ys[i], zs[i]];
    const q = left.clone().multiply(localQuaternion(bone, i));
    toEuler(q, original).forEach((v, j) => { out[j][i] = v; });
  }
  bone.setRotation(out);
  bone.rotation = out;
}

/**
 * 1 フレーム目で effector が offset（ワールド・m）だけ動くよう、上腕を肩の周りに回す。
 * 小さな回転を求めて当てるのを数回繰り返して合わせる
 */
function moveArm(bones: Map<string, Bone>, side: string, effector: string, offset: THREE.Vector3) {
  const arm = bones.get(`${side}Arm`)!;
  const end = bones.get(`${side}${effector}`)!;
  const goal = worldPose(end).position.add(offset);
  for (let step = 0; step < 8; step++) {
    const shoulder = worldPose(arm).position;
    const tip = worldPose(end).position;
    const miss = goal.clone().sub(tip);
    if (miss.length() < 0.0005) break;
    const v = tip.clone().sub(shoulder);
    // ω × v = miss（v に直交する成分）となる回転ベクトル ω = v × miss / |v|²
    const omega = v.clone().cross(miss).divideScalar(v.lengthSq());
    const angle = omega.length();
    const world = new THREE.Quaternion().setFromAxisAngle(omega.normalize(), angle);
    // ワールドの回転を、親（肩）の座標での回転にする：P⁻¹ · R · P
    const parent = worldPose(arm.parent!).quaternion;
    const left = parent.clone().invert().multiply(world).multiply(parent);
    premultiply(arm, left);
  }
  const rest = goal.distanceTo(worldPose(end).position);
  return rest;
}

/** 反対の腕（肩から指先まで）を from の腕の鏡写しにする。左右の骨は局所軸が鏡写しなので (x, -y, -z) */
function mirrorArm(bones: Map<string, Bone>, from: string) {
  const to = from === 'Left' ? 'Right' : 'Left';
  for (const [name, bone] of bones) {
    if (!name.startsWith(from) || /UpLeg|Leg|Foot|Toe/.test(name)) continue;
    const target = bones.get(to + name.slice(from.length));
    if (!target?.setRotation || !bone.rotation) continue;
    const [xs, ys, zs] = bone.rotation;
    const out: [Float32Array, Float32Array, Float32Array] = [Float32Array.from(xs), ys.map((v) => -v), zs.map((v) => -v)];
    target.setRotation(out);
    target.rotation = out;
  }
}

interface Fix {
  id: string;
  move?: { side: 'Left' | 'Right'; effector: string; offset: [number, number, number] };
  mirror?: { from: 'Left' | 'Right' };
}

if (import.meta.main) {
  const fixes = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Fix[];
  const dir = process.argv[3] ?? 'public/motions';
  for (const fix of fixes) {
    const path = `${dir}/${fix.id}.fbx`;
    const buffer = readFileSync(path);
    const file = readFbx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const bones = readBones(file);
    if (fix.mirror) mirrorArm(bones, fix.mirror.from);
    if (fix.move) {
      const rest = moveArm(bones, fix.move.side, fix.move.effector, new THREE.Vector3(...fix.move.offset));
      console.log(fix.id, fix.move.side, `残り ${(rest * 100).toFixed(2)} cm`);
    }
    writeFileSync(path, writeFbx(file));
  }
}
