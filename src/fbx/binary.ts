/**
 * バイナリ FBX の読み書き。ノードの木をそのまま読み、配列を差し替えて書き戻す。
 * 書き戻すときはヘッダー・ノード・フッターの形を元のファイルに合わせる（FileId・CreationTime などはそのまま残す）
 */
import { unzlibSync, zlibSync } from 'three/examples/jsm/libs/fflate.module.js';

export type FbxArray = Float32Array | Float64Array | BigInt64Array | Int32Array | Uint8Array;
export type FbxProp =
  | { type: 'Y' | 'I' | 'F' | 'D'; value: number }
  | { type: 'C'; value: boolean }
  | { type: 'L'; value: bigint }
  | { type: 'S' | 'R'; value: Uint8Array }
  | { type: 'f' | 'd' | 'l' | 'i' | 'b'; value: FbxArray };

export interface FbxNode {
  name: string;
  props: FbxProp[];
  children: FbxNode[];
}

export interface FbxFile {
  version: number;
  nodes: FbxNode[];
  /** 最上位の終端の後ろ（フッター）。書き戻しでは位置合わせの詰め物だけ作り直す */
  footer: Uint8Array;
}

const MAGIC = 'Kaydara FBX Binary  \0';
const FOOTER_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOTER_MAGIC = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);

const decoder = new TextDecoder();

export function readFbx(buffer: ArrayBuffer): FbxFile {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (decoder.decode(bytes.subarray(0, 21)) !== MAGIC) throw new Error('バイナリ FBX ではありません');
  const version = view.getUint32(23, true);
  const wide = version >= 7500;
  let offset = 27;

  const readArray = (type: string): FbxArray => {
    const length = view.getUint32(offset, true);
    const encoding = view.getUint32(offset + 4, true);
    const compressed = view.getUint32(offset + 8, true);
    offset += 12;
    let raw = bytes.slice(offset, offset + compressed);
    offset += compressed;
    if (encoding === 1) raw = unzlibSync(raw);
    const data = raw.buffer;
    switch (type) {
      case 'f': return new Float32Array(data, 0, length);
      case 'd': return new Float64Array(data, 0, length);
      case 'l': return new BigInt64Array(data, 0, length);
      case 'i': return new Int32Array(data, 0, length);
      default: return new Uint8Array(data, 0, length);
    }
  };

  const readProp = (): FbxProp => {
    const type = String.fromCharCode(bytes[offset]);
    offset += 1;
    switch (type) {
      case 'Y': { const value = view.getInt16(offset, true); offset += 2; return { type, value }; }
      case 'C': { const value = bytes[offset] !== 0; offset += 1; return { type, value }; }
      case 'I': { const value = view.getInt32(offset, true); offset += 4; return { type, value }; }
      case 'F': { const value = view.getFloat32(offset, true); offset += 4; return { type, value }; }
      case 'D': { const value = view.getFloat64(offset, true); offset += 8; return { type, value }; }
      case 'L': { const value = view.getBigInt64(offset, true); offset += 8; return { type, value }; }
      case 'S':
      case 'R': {
        const length = view.getUint32(offset, true);
        const value = bytes.slice(offset + 4, offset + 4 + length);
        offset += 4 + length;
        return { type, value };
      }
      case 'f': case 'd': case 'l': case 'i': case 'b':
        return { type, value: readArray(type) };
      default:
        throw new Error(`FBX の値の種類 ${type} は読めません`);
    }
  };

  const readNode = (): FbxNode | null => {
    const end = wide ? Number(view.getBigUint64(offset, true)) : view.getUint32(offset, true);
    const count = wide ? Number(view.getBigUint64(offset + 8, true)) : view.getUint32(offset + 4, true);
    offset += wide ? 24 : 12;
    const nameLength = bytes[offset];
    offset += 1;
    if (end === 0) return null;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const props: FbxProp[] = [];
    for (let i = 0; i < count; i++) props.push(readProp());
    const children: FbxNode[] = [];
    while (offset < end) {
      const child = readNode();
      if (!child) break;
      children.push(child);
    }
    offset = end;
    return { name, props, children };
  };

  const nodes: FbxNode[] = [];
  for (;;) {
    const node = readNode();
    if (!node) break;
    nodes.push(node);
  }
  return { version, nodes, footer: bytes.slice(offset) };
}

/** 書き出し。配列は zlib で縮める */
export function writeFbx(file: FbxFile): Uint8Array<ArrayBuffer> {
  const wide = file.version >= 7500;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (chunk: Uint8Array) => {
    chunks.push(chunk);
    size += chunk.length;
  };
  const scalar = (length: number, set: (view: DataView) => void) => {
    const chunk = new Uint8Array(length);
    set(new DataView(chunk.buffer));
    push(chunk);
  };
  const encoder = new TextEncoder();

  const header = new Uint8Array(27);
  header.set(encoder.encode(MAGIC));
  header[21] = 0x1a;
  new DataView(header.buffer).setUint32(23, file.version, true);
  push(header);

  const writeProp = (prop: FbxProp) => {
    push(new Uint8Array([prop.type.charCodeAt(0)]));
    switch (prop.type) {
      case 'Y': scalar(2, (v) => v.setInt16(0, prop.value, true)); break;
      case 'C': push(new Uint8Array([prop.value ? 1 : 0])); break;
      case 'I': scalar(4, (v) => v.setInt32(0, prop.value, true)); break;
      case 'F': scalar(4, (v) => v.setFloat32(0, prop.value, true)); break;
      case 'D': scalar(8, (v) => v.setFloat64(0, prop.value, true)); break;
      case 'L': scalar(8, (v) => v.setBigInt64(0, prop.value, true)); break;
      case 'S':
      case 'R':
        scalar(4, (v) => v.setUint32(0, prop.value.length, true));
        push(prop.value);
        break;
      default: {
        const raw = new Uint8Array(prop.value.buffer, prop.value.byteOffset, prop.value.byteLength);
        const packed = zlibSync(raw);
        scalar(12, (v) => {
          v.setUint32(0, prop.value.length, true);
          v.setUint32(4, 1, true);
          v.setUint32(8, packed.length, true);
        });
        push(packed);
      }
    }
  };

  const nullRecord = () => push(new Uint8Array(wide ? 25 : 13));

  const writeNode = (node: FbxNode) => {
    const head = new Uint8Array((wide ? 24 : 12) + 1 + node.name.length);
    const headView = new DataView(head.buffer);
    push(head);
    const start = size;
    const propsStart = size;
    for (const prop of node.props) writeProp(prop);
    const propsLength = size - propsStart;
    for (const child of node.children) writeNode(child);
    // 子のあるノード・値のないノードは終端の空レコードで閉じる
    if (node.children.length > 0 || node.props.length === 0) nullRecord();
    const end = size;
    const headStart = start - head.length;
    if (wide) {
      headView.setBigUint64(0, BigInt(end), true);
      headView.setBigUint64(8, BigInt(node.props.length), true);
      headView.setBigUint64(16, BigInt(propsLength), true);
    } else {
      headView.setUint32(0, end, true);
      headView.setUint32(4, node.props.length, true);
      headView.setUint32(8, propsLength, true);
    }
    head[wide ? 24 : 12] = node.name.length;
    head.set(encoder.encode(node.name), (wide ? 24 : 12) + 1);
    void headStart;
  };

  for (const node of file.nodes) writeNode(node);
  nullRecord();

  // フッター: 識別子、16 バイト境界までの詰め物（ちょうどなら 16）、版、120 バイトの 0、末尾の印
  push(FOOTER_ID);
  const pad = ((size + 15) & ~15) - size || 16;
  push(new Uint8Array(pad));
  scalar(4, (v) => v.setUint32(0, file.version, true));
  push(new Uint8Array(120));
  push(FOOTER_MAGIC);

  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export function child(node: FbxNode, name: string): FbxNode | undefined {
  return node.children.find((c) => c.name === name);
}

export function propString(prop: FbxProp | undefined): string {
  return prop && (prop.type === 'S' || prop.type === 'R') ? decoder.decode(prop.value) : '';
}
