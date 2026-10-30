/**
 * ポーズの FBX に呼吸を付ける。
 *
 * 配っている FBX は全フレームが同じ止まった姿勢（1 フレーム目）で、呼吸は入っていない。
 * ここで胴・首・鎖骨に、式で作った呼吸（吸って吐くを 2 回と、ループ全体でのゆっくりしたひねり）を右から掛ける
 * （q_t = q_0 · d_t）。胴が動いても手首の位置と手の向きが変わらないよう、腕は 2 本の骨の IK で合わせ直す。
 */
import * as THREE from 'three';
import type { FbxFile, FbxNode } from './binary.ts';
import { type Bone, DEG, localQuaternion, readBones, worldPose } from './skeleton.ts';

/** 強さ 1（100%）での骨ごとの角度（度）。胴・首の局所軸は X が体の左、Y が上、Z が正面 */
interface Motion {
  /** 吸うと胸が起きる回転（局所 X 軸）。負が反らす向き */
  inhale?: number;
  /** ゆっくりした体のひねり（局所 Y 軸） */
  sway?: number;
  /** 吸うと鎖骨が上がる回転（局所 Z 軸。左右で向きが逆） */
  lift?: number;
}

const BREATH: Record<string, Motion> = {
  Spine: { inhale: -0.15, sway: 0.1 },
  Spine1: { inhale: -0.45, sway: 0.25 },
  Spine2: { inhale: -0.8, sway: 0.4 },
  // 首と頭は胸の起き上がりを半分ほど打ち消し、顔の向きを保つ
  Neck: { inhale: 0.35, sway: -0.15 },
  Head: { inhale: 0.25, sway: -0.2 },
  LeftShoulder: { lift: 0.3 },
  RightShoulder: { lift: -0.3 },
};

/** ループ（1 フレーム目から最後まで）の中で吸って吐く回数 */
const BREATHS = 2;

function near(angle: number, reference: number): number {
  return angle - 360 * Math.round((angle - reference) / 360);
}

/** 四元数を、基準に近い方のオイラー角（度）にする（補間で一回りしないように） */
function toEuler(q: THREE.Quaternion, reference: number[]): number[] {
  const e = new THREE.Euler().setFromQuaternion(q, 'ZYX');
  const a = [e.x * DEG, e.y * DEG, e.z * DEG];
  const b = [a[0] + 180, 180 - a[1], a[2] + 180];
  const fitA = a.map((v, j) => near(v, reference[j]));
  const fitB = b.map((v, j) => near(v, reference[j]));
  const cost = (v: number[]) => v.reduce((sum, x, j) => sum + Math.abs(x - reference[j]), 0);
  return cost(fitA) <= cost(fitB) ? fitA : fitB;
}

type Curves = [Float32Array, Float32Array, Float32Array];

/** 回転の曲線を、全フレーム 1 フレーム目の値の新しい配列に差し替えて返す（元の FBX の配列は書き換えない） */
function hold(bone: Bone): Curves {
  if (!bone.rotation || !bone.setRotation) throw new Error(`${bone.name} に回転の曲線がありません`);
  const curves = bone.rotation.map((c) => new Float32Array(c.length).fill(c[0])) as Curves;
  bone.rotation = curves;
  return curves;
}

function write(bone: Bone, frame: number, q: THREE.Quaternion) {
  const curves = bone.rotation!;
  toEuler(q, curves.map((c) => c[frame - 1])).forEach((v, j) => { curves[j][frame] = v; });
}

interface ArmBase {
  shoulder: THREE.Vector3;
  elbow: THREE.Vector3;
  wrist: THREE.Vector3;
  arm: THREE.Quaternion;
  foreArm: THREE.Quaternion;
  hand: THREE.Quaternion;
}

/**
 * 胴が動いて肩の位置が変わったあと、手首を 1 フレーム目の位置に戻すよう上腕・前腕を回す（2 本の骨の IK）。
 * 肘は 1 フレーム目と同じ側に曲げ、手のワールドの向きは 1 フレーム目のまま保つ
 */
function reach(bones: Map<string, Bone>, side: string, frame: number, base: ArmBase) {
  const [arm, foreArm, hand] = ['Arm', 'ForeArm', 'Hand'].map((n) => bones.get(side + n)!);
  const upper = base.elbow.distanceTo(base.shoulder);
  const lower = base.wrist.distanceTo(base.elbow);
  const parent = worldPose(arm.parent!, frame).quaternion;
  const shoulder = worldPose(arm, frame).position;
  const toWrist = base.wrist.clone().sub(shoulder);
  const distance = Math.min(toWrist.length(), upper + lower - 1e-6);
  const dir = toWrist.normalize();
  // 肘は、肩から dir 方向へ along 進み、そこから 1 フレーム目の肘の側へ out 離れた所
  const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
  const out = Math.sqrt(Math.max(0, upper * upper - along * along));
  const pole = base.elbow.clone().sub(base.shoulder);
  pole.addScaledVector(dir, -pole.dot(dir)).normalize();
  const elbow = shoulder.clone().addScaledVector(dir, along).addScaledVector(pole, out);
  const wrist = shoulder.clone().addScaledVector(dir, distance);

  const turnUpper = new THREE.Quaternion().setFromUnitVectors(
    base.elbow.clone().sub(base.shoulder).normalize(), elbow.clone().sub(shoulder).normalize());
  const armWorld = turnUpper.clone().multiply(base.arm);
  const turnLower = new THREE.Quaternion().setFromUnitVectors(
    base.wrist.clone().sub(base.elbow).applyQuaternion(turnUpper).normalize(), wrist.clone().sub(elbow).normalize());
  const foreArmWorld = turnLower.multiply(turnUpper).multiply(base.foreArm);
  write(arm, frame, parent.clone().invert().multiply(armWorld));
  write(foreArm, frame, armWorld.clone().invert().multiply(foreArmWorld));
  write(hand, frame, foreArmWorld.clone().invert().multiply(base.hand));
}

/**
 * 呼吸の強さを strength（1 が標準。0 で止まった姿勢）にした FBX の木を返す。
 * 元の FBX の木は書き換えない
 */
export function withBreath(file: FbxFile, strength: number): FbxFile {
  const clone = (node: FbxNode): FbxNode => ({ ...node, props: [...node.props], children: node.children.map(clone) });
  const copy: FbxFile = { ...file, nodes: file.nodes.map(clone) };
  const bones = readBones(copy);
  const torso = Object.entries(BREATH).map(([name, motion]) => {
    const bone = bones.get(name)!;
    return { bone, motion, rest: localQuaternion(bone, 0), curves: hold(bone) };
  });
  const arms = (['Left', 'Right'] as const).map((side) => {
    const chain = ['Arm', 'ForeArm', 'Hand'].map((n) => bones.get(side + n)!);
    const curves = chain.map(hold);
    const [a, f, h] = chain.map((bone) => worldPose(bone));
    const base: ArmBase = {
      shoulder: a.position, elbow: f.position, wrist: h.position,
      arm: a.quaternion, foreArm: f.quaternion, hand: h.quaternion,
    };
    return { side, chain, curves, base };
  });

  const frames = torso[0].curves[0].length;
  const x = new THREE.Vector3(1, 0, 0), y = new THREE.Vector3(0, 1, 0), z = new THREE.Vector3(0, 0, 1);
  const delta = new THREE.Quaternion(), turn = new THREE.Quaternion();
  for (let frame = 1; frame < frames; frame++) {
    // 1 フレーム目と最後で 0 に戻るので、そのままループする
    const u = frame / (frames - 1);
    const inhale = (1 - Math.cos(2 * Math.PI * BREATHS * u)) / 2;
    const sway = Math.sin(2 * Math.PI * u);
    for (const { bone, motion, rest } of torso) {
      delta.identity();
      if (motion.inhale) delta.multiply(turn.setFromAxisAngle(x, (motion.inhale * inhale * strength) / DEG));
      if (motion.sway) delta.multiply(turn.setFromAxisAngle(y, (motion.sway * sway * strength) / DEG));
      if (motion.lift) delta.multiply(turn.setFromAxisAngle(z, (motion.lift * inhale * strength) / DEG));
      write(bone, frame, rest.clone().multiply(delta));
    }
    for (const { side, base } of arms) reach(bones, side, frame, base);
  }
  for (const { bone, curves } of torso) bone.setRotation!(curves);
  for (const { chain, curves } of arms) chain.forEach((bone, i) => bone.setRotation!(curves[i]));
  return copy;
}
