import { describe, expect, test } from 'vitest';
import { writeMp4, type Mp4Sample } from '../../src/offline/mp4';

/** 顶层的盒子：类型和范围（mdat 用 64 位的大小）。 */
function topBoxes(file: Uint8Array): { type: string; start: number; end: number }[] {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const boxes = [];
  for (let at = 0; at < file.length;) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(...file.subarray(at + 4, at + 8));
    if (size === 1) size = Number(view.getBigUint64(at + 8));
    boxes.push({ type, start: at, end: at + size });
    at += size;
  }
  return boxes;
}

/** 在 bytes 里找盒子类型第一次出现的位置（类型的四个字节）。 */
function find(bytes: Uint8Array, type: string, from = 0): number {
  const code = Array.from(type, (c) => c.charCodeAt(0));
  for (let i = from; i < bytes.length - 4; i++) if (code.every((c, k) => bytes[i + k] === c)) return i;
  return -1;
}

describe('MP4 封装', () => {
  const sample = (byte: number, length: number, time: number, keyframe: boolean): Mp4Sample => ({ data: new Uint8Array(length).fill(byte), time, duration: 1000, keyframe });

  test('ftyp、mdat、moov；co64 指向每个样本在 mdat 里的字节；没有 B 帧时不写 ctts', () => {
    const video = [sample(1, 10, 0, true), sample(2, 20, 1000, false), sample(3, 30, 2000, false)];
    const audio = [sample(9, 5, 0, true), sample(8, 5, 1024, true)];
    const file = writeMp4({
      video: { width: 1920, height: 1080, timescale: 30000, avcC: new Uint8Array([1, 0x64, 0, 0x28]), samples: video },
      audio: { codec: 'aac', sampleRate: 48000, channels: 2, samples: audio.map((s) => ({ ...s, duration: 1024 })) },
    });
    expect(topBoxes(file).map((b) => b.type)).toEqual(['ftyp', 'mdat', 'moov']);
    const view = new DataView(file.buffer);
    // 第一条轨的 co64：3 个偏移，各自指向填了 1、2、3 的样本
    const co64 = find(file, 'co64');
    expect(view.getUint32(co64 + 8)).toBe(3);
    const offsets = [0, 1, 2].map((i) => Number(view.getBigUint64(co64 + 12 + i * 8)));
    expect(offsets.map((o) => file[o])).toEqual([1, 2, 3]);
    // 音频轨的 co64 指向填了 9、8 的块
    const audioCo64 = find(file, 'co64', co64 + 4);
    expect([0, 1].map((i) => file[Number(view.getBigUint64(audioCo64 + 12 + i * 8))])).toEqual([9, 8]);
    expect(find(file, 'ctts')).toBe(-1);
    expect(find(file, 'esds')).toBeGreaterThan(0);
    // 关键帧表只有第一帧
    const stss = find(file, 'stss');
    expect([view.getUint32(stss + 8), view.getUint32(stss + 12)]).toEqual([1, 1]);
  });

  test('B 帧（呈现顺序和解码顺序不同）写 ctts：偏移 = 呈现时刻 − 解码时刻', () => {
    const samples = [sample(1, 4, 0, true), sample(2, 4, 2000, false), sample(3, 4, 1000, false)];
    const file = writeMp4({ video: { width: 64, height: 64, timescale: 30000, avcC: new Uint8Array([1]), samples } });
    const ctts = find(file, 'ctts');
    expect(ctts).toBeGreaterThan(0);
    const view = new DataView(file.buffer);
    // 版本 1；三段：0、+1000、−1000
    expect(file[ctts + 4]).toBe(1);
    expect(view.getUint32(ctts + 8)).toBe(3);
    expect([0, 1, 2].map((i) => view.getInt32(ctts + 16 + i * 8))).toEqual([0, 1000, -1000]);
  });
});
