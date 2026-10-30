/**
 * ポーズの FBX から、motion-create が混ぜた待機モーションの呼吸を抜く。
 * 回転・移動のすべての曲線を 1 フレーム目（呼吸のない姿勢）の値にそろえる。呼吸はサイトで式から付ける（src/fbx/breath.ts）。
 *
 * 使い方: node scripts/strip_breath.ts [FBX のフォルダ（既定は public/motions）]
 * フォルダの *.fbx をその場で書き換える。何度当てても同じ結果になる
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type FbxNode, child, readFbx, writeFbx } from '../src/fbx/binary.ts';

function holdFirstFrame(curve: FbxNode) {
  const values = child(curve, 'KeyValueFloat')?.props[0];
  if (values?.type !== 'f') throw new Error('KeyValueFloat がありません');
  const held = new Float32Array((values.value as Float32Array).length).fill((values.value as Float32Array)[0]);
  child(curve, 'KeyValueFloat')!.props[0] = { type: 'f', value: held };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'public/motions';
  const names = readdirSync(dir).filter((name) => name.endsWith('.fbx'));
  for (const name of names) {
    const buffer = readFileSync(`${dir}/${name}`);
    const file = readFbx(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    const objects = file.nodes.find((n) => n.name === 'Objects');
    if (!objects) throw new Error(`${name} に Objects がありません`);
    for (const node of objects.children) if (node.name === 'AnimationCurve') holdFirstFrame(node);
    writeFileSync(`${dir}/${name}`, writeFbx(file));
  }
  console.log(`${names.length} 本`);
}
