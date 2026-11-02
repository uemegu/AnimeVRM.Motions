import * as THREE from 'three';
import type { FbxFile, FbxNode } from './binary.ts';
import { DEG, type Bone, localQuaternion, readBones, worldPose } from './skeleton.ts';

export interface ContactProfile {
  /** 腰を下げる量（m）。元の床基準で体表面を接地させる。 */
  lowerHips: number;
  /** 寝姿の腰〜胸の軸を水平へ近づける。胸や腰自体の反りは残す。 */
  levelTorso?: boolean;
  /** 伸ばした脚も接地させる（上げた脚・曲げた膝は維持する）。 */
  restStraightLegs?: boolean;
  /** 布団の小物を避ける表示位置の調整。FBX には含めない。 */
  bedOffsetX?: number;
  bedOffsetZ?: number;
  /** 女の子座りの足首と膝。膝の高さだけから左右の開きを決めない。 */
  foldedLegs?: { ankleX: number; ankleZ: number; ankleY: number; kneeY: number };
  /** 支える手が届くよう、胴の3本の骨へ分配する追加の前後傾・左右傾（度）。 */
  torsoLean?: [number, number];
  /** 支えるために胴を倒しても、説明にない大きな顔の向きの変化を付けない。 */
  keepHeadFacing?: boolean;
  /** 説明文にある支持点。Left/Right はキャラクター自身の左右。 */
  hands?: Partial<Record<'Left' | 'Right',
    | { surface: 'bed'; position: [number, number, number]; forward?: [number, number] }
    | { surface: 'thigh'; leg: 'Left' | 'Right'; along: number; height: number }
  >>;
}

type Pose = ReturnType<typeof worldPose>;
interface Chain { upper: Bone; lower: Bone; end: Bone; a: Pose; b: Pose; c: Pose }
const UP = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);

/** motion-create と同じく、骨の長軸と屈曲面の二軸から回転を決める。 */
function framedRotation(reference: THREE.Quaternion, from: THREE.Vector3, to: THREE.Vector3, normal: THREE.Vector3) {
  const rotation = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize()).multiply(reference);
  const axis = to.clone().normalize();
  const current = X.clone().applyQuaternion(rotation).addScaledVector(axis, -X.clone().applyQuaternion(rotation).dot(axis)).normalize();
  const desired = normal.clone().addScaledVector(axis, -normal.dot(axis)).normalize();
  const angle = Math.atan2(axis.dot(current.clone().cross(desired)), current.dot(desired));
  return new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(rotation);
}

function wristAngles(lower: THREE.Quaternion, hand: THREE.Quaternion, bone: Bone) {
  const rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(...bone.staticRotation.toArray().map(v => v / DEG) as [number, number, number], 'ZYX'));
  const q = rest.invert().multiply(lower.clone().invert().multiply(hand));
  if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const twist = new THREE.Quaternion(0, q.y, 0, q.w).normalize();
  const swing = q.clone().multiply(twist.clone().invert());
  return { swing: 2 * Math.acos(Math.min(1, Math.abs(swing.w))) * DEG, twist: 2 * Math.atan2(twist.y, twist.w) * DEG };
}

function palmRotation(bones: Map<string, Bone>, side: string, forward: THREE.Vector3, surfaceNormal = UP) {
  const hand = worldPose(bones.get(`${side}Hand`)!);
  const index = worldPose(bones.get(`${side}HandIndex1`)!).position.sub(hand.position);
  const pinky = worldPose(bones.get(`${side}HandPinky1`)!).position.sub(hand.position);
  // T ポーズの掌は下向き。左右で指の並び順が反転する。
  const normal = index.clone().cross(pinky).normalize().multiplyScalar(side === 'Left' ? -1 : 1);
  const along = index.add(pinky).normalize();
  const across = along.clone().cross(normal).normalize();
  along.copy(normal).cross(across).normalize();
  const desiredNormal = surfaceNormal.clone().normalize().negate();
  forward = forward.clone().addScaledVector(desiredNormal, -forward.dot(desiredNormal)).normalize();
  const desiredAcross = forward.clone().cross(desiredNormal).normalize();
  const from = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, along, normal));
  const to = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(desiredAcross, forward, desiredNormal));
  return to.multiply(from.invert()).multiply(hand.quaternion);
}

function flattenFingers(bones: Map<string, Bone>, side: string, surfaceNormal: THREE.Vector3) {
  for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
    for (let segment = 1; segment <= 3; segment++) {
      const bone = bones.get(`${side}Hand${finger}${segment}`)!;
      const next = bones.get(`${side}Hand${finger}${segment + 1}`);
      if (!next) continue;
      const pose = worldPose(bone);
      const direction = worldPose(next).position.sub(pose.position).normalize();
      const flat = direction.clone().addScaledVector(surfaceNormal, -direction.dot(surfaceNormal)).normalize();
      const rotation = new THREE.Quaternion().setFromUnitVectors(direction, flat).multiply(pose.quaternion);
      holdRotation(bone, worldPose(bone.parent!).quaternion.invert().multiply(rotation));
    }
  }
}

function holdRotation(bone: Bone, rotation: THREE.Quaternion) {
  if (!bone.rotation || !bone.setRotation) throw new Error(`${bone.name} に回転曲線がありません`);
  const e = new THREE.Euler().setFromQuaternion(rotation, 'ZYX');
  const angles = [e.x, e.y, e.z].map((v, axis) => {
    const degrees = v * DEG;
    return degrees - 360 * Math.round((degrees - bone.rotation![axis][0]) / 360);
  });
  const curves = bone.rotation.map((c, axis) => new Float32Array(c.length).fill(angles[axis])) as [Float32Array, Float32Array, Float32Array];
  bone.setRotation(curves);
  bone.rotation = curves;
}

function chain(bones: Map<string, Bone>, names: string[]): Chain {
  const [upper, lower, end] = names.map((name) => bones.get(name)!);
  return { upper, lower, end, a: worldPose(upper), b: worldPose(lower), c: worldPose(end) };
}

/** 二本の骨を届く範囲で合わせる。脚は膝の高さを保ち、下げた腰を床の下の膝で支えない。 */
function reach(chain: Chain, target: THREE.Vector3, kneeHeight?: number, endRotation = chain.c.quaternion,
  options: { hinge?: boolean; maxFlex?: number; wristLimit?: boolean } = {}) {
  const { upper, lower, end, a, b, c } = chain;
  const start = worldPose(upper).position;
  const upperLength = a.position.distanceTo(b.position), lowerLength = b.position.distanceTo(c.position);
  const direction = target.clone().sub(start);
  const minimum = Math.max(Math.abs(upperLength - lowerLength) + 1e-5,
    options.maxFlex === undefined ? 0 : Math.sqrt(upperLength ** 2 + lowerLength ** 2 + 2 * upperLength * lowerLength * Math.cos(options.maxFlex / DEG)));
  const distance = THREE.MathUtils.clamp(direction.length(), minimum, upperLength + lowerLength - 1e-5);
  direction.normalize();
  const along = (upperLength ** 2 + distance ** 2 - lowerLength ** 2) / (2 * distance);
  const radius = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const center = start.clone().addScaledVector(direction, along);
  const pole = b.position.clone().sub(a.position);
  pole.addScaledVector(direction, -pole.dot(direction));
  if (pole.lengthSq() < 1e-10) pole.copy(UP).addScaledVector(direction, -direction.y);
  if (pole.lengthSq() < 1e-10) pole.set(1, 0, 0);
  pole.normalize();
  let joint = center.clone().addScaledVector(pole, radius);
  if (kneeHeight !== undefined && radius > 1e-5) {
    const vertical = UP.clone().addScaledVector(direction, -direction.y);
    if (vertical.lengthSq() > 1e-8) {
      vertical.normalize();
      const side = direction.clone().cross(vertical).normalize();
      const rise = THREE.MathUtils.clamp((kneeHeight - center.y) / (radius * vertical.y), -1, 1);
      const spread = Math.sqrt(Math.max(0, 1 - rise * rise));
      const first = center.clone().addScaledVector(vertical, radius * rise).addScaledVector(side, radius * spread);
      const second = center.clone().addScaledVector(vertical, radius * rise).addScaledVector(side, -radius * spread);
      joint = first.distanceToSquared(b.position) <= second.distanceToSquared(b.position) ? first : second;
    }
  }
  const reached = start.clone().addScaledVector(direction, distance);
  // 手首を折って届かせず、肘の円周上で元の曲がる側に近い、手首の無理の少ない位置を選ぶ。
  if (options.wristLimit && radius > 1e-5) {
    const side = direction.clone().cross(pole).normalize();
    let best = Infinity;
    for (let degrees = -180; degrees < 180; degrees += 3) {
      const angle = degrees / DEG;
      const candidate = center.clone().addScaledVector(pole, radius * Math.cos(angle)).addScaledVector(side, radius * Math.sin(angle));
      const lowerWorld = new THREE.Quaternion().setFromUnitVectors(c.position.clone().sub(b.position).normalize(), reached.clone().sub(candidate).normalize()).multiply(b.quaternion);
      const wrist = wristAngles(lowerWorld, endRotation, end);
      const cost = candidate.distanceToSquared(b.position) + 10 * Math.max(0, wrist.swing - 82) ** 2;
      if (cost < best) { best = cost; joint = candidate; }
    }
  }
  let upperWorld = new THREE.Quaternion().setFromUnitVectors(
    b.position.clone().sub(a.position).normalize(), joint.clone().sub(start).normalize(),
  ).multiply(a.quaternion);
  let lowerWorld = new THREE.Quaternion().setFromUnitVectors(
    c.position.clone().sub(b.position).normalize(), reached.clone().sub(joint).normalize(),
  ).multiply(b.quaternion);
  if (options.hinge) {
    const upperDirection = joint.clone().sub(start).normalize(), lowerDirection = reached.clone().sub(joint).normalize();
    const normal = lowerDirection.clone().cross(upperDirection).normalize();
    upperWorld = framedRotation(a.quaternion, b.position.clone().sub(a.position), upperDirection, normal);
    lowerWorld = framedRotation(b.quaternion, c.position.clone().sub(b.position), lowerDirection, normal);
  }
  if (options.wristLimit) {
    const { twist } = wristAngles(lowerWorld, endRotation, end);
    // 回内・回外を前腕へ配分し、手首に長軸回りのねじれを集中させない。
    lowerWorld.multiply(new THREE.Quaternion().setFromAxisAngle(Y, (twist - THREE.MathUtils.clamp(twist, -35, 35)) / DEG));
  }
  const parent = upper.parent ? worldPose(upper.parent).quaternion : new THREE.Quaternion();
  holdRotation(upper, parent.invert().multiply(upperWorld));
  holdRotation(lower, upperWorld.clone().invert().multiply(lowerWorld));
  holdRotation(end, lowerWorld.clone().invert().multiply(endRotation));
}

/** 床基準のポーズを接地させる。ベッドの位置・高さはここには含めない。 */
export function withContact(file: FbxFile, profile?: ContactProfile): FbxFile {
  if (!profile) return file;
  const clone = (node: FbxNode): FbxNode => ({ ...node, props: [...node.props], children: node.children.map(clone) });
  const copy: FbxFile = { ...file, nodes: file.nodes.map(clone) };
  const bones = readBones(copy);
  const hips = bones.get('Hips')!;
  const beforeHips = worldPose(hips);
  const headFacing = profile.keepHeadFacing ? worldPose(bones.get('Head')!).quaternion : null;
  const legs = ['Left', 'Right'].map((side) => ({
    chain: chain(bones, [`${side}UpLeg`, `${side}Leg`, `${side}Foot`]),
    toe: worldPose(bones.get(`${side}ToeBase`)!).position,
  }));
  const arms = ['Left', 'Right'].map((side) => ({
    chain: chain(bones, [`${side}Arm`, `${side}ForeArm`, `${side}Hand`]),
    tipBones: [...bones.values()].filter((bone) => bone.name.startsWith(`${side}Hand`)),
  }));
  const oldTips = arms.map((arm) => arm.tipBones.map((bone) => worldPose(bone).position));
  const lapSupports = arms.map((arm) => {
    const candidates = legs.map((leg) => {
      const line = new THREE.Line3(leg.chain.a.position, leg.chain.b.position);
      const t = line.closestPointToPointParameter(arm.chain.c.position, true);
      const offset = arm.chain.c.position.clone().sub(line.at(t, new THREE.Vector3()));
      return { leg: leg.chain, t, offset, distance: offset.length() };
    }).sort((a, b) => a.distance - b.distance);
    return candidates[0].distance < 0.16 ? candidates[0] : null;
  });

  if (profile.levelTorso) {
    const axis = worldPose(bones.get('Spine2')!).position.sub(beforeHips.position).normalize();
    const horizontal = axis.clone().setY(0).normalize();
    const correction = new THREE.Quaternion().setFromUnitVectors(axis, horizontal);
    const parent = hips.parent ? worldPose(hips.parent).quaternion : new THREE.Quaternion();
    holdRotation(hips, parent.clone().invert().multiply(correction).multiply(parent).multiply(localQuaternion(hips, 0)));
  }
  if (!hips.translationCurves || !hips.setTranslation) throw new Error('腰の移動曲線がありません');
  const offset = new THREE.Vector3(0, -profile.lowerHips, 0);
  if (hips.parent) offset.applyQuaternion(worldPose(hips.parent).quaternion.invert());
  const curves = hips.translationCurves.map((c, axis) => new Float32Array(c.length).fill(c[0] + offset.getComponent(axis) * 100)) as [Float32Array, Float32Array, Float32Array];
  hips.setTranslation(curves);
  hips.translationCurves = curves;

  if (profile.torsoLean) {
    const [pitch, roll] = profile.torsoLean;
    for (const [name, fraction] of [['Spine', 0.5], ['Spine1', 0.3], ['Spine2', 0.2]] as const) {
      const bone = bones.get(name)!;
      const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * fraction / DEG, 0, roll * fraction / DEG, 'XYZ'));
      const parent = worldPose(bone.parent!).quaternion;
      holdRotation(bone, parent.clone().invert().multiply(turn).multiply(parent).multiply(localQuaternion(bone, 0)));
    }
  }
  if (headFacing) {
    for (const [name, fraction] of [['Neck', 0.6], ['Head', 1]] as const) {
      const bone = bones.get(name)!;
      const error = headFacing.clone().multiply(worldPose(bones.get('Head')!).quaternion.invert());
      const turn = new THREE.Quaternion().slerp(error, fraction);
      const world = turn.multiply(worldPose(bone).quaternion);
      holdRotation(bone, worldPose(bone.parent!).quaternion.invert().multiply(world));
    }
  }

  for (const [index, leg] of legs.entries()) {
    const { a, b, c } = leg.chain;
    const target = c.position.clone().add(new THREE.Vector3(0, -profile.lowerHips, 0));
    const straight = b.position.clone().sub(a.position).normalize().dot(c.position.clone().sub(b.position).normalize()) > 0.9;
    const lyingFlat = profile.restStraightLegs && straight && Math.abs(c.position.y - a.position.y) < 0.25;
    // 足の向きは保ち、踵とつま先が床へ沈まない高さにする。
    const footFloor = Math.max(0.055, 0.03 - (leg.toe.y - c.position.y));
    target.y = lyingFlat ? footFloor : Math.max(target.y, footFloor);
    const knee = lyingFlat ? 0.06 : Math.max(0.06, b.position.y - profile.lowerHips);
    if (profile.foldedLegs) {
      const folded = profile.foldedLegs;
      target.set((index === 0 ? 1 : -1) * folded.ankleX, folded.ankleY, folded.ankleZ);
      reach(leg.chain, target, folded.kneeY, undefined, { hinge: true, maxFlex: 160 });
    } else reach(leg.chain, target, knee);
  }
  for (const [index, arm] of arms.entries()) {
    const side = index === 0 ? 'Left' : 'Right';
    const support = profile.hands?.[side];
    if (support) {
      let target: THREE.Vector3, forward: THREE.Vector3;
      let normal = UP.clone();
      if (support.surface === 'bed') {
        target = new THREE.Vector3(...support.position);
        forward = new THREE.Vector3(support.forward?.[0] ?? 0, 0, support.forward?.[1] ?? 1);
      } else {
        const thigh = legs[support.leg === 'Left' ? 0 : 1].chain;
        const a = worldPose(thigh.upper).position, b = worldPose(thigh.lower).position;
        forward = b.clone().sub(a).normalize();
        normal.addScaledVector(forward, -normal.dot(forward)).normalize();
        target = a.clone().lerp(b, support.along).addScaledVector(normal, support.height);
      }
      const current = { ...arm.chain, a: worldPose(arm.chain.upper), b: worldPose(arm.chain.lower), c: worldPose(arm.chain.end) };
      const rotation = palmRotation(bones, side, forward, normal);
      reach(current, target, undefined, rotation, { maxFlex: 155, wristLimit: true });
      flattenFingers(bones, side, normal);
      // 明示した支持点を、近くの腿だという推測で持ち上げない。
      continue;
    }
    const supported = Math.min(...oldTips[index].map((tip) => tip.y)) < 0.14;
    const lap = lapSupports[index];
    if (supported) {
      reach(arm.chain, arm.chain.c.position);
    } else if (lap) {
      // 脚を開き直したとき、膝・腿の上の手も、その脚に対する位置と向きに合わせる。
      const a = worldPose(lap.leg.upper), b = worldPose(lap.leg.lower);
      const turn = a.quaternion.clone().multiply(lap.leg.a.quaternion.clone().invert());
      const target = a.position.clone().lerp(b.position, lap.t).add(lap.offset.clone().applyQuaternion(turn));
      reach(arm.chain, target, undefined, turn.multiply(arm.chain.c.quaternion));
    }
    const after = worldPose(arm.chain.end).position;
    const tips = arm.tipBones.map((bone) => worldPose(bone).position);
    let lift = Math.max(0, 0.025 - Math.min(...tips.map((tip) => tip.y)));
    // 腰を下げても、膝に置いた手は太ももの表面より下へ落とさない。
    for (const leg of legs) {
      const a = worldPose(leg.chain.upper).position, b = worldPose(leg.chain.lower).position;
      const dx = b.x - a.x, dz = b.z - a.z;
      const lengthSq = dx * dx + dz * dz;
      for (const tip of tips) {
        const t = lengthSq > 1e-8 ? THREE.MathUtils.clamp(((tip.x - a.x) * dx + (tip.z - a.z) * dz) / lengthSq, 0, 1) : 0;
        const distanceSq = (tip.x - a.x - dx * t) ** 2 + (tip.z - a.z - dz * t) ** 2;
        if (distanceSq < 0.075 ** 2) {
          const top = THREE.MathUtils.lerp(a.y, b.y, t) + Math.sqrt(0.075 ** 2 - distanceSq);
          lift = Math.max(lift, top + 0.015 - tip.y);
        }
      }
    }
    if (lift > 0) {
      const current = { ...arm.chain, a: worldPose(arm.chain.upper), b: worldPose(arm.chain.lower), c: worldPose(arm.chain.end) };
      reach(current, after.clone().addScaledVector(UP, lift));
    }
  }
  return copy;
}
