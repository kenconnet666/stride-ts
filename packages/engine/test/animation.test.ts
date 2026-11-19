import { describe, expect, test } from 'vitest';
import { AnimationComponent, evaluateMorphCurve, ModelMorphs, MorphStack, type AnimationBlendStack, type AnimationClip } from '../src/index';
import { decodeModel, encodeModel, MORPH_ENTRY_WORDS, packMeshMorph, plainMesh } from '../src/content/format';

/** 只有时长和重复方式的假剪辑：AnimationComponent 只读这几个字段。 */
const clip = (name: string, duration: number, repeatMode: AnimationClip['repeatMode'] = 'loopInfinite') => ({ name, duration, repeatMode, curves: [] as AnimationClip['curves'] }) as AnimationClip;

/** 把混合栈记成文字：push(名字@时刻)、blend(系数)、add(系数)。 */
class RecordingStack implements AnimationBlendStack {
  readonly ops: string[] = [];
  push(c: AnimationClip, time: number): this {
    this.ops.push(`push(${c.name}@${+time.toFixed(3)})`);
    return this;
  }
  blend(factor: number): this {
    this.ops.push(`blend(${+factor.toFixed(3)})`);
    return this;
  }
  add(factor: number): this {
    this.ops.push(`add(${+factor.toFixed(3)})`);
    return this;
  }
  subtract(factor: number): this {
    this.ops.push(`subtract(${+factor.toFixed(3)})`);
    return this;
  }
}

const component = (...clips: AnimationClip[]) => {
  const animation = new AnimationComponent();
  for (const c of clips) animation.animations.set(c.name, c);
  return animation;
};

/** 动画系统每帧做的：推进、压栈、合成之后更新权重。 */
const frame = (animation: AnimationComponent, elapsed: number) => {
  const stack = new RecordingStack();
  animation.advanceAndBuild(elapsed, stack);
  animation.updateWeights(elapsed);
  return stack.ops;
};

describe('AnimationComponent（Stride 的 AnimationProcessor 规则）', () => {
  test('play 停掉其他动画；循环的时间按时长取模', () => {
    const animation = component(clip('idle', 2), clip('run', 0.5));
    animation.play('idle');
    animation.play('run');
    expect(animation.playingAnimations.map((p) => p.name)).toEqual(['run']);
    expect(frame(animation, 0.75)).toEqual(['push(run@0.25)']);
  });

  test('线性混合按累计权重分配，叠加直接用自己的权重', () => {
    const animation = component(clip('a', 1), clip('b', 1), clip('c', 1));
    animation.play('a');
    animation.blend('b', 1, 0);
    animation.add(animation.animations.get('c')!, { blend: 'add', weight: 0.5 });
    expect(frame(animation, 0)).toEqual(['push(a@0)', 'push(b@0)', 'blend(0.5)', 'push(c@0)', 'add(0.5)']);
  });

  test('crossfade：旧的淡出后移除，新的权重升到 1', () => {
    const animation = component(clip('idle', 1), clip('run', 1));
    const idle = animation.play('idle');
    const run = animation.crossfade('run', 0.2);
    frame(animation, 0.1);
    expect(idle.weight).toBeCloseTo(0.5);
    expect(run.weight).toBeCloseTo(0.5);
    frame(animation, 0.1);
    expect(animation.playingAnimations).toEqual([run]);
    expect(run.weight).toBe(1);
  });

  test('playOnce 播到头后移除，ended 兑现；playOnceHold 停在最后', async () => {
    const animation = component(clip('punch', 0.5, 'playOnce'), clip('hold', 0.5, 'playOnceHold'));
    const punch = animation.play('punch');
    const ended = animation.ended(punch);
    frame(animation, 0.3);
    expect(animation.isPlaying('punch')).toBe(true);
    frame(animation, 0.3);
    expect(animation.isPlaying('punch')).toBe(false);
    await expect(ended).resolves.toBeUndefined();

    const hold = animation.play('hold');
    frame(animation, 1);
    expect(hold.currentTime).toBe(0.5);
    expect(animation.isPlaying('hold')).toBe(true);
  });

  test('权重是 0 的不压栈；停用的不推进时间', () => {
    const animation = component(clip('a', 1), clip('b', 1));
    const a = animation.play('a');
    animation.blend('b', 0, 0);
    a.enabled = false;
    expect(frame(animation, 0.4)).toEqual(['push(a@0)']);
  });

  test('没登记的名字报错，列出有哪些', () => {
    expect(() => component(clip('idle', 1)).play('run')).toThrow(/no animation named 'run'.*idle/);
  });
});

describe('形变权重（Stride 的 ModelComponent 的形变 API）', () => {
  test('按名字找槽，读写权重；槽越界报错', () => {
    const morphs = new ModelMorphs(['Bigger', 'Thicker'], 0);
    expect(morphs.findMorphTarget('Thicker')).toBe(1);
    expect(morphs.findMorphTarget('Wider')).toBe(-1);
    morphs.setMorphWeight(1, 0.5);
    expect(morphs.getMorphWeight(1)).toBe(0.5);
    morphs.setAllMorphWeights(2);
    expect([...morphs.weights]).toEqual([2, 2]);
    expect(() => morphs.setMorphWeight(-1, 0)).toThrow(/out of range/);
  });

  test('曲线线性插值，两端外取端点', () => {
    const curve = { target: 'a', times: [0, 1, 3], values: [0, 1, 0] };
    expect([-1, 0.5, 2, 5].map((t) => evaluateMorphCurve(curve, t))).toEqual([0, 0.5, 0.5, 0]);
  });

  test('混合栈：剪辑按曲线压入，blend、add 按槽算，只有一边有的槽取那一边，都没有的槽不动', () => {
    const morphs = new ModelMorphs(['a', 'b', 'c'], 0);
    morphs.setMorphWeight(2, 0.7);
    const morphClip = (name: string, curves: Record<string, number>) =>
      ({ name, duration: 1, morphWeights: Object.entries(curves).map(([target, value]) => ({ target, times: [0], values: [value] })) }) as unknown as AnimationClip;
    const stack = new MorphStack();
    stack.begin(morphs);
    stack.push(morphClip('one', { a: 1, b: 0 }), 0);
    stack.push(morphClip('two', { a: 0, b: 1, d: 5 }), 0);
    stack.blend(0.25);
    stack.apply();
    expect([...morphs.weights]).toEqual([0.75, 0.25, Math.fround(0.7)]);
    stack.begin(morphs);
    stack.push(morphClip('one', { a: 1 }), 0);
    stack.push(morphClip('two', { a: 0.5, b: 0.5 }), 0);
    stack.add(0.5);
    stack.apply();
    expect([...morphs.weights]).toEqual([1.25, 0.5, Math.fround(0.7)]);
  });

  test('模型文件带形变数据和目标表，往返不变；条目按顶点再按目标排', () => {
    const vertices = new Float32Array(3 * 8);
    const { morph, data } = packMeshMorph(3, [
      { vertex: 2, target: 1, position: [0, 1, 0] },
      { vertex: 0, target: 1, position: [1, 0, 0], normal: [0, 0, 1] },
      { vertex: 0, target: 0, position: [0, 0, 2] },
    ]);
    expect(morph).toEqual({ entryCount: 3, hasNormals: true });
    const words = new Uint32Array(data.buffer);
    // 起点 5（1 + 4 个偏移），顶点 0 有两个条目，1 没有，2 一个
    expect([...words.subarray(0, 5)]).toEqual([5, 0, 2, 2, 3]);
    expect([words[5 + 3], words[5 + MORPH_ENTRY_WORDS + 3]]).toEqual([0, 1]);
    const mesh = { ...plainMesh('m', null, vertices, new Uint16Array([0, 1, 2])), morph, morphData: data };
    const decoded = decodeModel(encodeModel({ meshes: [mesh], materials: [], morphTargets: ['a', 'b'] }).slice().buffer);
    expect(decoded.morphTargets).toEqual(['a', 'b']);
    expect(decoded.meshes[0]!.morph).toEqual(morph);
    expect([...decoded.meshes[0]!.morphData!]).toEqual([...data]);
  });
});
