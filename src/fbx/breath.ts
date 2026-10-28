/**
 * ポーズの FBX に混ぜてある待機（Idle）の呼吸の強さを変える。
 *
 * 元の FBX は motion-create が作ったもので、1 フレーム目が呼吸のない姿勢、以降は胴に Idle を
 * 強さ BAKED_STRENGTH で右から掛けてある（q_t = q_0 · d_t^BAKED_STRENGTH）。
 * そこで各フレームの 1 フレーム目からの差（回転は q_0⁻¹·q_t、移動は差分）を strength / BAKED_STRENGTH 倍する。
 * 胴は元の混ぜ方と一致する。手首を止める腕の IK は差を倍率で伸ばすだけの近似で、強さを大きく変えると手が少しずれる。
 */
import * as THREE from 'three';
import { type FbxFile, type FbxNode, child, propString } from './binary.ts';

/** motion-create（build_fbx.py の --idle-strength）で混ぜた強さ */
export const BAKED_STRENGTH = 0.8;

interface CurveSet {
  kind: 'R' | 'T';
  /** X・Y・Z の AnimationCurve */
  curves: [FbxNode, FbxNode, FbxNode];
}

function nodeId(node: FbxNode): bigint {
  const id = node.props[0];
  if (id.type !== 'L') throw new Error(`${node.name} の id がありません`);
  return id.value;
}

/** 回転・移動の CurveNode ごとに X・Y・Z の曲線をまとめる */
function curveSets(file: FbxFile): CurveSet[] {
  const objects = file.nodes.find((n) => n.name === 'Objects');
  const connections = file.nodes.find((n) => n.name === 'Connections');
  if (!objects || !connections) throw new Error('FBX に Objects・Connections がありません');
  const curves = new Map<bigint, FbxNode>();
  const curveNodes = new Map<bigint, FbxNode>();
  for (const o of objects.children) {
    if (o.name === 'AnimationCurve') curves.set(nodeId(o), o);
    else if (o.name === 'AnimationCurveNode') curveNodes.set(nodeId(o), o);
  }
  const axes = new Map<bigint, FbxNode[]>();
  for (const c of connections.children) {
    const [, from, to, prop] = c.props;
    if (from?.type !== 'L' || to?.type !== 'L') continue;
    const curve = curves.get(from.value);
    if (!curve || !curveNodes.has(to.value)) continue;
    const index = ['d|X', 'd|Y', 'd|Z'].indexOf(propString(prop));
    if (index < 0) continue;
    const list = axes.get(to.value) ?? [];
    list[index] = curve;
    axes.set(to.value, list);
  }
  const sets: CurveSet[] = [];
  for (const [id, list] of axes) {
    const kind = propString(curveNodes.get(id)!.props[1]).split('\0')[0];
    if ((kind === 'R' || kind === 'T') && list[0] && list[1] && list[2]) {
      sets.push({ kind, curves: [list[0], list[1], list[2]] });
    }
  }
  return sets;
}

function keyValues(curve: FbxNode): Float32Array {
  const prop = child(curve, 'KeyValueFloat')?.props[0];
  if (prop?.type !== 'f') throw new Error('KeyValueFloat がありません');
  return prop.value as Float32Array;
}

function setKeyValues(curve: FbxNode, values: Float32Array) {
  child(curve, 'KeyValueFloat')!.props[0] = { type: 'f', value: values };
  const def = child(curve, 'Default');
  if (def) def.props[0] = { type: 'D', value: values[0] };
}

/** 角度を基準に近い側へ 360 度単位で寄せる */
function near(angle: number, reference: number): number {
  return angle - 360 * Math.round((angle - reference) / 360);
}

const DEG = 180 / Math.PI;

/** q を k 乗する（回転軸はそのまま、角度だけ k 倍） */
function powQuaternion(q: THREE.Quaternion, k: number): THREE.Quaternion {
  const w = Math.min(1, Math.abs(q.w));
  const sign = q.w < 0 ? -1 : 1;
  const half = Math.acos(w);
  const s = Math.sin(half);
  if (s < 1e-9) return new THREE.Quaternion();
  const scaled = half * k;
  const f = (Math.sin(scaled) / s) * sign;
  return new THREE.Quaternion(q.x * f, q.y * f, q.z * f, Math.cos(scaled));
}

/**
 * 呼吸の強さを strength（Idle の何倍か。元は BAKED_STRENGTH）にした FBX の木を返す。
 * 曲線の値の配列だけを差し替え、ほかのノードは元と共有する
 */
export function withBreath(file: FbxFile, strength: number): FbxFile {
  const k = strength / BAKED_STRENGTH;
  const clone = (node: FbxNode): FbxNode => ({ ...node, props: [...node.props], children: node.children.map(clone) });
  const copy: FbxFile = { ...file, nodes: file.nodes.map(clone) };
  const euler = new THREE.Euler();
  const q0 = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (const set of curveSets(copy)) {
    const [xs, ys, zs] = set.curves.map(keyValues);
    const frames = xs.length;
    const out = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
    if (set.kind === 'T') {
      for (let i = 0; i < frames; i++) {
        out[0][i] = xs[0] + (xs[i] - xs[0]) * k;
        out[1][i] = ys[0] + (ys[i] - ys[0]) * k;
        out[2][i] = zs[0] + (zs[i] - zs[0]) * k;
      }
    } else {
      // 回転順 XYZ（行列は Rz·Ry·Rx）は three.js の 'ZYX'
      q0.setFromEuler(euler.set(xs[0] / DEG, ys[0] / DEG, zs[0] / DEG, 'ZYX'));
      const q0Inverse = q0.clone().invert();
      for (let i = 0; i < frames; i++) {
        q.setFromEuler(euler.set(xs[i] / DEG, ys[i] / DEG, zs[i] / DEG, 'ZYX'));
        const delta = powQuaternion(q0Inverse.clone().multiply(q), k);
        euler.setFromQuaternion(q0.clone().multiply(delta), 'ZYX');
        // オイラー角は 2 通りある。元のキーに近い方を選び、補間で一回りしないようにする
        const a = [euler.x * DEG, euler.y * DEG, euler.z * DEG];
        const b = [a[0] + 180, 180 - a[1], a[2] + 180];
        const original = [xs[i], ys[i], zs[i]];
        const fitA = a.map((v, j) => near(v, original[j]));
        const fitB = b.map((v, j) => near(v, original[j]));
        const cost = (v: number[]) => v.reduce((sum, x, j) => sum + Math.abs(x - original[j]), 0);
        const pick = cost(fitA) <= cost(fitB) ? fitA : fitB;
        out[0][i] = pick[0];
        out[1][i] = pick[1];
        out[2][i] = pick[2];
      }
    }
    set.curves.forEach((curve, j) => setKeyValues(curve, out[j]));
  }
  return copy;
}
