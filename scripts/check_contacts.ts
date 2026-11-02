/** 説明文の支持点・膝の曲がる面を、配布元 FBX と保存時の FBX で確認する。 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { readFbx, writeFbx } from '../src/fbx/binary.ts';
import { withContact, type ContactProfile } from '../src/fbx/contact.ts';
import { withBreath } from '../src/fbx/breath.ts';
import { DEG, localQuaternion, readBones, worldPose } from '../src/fbx/skeleton.ts';
import { previewPlacement } from '../src/previewPlacement.ts';
import { BED, STANDING_ORIGIN } from '../src/sets/painted-aoi-room/layout.ts';

const profiles = JSON.parse(readFileSync(new URL('../src/contactProfiles.json', import.meta.url), 'utf8')) as Record<string, ContactProfile>;
const motions = JSON.parse(readFileSync(new URL('../src/motions.json', import.meta.url), 'utf8'));
const ids = ['full_P001', 'full_P002', 'full_P041', 'full_P042', 'full_P044', 'full_P046', 'full_P047', 'full_P048'];
const floorHands: Record<string, string[]> = {
  full_P001: ['Right'], full_P002: ['Right'], full_P042: ['Left', 'Right'],
  full_P044: ['Left', 'Right'], full_P046: ['Right'], full_P047: ['Right'],
};
const lapHands: Record<string, string[]> = { full_P041: ['Left', 'Right'], full_P048: ['Right'] };
const folded = new Set(['full_P041', 'full_P042', 'full_P044', 'full_P048']);
const UP = new THREE.Vector3(0, 1, 0);
let maxWristDrift = 0, maxWristSwing = 0, maxKneePlane = 0;

for (const id of ids) {
  const data = readFileSync(new URL(`../public/motions/${id}.fbx`, import.meta.url));
  const source = readFbx(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  const unchanged = writeFbx(source);
  const corrected = withContact(source, profiles[id]);
  assert.deepEqual(writeFbx(source), unchanged, `${id}: source changed`);
  const before = readBones(source), bones = readBones(corrected);
  const pose = (name: string, frame = 0, map = bones) => worldPose(map.get(name)!, frame);
  const position = (name: string) => pose(name).position;

  for (const bone of bones.values()) {
    assert(position(bone.name).toArray().every(Number.isFinite), `${id}: finite positions`);
    if (bone.parent) {
      const originalLength = worldPose(before.get(bone.name)!).position.distanceTo(worldPose(before.get(bone.parent.name)!).position);
      assert(Math.abs(position(bone.name).distanceTo(position(bone.parent.name)) - originalLength) < 1e-7, `${id}: ${bone.name} length`);
    }
  }
  for (const side of floorHands[id] ?? []) {
    const height = position(`${side}Hand`).y;
    assert(height >= 0 && height < 0.04, `${id}: ${side} supporting wrist near mattress surface`);
    const points = ['Hand', 'HandIndex1', 'HandIndex4', 'HandPinky1', 'HandPinky4'].map(n => position(side + n));
    assert(Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) < 0.002, `${id}: palm and fingers on plane`);
    if (id === 'full_P042') assert(position(side + 'Hand').z > Math.max(position('LeftLeg').z, position('RightLeg').z) + 0.05, 'P042: both hands ahead of knees');
    if (id === 'full_P044') assert(position(side + 'Hand').z < position('Hips').z - 0.15, 'P044: hands behind body');
  }
  for (const side of lapHands[id] ?? []) {
    const line = new THREE.Line3(position(side + 'UpLeg'), position(side + 'Leg'));
    const wrist = position(side + 'Hand');
    const t = line.closestPointToPointParameter(wrist, false);
    assert(t > 0.25 && t < 0.7, `${id}: ${side} hand above middle of own thigh`);
    const normal = line.closestPointToPoint(wrist, true, new THREE.Vector3()).sub(wrist).negate();
    assert(normal.y > 0.035 && normal.length() < 0.12, `${id}: hand on top of thigh`);
    const along = position(side + 'HandIndex4').sub(wrist).normalize();
    assert(along.dot(line.end.clone().sub(line.start).normalize()) > 0.8, `${id}: fingers follow thigh`);
  }
  if (id === 'full_P048') {
    const oldOffset = worldPose(before.get('LeftHand')!).position.sub(worldPose(before.get('Head')!).position);
    assert(position('LeftHand').sub(position('Head')).distanceTo(oldOffset) < 1e-5, 'P048: other hand remains at neck');
  }
  if (folded.has(id)) for (const side of ['Left', 'Right']) {
    const thigh = position(side + 'Leg').sub(position(side + 'UpLeg')).normalize();
    const shin = position(side + 'Foot').sub(position(side + 'Leg')).normalize();
    const normal = thigh.clone().cross(shin).normalize();
    const hinge = new THREE.Vector3(1, 0, 0).applyQuaternion(pose(side + 'UpLeg').quaternion);
    const plane = Math.acos(Math.min(1, Math.abs(normal.dot(hinge)))) * DEG;
    maxKneePlane = Math.max(maxKneePlane, plane);
    assert(plane < 0.01, `${id}: knee bends in thigh hinge plane`);
    assert(thigh.angleTo(shin) * DEG < 160.01, `${id}: knee flexion`);
    assert(position(side + 'Foot').y > 0.06 && position(side + 'Leg').y > 0.05, `${id}: legs above mattress`);
    assert(Math.abs(position(side + 'Foot').x) > Math.abs(position(side + 'Leg').x) + 0.08, `${id}: feet outside knees`);
  }
  const box = new THREE.Box3().setFromPoints([...bones.keys()].map(position)).expandByScalar(0.1);
  box.min.y = Math.max(0, box.min.y);
  const room = { x: -STANDING_ORIGIN[0], y: 0, z: -STANDING_ORIGIN[2] - 0.55 };
  const placement = previewPlacement(motions.find((m: { id: string }) => m.id === id), { box, head: position('Head'), hips: position('Hips') }, room);
  const placed = box.clone().translate(placement.position);
  assert(placed.min.x > BED.minX + room.x - 0.01 && placed.max.x < BED.maxX + room.x + 0.01, `${id}: bed width`);
  assert(placed.min.z > BED.headZ + room.z && placed.max.z < BED.footZ + room.z, `${id}: bed length`);

  for (const strength of [0, 0.8, 1.5]) {
    const bytes = writeFbx(withBreath(corrected, strength));
    const saved = readBones(readFbx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    for (let frame = 0; frame < 180; frame++) for (const side of Object.keys(profiles[id].hands!)) {
      const hand = saved.get(side + 'Hand')!;
      const drift = worldPose(hand, frame).position.distanceTo(worldPose(hand, 0).position);
      maxWristDrift = Math.max(maxWristDrift, drift);
      assert(drift < 0.001, `${id}: support drifts with breathing`);
      const rest = new THREE.Quaternion().setFromEuler(new THREE.Euler(...hand.staticRotation.toArray().map(v => v / DEG) as [number, number, number], 'ZYX'));
      const q = rest.invert().multiply(localQuaternion(hand, frame));
      if (q.w < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      const twist = new THREE.Quaternion(0, q.y, 0, q.w).normalize();
      const swing = 2 * Math.acos(Math.min(1, Math.abs(q.clone().multiply(twist.clone().invert()).w))) * DEG;
      maxWristSwing = Math.max(maxWristSwing, swing);
      assert(swing < 85 && Math.abs(2 * Math.atan2(twist.y, twist.w) * DEG) < 40, `${id}: wrist range`);
      const a = worldPose(saved.get(side + 'Arm')!, frame).position, b = worldPose(saved.get(side + 'ForeArm')!, frame).position, c = worldPose(hand, frame).position;
      assert(b.clone().sub(a).angleTo(c.clone().sub(b)) * DEG < 155.01, `${id}: elbow flexion`);
    }
  }
}
console.log(`8 姿勢の支持点・骨長・ベッド内の配置・FBX 読み戻しを確認。呼吸 0/80/150%: 手首の最大移動 ${(maxWristDrift * 1000).toFixed(3)} mm、手首屈曲の最大 ${maxWristSwing.toFixed(1)}°、膝屈曲面のずれ ${maxKneePlane.toFixed(5)}°。`);
