import { describe, expect, test } from 'vitest';
import { DEFAULT_SOUND_SYNTH, mutateSound, seededRandom, SOUND_PRESETS, SOUND_SYNTH_RATE, SYNTH_RANGES, synthesizeSound, type SoundPreset } from '../../src/audio/soundSynth';
import { assetReferences } from '../../src/content/references';

const peak = (samples: Float32Array) => samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);

describe('合成音效（sfxr）', () => {
  test('默认参数：一声方波，长度是包络的三段（起音 0、持续 0.3²、衰减 0.4² 乘 100000 个样本），峰值是 volume', () => {
    const samples = synthesizeSound({});
    expect(Math.abs(samples.length - (0.09 + 0.16) * 100000)).toBeLessThanOrEqual(3);
    expect(peak(samples)).toBeCloseTo(DEFAULT_SOUND_SYNTH.volume, 5);
    expect(synthesizeSound({ volume: 0.2 }).every((sample, i) => Math.abs(sample - samples[i]! * 0.4) < 1e-6)).toBe(true);
  });

  test('同样的参数出同样的波形（噪声按 seed），换 seed 噪声变', () => {
    const noise = { wave: 'noise' as const, sustain: 0.1, decay: 0.1 };
    expect(synthesizeSound({ ...noise, seed: 5 })).toEqual(synthesizeSound({ ...noise, seed: 5 }));
    expect(synthesizeSound({ ...noise, seed: 6 })).not.toEqual(synthesizeSound({ ...noise, seed: 5 }));
  });

  test('往下滑的音高到最低音高就结束（比包络短）；往上滑的音高过零点更密', () => {
    const full = synthesizeSound({ sustain: 0.5, decay: 0.5 }).length;
    expect(synthesizeSound({ sustain: 0.5, decay: 0.5, slide: -0.5, minFrequency: 0.2 }).length).toBeLessThan(full / 2);
    const crossings = (samples: Float32Array) => samples.reduce((count, sample, i) => count + (i > 0 && Math.sign(sample) !== Math.sign(samples[i - 1]!) ? 1 : 0), 0);
    const flat = synthesizeSound({ wave: 'sine', sustain: 0.3, decay: 0 }), rising = synthesizeSound({ wave: 'sine', sustain: 0.3, decay: 0, slide: 0.3 });
    expect(crossings(rising)).toBeGreaterThan(crossings(flat) * 1.5);
  });

  test('每个类别：同一个种子出同一组参数，参数都在范围里，出得了声（0.02 到 8 秒）', () => {
    for (const preset of Object.keys(SOUND_PRESETS) as SoundPreset[]) {
      for (let seed = 1; seed <= 20; seed++) {
        const params = SOUND_PRESETS[preset](seededRandom(seed));
        expect(SOUND_PRESETS[preset](seededRandom(seed))).toEqual(params);
        for (const [key, [min, max]] of Object.entries(SYNTH_RANGES)) {
          const value = params[key as keyof typeof SYNTH_RANGES];
          expect(value >= min && value <= max, `${preset} ${seed} ${key} ${value}`).toBe(true);
        }
        const samples = synthesizeSound(params);
        if (preset !== 'random') expect(samples.length / SOUND_SYNTH_RATE, `${preset} ${seed}`).toBeGreaterThan(0.02);
        expect(samples.length / SOUND_SYNTH_RATE).toBeLessThan(8);
        expect(samples.every(Number.isFinite)).toBe(true);
      }
    }
  });

  test('变一点：波形不变，数值参数各自最多挪 amount（再留 3 位小数）、还在范围里', () => {
    const base = SOUND_PRESETS.laser(seededRandom(3));
    const mutated = mutateSound(base, seededRandom(9), 0.05);
    expect(mutated.wave).toBe(base.wave);
    expect(mutated).not.toEqual(base);
    for (const [key, [min, max]] of Object.entries(SYNTH_RANGES)) {
      const before = base[key as keyof typeof SYNTH_RANGES], after = mutated[key as keyof typeof SYNTH_RANGES];
      expect(Math.abs(after - before)).toBeLessThanOrEqual(0.0505);
      expect(after >= min && after <= max).toBe(true);
    }
  });

  test('合成的声音不引用音频文件，音频文件的声音引用它', () => {
    expect(assetReferences('sound', 'Sounds/Coin', { name: 'Coin', encoding: 'synth', streamFromDisk: false, spatialized: false, synth: {} })).toEqual([]);
    expect(assetReferences('sound', 'Sounds/Music', { name: 'Music', encoding: 'ogg', streamFromDisk: true, spatialized: false })).toEqual([{ kind: 'audio', path: 'Sounds/Music' }]);
  });
});
