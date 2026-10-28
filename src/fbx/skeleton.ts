/**
 * ポーズの FBX（motion-create の Mixamo 骨。プレ回転なし・回転順 XYZ）の骨を読み、フレームごとの骨の位置を求める
 */
import * as THREE from 'three';
import { type FbxFile, type FbxNode, child, propString } from './binary.ts';

export const DEG = 180 / Math.PI;

export interface Bone {
  name: string;
  parent: Bone | null;
  translation: THREE.Vector3;
  /** 移動の X・Y・Z 曲線（cm。腰だけ） */
  translationCurves: [Float32Array, Float32Array, Float32Array] | null;
  /** 回転の X・Y・Z 曲線（度） */
  rotation: [Float32Array, Float32Array, Float32Array] | null;
  setRotation: ((values: [Float32Array, Float32Array, Float32Array]) => void) | null;
  staticRotation: THREE.Vector3;
}

function id(node: FbxNode): bigint {
  const prop = node.props[0];
  if (prop.type !== 'L') throw new Error(`${node.name} の id がありません`);
  return prop.value;
}

function property(model: FbxNode, name: string): number[] | null {
  const p = child(model, 'Properties70')?.children.find((c) => propString(c.props[0]) === name);
  return p ? p.props.slice(4).map((x) => Number((x as { value: number }).value)) : null;
}

export function readBones(file: FbxFile): Map<string, Bone> {
  const objects = file.nodes.find((n) => n.name === 'Objects')!;
  const connections = file.nodes.find((n) => n.name === 'Connections')!;
  const models = new Map<bigint, FbxNode>();
  const curves = new Map<bigint, FbxNode>();
  const curveNodes = new Map<bigint, FbxNode>();
  for (const o of objects.children) {
    if (o.name === 'Model') models.set(id(o), o);
    else if (o.name === 'AnimationCurve') curves.set(id(o), o);
    else if (o.name === 'AnimationCurveNode') curveNodes.set(id(o), o);
  }
  const parentOf = new Map<bigint, bigint>();
  const rotationNodeOf = new Map<bigint, bigint>();
  const translationNodeOf = new Map<bigint, bigint>();
  const axes = new Map<bigint, FbxNode[]>();
  for (const c of connections.children) {
    const [kind, from, to, prop] = c.props;
    if (from?.type !== 'L' || to?.type !== 'L') continue;
    if (propString(kind) === 'OO' && models.has(from.value) && models.has(to.value)) parentOf.set(from.value, to.value);
    if (curveNodes.has(from.value) && models.has(to.value) && propString(prop) === 'Lcl Rotation') rotationNodeOf.set(to.value, from.value);
    if (curveNodes.has(from.value) && models.has(to.value) && propString(prop) === 'Lcl Translation') translationNodeOf.set(to.value, from.value);
    if (curves.has(from.value) && curveNodes.has(to.value)) {
      const index = ['d|X', 'd|Y', 'd|Z'].indexOf(propString(prop));
      if (index >= 0) {
        const list = axes.get(to.value) ?? [];
        list[index] = curves.get(from.value)!;
        axes.set(to.value, list);
      }
    }
  }
  const bones = new Map<string, Bone>();
  const byId = new Map<bigint, Bone>();
  for (const [modelId, model] of models) {
    const name = propString(model.props[1]).split('\0')[0].replace('mixamorig:', '');
    const t = property(model, 'Lcl Translation') ?? [0, 0, 0];
    const r = property(model, 'Lcl Rotation') ?? [0, 0, 0];
    const list = rotationNodeOf.has(modelId) ? axes.get(rotationNodeOf.get(modelId)!) : undefined;
    const moves = translationNodeOf.has(modelId) ? axes.get(translationNodeOf.get(modelId)!) : undefined;
    const values = (curve: FbxNode) => child(curve, 'KeyValueFloat')!.props[0].value as Float32Array;
    const bone: Bone = {
      name, parent: null,
      translation: new THREE.Vector3(...t),
      translationCurves: moves?.[0] && moves[1] && moves[2] ? [values(moves[0]), values(moves[1]), values(moves[2])] : null,
      rotation: list ? [values(list[0]), values(list[1]), values(list[2])] : null,
      setRotation: list ? (v) => list.forEach((curve, j) => {
        child(curve, 'KeyValueFloat')!.props[0] = { type: 'f', value: v[j] };
        const def = child(curve, 'Default');
        if (def) def.props[0] = { type: 'D', value: v[j][0] };
      }) : null,
      staticRotation: new THREE.Vector3(...r),
    };
    bones.set(name, bone);
    byId.set(modelId, bone);
  }
  for (const [childId, parentId] of parentOf) byId.get(childId)!.parent = byId.get(parentId) ?? null;
  return bones;
}

/** 回転順 XYZ（行列は Rz·Ry·Rx）は three.js の 'ZYX' */
export function localQuaternion(bone: Bone, frame: number): THREE.Quaternion {
  const [x, y, z] = bone.rotation ? bone.rotation.map((c) => c[Math.min(frame, c.length - 1)]) : bone.staticRotation.toArray();
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x / DEG, y / DEG, z / DEG, 'ZYX'));
}

function localTranslation(bone: Bone, frame: number): THREE.Vector3 {
  const t = bone.translationCurves
    ? new THREE.Vector3(...bone.translationCurves.map((c) => c[Math.min(frame, c.length - 1)]))
    : bone.translation.clone();
  return t.multiplyScalar(0.01);
}

/** フレームでの骨のワールドの位置（m。足元が原点・+x は左手側・+z は正面）と向き */
export function worldPose(bone: Bone, frame = 0): { position: THREE.Vector3; quaternion: THREE.Quaternion } {
  if (!bone.parent) return { position: localTranslation(bone, frame), quaternion: localQuaternion(bone, frame) };
  const parent = worldPose(bone.parent, frame);
  return {
    position: localTranslation(bone, frame).applyQuaternion(parent.quaternion).add(parent.position),
    quaternion: parent.quaternion.clone().multiply(localQuaternion(bone, frame)),
  };
}

