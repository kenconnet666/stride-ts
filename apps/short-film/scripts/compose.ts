/**
 * 短片的配乐：按和弦进行用几种简单的合成音色（铺底的和声、贝斯、琶音、鼓）生成 30 秒的立体声 WAV，再经编辑器导入成声音资源。
 * 确定性的（噪声用固定种子），重跑得到同样的文件。
 *
 *   node scripts/compose.ts <输出.wav>
 *
 * 结构（96 BPM，一小节 2.5 秒，12 小节）：1–4 小节只有和声和琶音（等待），5–6 加贝斯（走路），7–10 加鼓、琶音加密（跳舞），
 * 11–12 停在主和弦上渐弱（结尾）。和弦 C – Am – F – G 循环。
 */
import { writeFileSync } from 'node:fs';

const RATE = 48000;
const SECONDS = 30;
const BAR = 2.5;
const BEAT = BAR / 4;
const FRAMES = RATE * SECONDS;

/** 和弦：根音的 MIDI 音高和三个和弦音。 */
const CHORDS = [
  { root: 48, notes: [60, 64, 67] }, // C
  { root: 45, notes: [57, 60, 64] }, // Am
  { root: 41, notes: [53, 57, 60] }, // F
  { root: 43, notes: [55, 59, 62] }, // G
];

const left = new Float32Array(FRAMES), right = new Float32Array(FRAMES);
const frequency = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** 在 [start, start + length) 秒里加一个音：wave(相位) 乘包络，pan 是 -1（左）到 1（右）。 */
function note(start: number, length: number, midi: number, gain: number, pan: number, wave: (phase: number) => number, envelope: (t: number, length: number) => number): void {
  const f = frequency(midi);
  const from = Math.floor(start * RATE), to = Math.min(FRAMES, Math.floor((start + length) * RATE));
  const l = gain * Math.cos(((pan + 1) * Math.PI) / 4), r = gain * Math.sin(((pan + 1) * Math.PI) / 4);
  for (let i = from; i < to; i++) {
    const t = (i - from) / RATE;
    const v = wave(f * t) * envelope(t, length);
    left[i]! += v * l;
    right[i]! += v * r;
  }
}

const sine = (phase: number) => Math.sin(2 * Math.PI * phase);
/** 柔和的"锯齿"：前几个谐波按 1/n 加起来（不会刺耳）。 */
const soft = (phase: number) => sine(phase) + sine(2 * phase) / 2.5 + sine(3 * phase) / 5 + sine(4 * phase) / 9;
const triangle = (phase: number) => 1 - 4 * Math.abs((phase % 1) - 0.5);
/** 起音 attack 秒、结尾 release 秒的包络。 */
const pad = (attack: number, release: number) => (t: number, length: number) => Math.min(1, t / attack, (length - t) / release);
const pluck = (decay: number) => (t: number) => Math.min(1, t / 0.005) * Math.exp(-t / decay);

for (let bar = 0; bar < 12; bar++) {
  const start = bar * BAR;
  const ending = bar >= 10;
  const chord = ending ? CHORDS[0]! : CHORDS[bar % 4]!;
  // 和声：每小节一个，结尾两小节连成一个长音
  if (!ending || bar === 10) {
    const length = ending ? 2 * BAR : BAR + 0.3;
    chord.notes.forEach((midi, k) => note(start, length, midi, 0.06, (k - 1) * 0.5, soft, pad(0.4, ending ? 2.5 : 0.5)));
  }
  // 琶音：前半首每拍一个，跳舞的部分每半拍一个
  const step = bar >= 6 && bar < 10 ? BEAT / 2 : BEAT;
  if (!ending) {
    for (let k = 0, t = start; t < start + BAR - 1e-6; k++, t += step) {
      const midi = chord.notes[k % 3]! + 12;
      note(t, 0.6, midi, 0.07, k % 2 ? 0.4 : -0.4, triangle, pluck(0.25));
    }
  }
  // 贝斯：从第 5 小节起每拍一个根音
  if (bar >= 4 && !ending) for (let b = 0; b < 4; b++) note(start + b * BEAT, BEAT * 0.9, chord.root - 12, 0.18, 0, soft, pad(0.01, 0.08));
}
// 结尾的低音长音
note(10 * BAR, 2 * BAR, 36, 0.16, 0, soft, pad(0.05, 3));

// 鼓：第 7 到 10 小节，底鼓在 1、3 拍，踩镲每半拍
let seed = 12345;
const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 0xffffffff) * 2 - 1;
for (let bar = 6; bar < 10; bar++) {
  for (let b = 0; b < 4; b++) {
    const t = bar * BAR + b * BEAT;
    if (b % 2 === 0) {
      // 底鼓：音高从 120 Hz 快速落到 45 Hz 的正弦
      const from = Math.floor(t * RATE);
      for (let i = 0; i < RATE * 0.35 && from + i < FRAMES; i++) {
        const s = i / RATE;
        const v = Math.sin(2 * Math.PI * (45 * s + (75 * 0.04) * (1 - Math.exp(-s / 0.04)))) * Math.exp(-s / 0.12) * 0.35;
        left[from + i]! += v;
        right[from + i]! += v;
      }
    }
    for (const half of [0, BEAT / 2]) {
      const from = Math.floor((t + half) * RATE);
      let previous = 0;
      for (let i = 0; i < RATE * 0.05 && from + i < FRAMES; i++) {
        // 白噪声减去上一个样本：粗糙的高通，像踩镲
        const n = noise(), v = (n - previous) * Math.exp(-(i / RATE) / 0.015) * 0.03;
        previous = n;
        left[from + i]! += v * 0.8;
        right[from + i]! += v;
      }
    }
  }
}

// 开头淡入、结尾淡出，限幅
const fadeIn = RATE * 0.5, fadeOut = RATE * 2;
let peak = 0;
for (let i = 0; i < FRAMES; i++) {
  const g = Math.min(1, i / fadeIn, (FRAMES - i) / fadeOut);
  left[i]! *= g;
  right[i]! *= g;
  peak = Math.max(peak, Math.abs(left[i]!), Math.abs(right[i]!));
}
const scale = peak > 0.9 ? 0.9 / peak : 1;

const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/compose.ts <output.wav>');
const data = Buffer.alloc(44 + FRAMES * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + FRAMES * 4, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20); // PCM
data.writeUInt16LE(2, 22);
data.writeUInt32LE(RATE, 24);
data.writeUInt32LE(RATE * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(FRAMES * 4, 40);
for (let i = 0; i < FRAMES; i++) {
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]! * scale)) * 32767), 44 + i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i]! * scale)) * 32767), 46 + i * 4);
}
writeFileSync(out, data);
console.log(`wrote ${out}: ${SECONDS} s, peak ${peak.toFixed(2)}${scale < 1 ? ` (scaled by ${scale.toFixed(2)})` : ''}`);
