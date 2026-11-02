import * as THREE from 'three';
import { BED } from './sets/painted-aoi-room/layout.ts';
import contactProfiles from './contactProfiles.json' with { type: 'json' };

export interface PreviewPose {
  box: THREE.Box3;
  head: THREE.Vector3;
  hips: THREE.Vector3;
}

export interface PreviewPlacement {
  position: THREE.Vector3;
  rotationY: number;
  onBed: boolean;
  lying: boolean;
}

/** プレビュー内の配置。FBX 自体の位置・向きには手を加えない。 */
export function previewPlacement(
  motion: { id: string; category: string; name: string },
  pose: PreviewPose,
  roomPosition: { x: number; y: number; z: number },
): PreviewPlacement {
  const lying = motion.category === '寝そべり';
  const onBed = lying || motion.category.includes('座り') || motion.name.includes('座って');
  if (!onBed) return { position: new THREE.Vector3(), rotationY: 0, onBed: false, lying: false };

  // 横向き寝・うつ伏せも、腰から頭への向きをベッドの枕側（-z）に揃える。
  const toHead = pose.head.clone().sub(pose.hips);
  const rotationY = lying ? Math.atan2(toHead.x, -toHead.z) : 0;
  const center = pose.box.getCenter(new THREE.Vector3()).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
  const profile = (contactProfiles as Record<string, { bedOffsetX?: number; bedOffsetZ?: number }>)[motion.id];
  return {
    position: new THREE.Vector3(
      roomPosition.x + (BED.minX + BED.maxX) / 2 - center.x + (profile?.bedOffsetX ?? 0),
      roomPosition.y + BED.top,
      // 枕には高さがあるので、寝そべりは少し足元寄りに置いて顔の埋まりを避ける。
      roomPosition.z + (BED.headZ + BED.footZ) / 2 - center.z + (lying ? 0.2 : 0) + (profile?.bedOffsetZ ?? 0),
    ),
    rotationY,
    onBed: true,
    lying,
  };
}
