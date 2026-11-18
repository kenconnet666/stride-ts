import type { BoxDesc, StrideNative } from '@stride-ts/native';
import type { Case, Run } from './harness';

/** 用例要用的 Emscripten 原始导出；包装层不公开它们，基准只能绕过包装层直接拿。 */
interface RawModule {
  _sn_alloc(size: number): number;
  _sn_free(ptr: number): void;
  _sn_worker_thread_count(): number;
}

export interface Context {
  readonly device: GPUDevice;
  readonly native: StrideNative;
}

/** 每个实例的 float 数：一个 4x4 世界矩阵，渲染器上传的就是这个布局。 */
const INSTANCE_FLOATS = 16;
const DT = 1 / 60;

const rawOf = (native: StrideNative) => (native as unknown as { module: RawModule }).module;

export function createCases({ device, native }: Context): Case[] {
  const raw = rawOf(native);

  const instanceBuffer = (n: number) =>
    device.createBuffer({ size: n * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const flushGpu = () => device.queue.onSubmittedWorkDone();

  /** 原生内存上的 Float32Array；由 dispose 释放分配。 */
  const nativeFloats = (count: number) => {
    const ptr = raw._sn_alloc(count * 4);
    if (ptr === 0) throw new Error(`native alloc of ${count * 4} bytes failed`);
    return { ptr, view: new Float32Array(native.buffer, ptr, count), free: () => raw._sn_free(ptr) };
  };

  /** 移动每个实体并上传所有实例矩阵：测数据放在哪里对每帧开销的影响。 */
  const uploadCase = (name: string, setup: (n: number, buffer: GPUBuffer) => Run): Case => ({
    group: 'upload: move n entities and upload n x 64 B per frame',
    name,
    sizes: [1_000, 10_000, 100_000],
    setup(n) {
      const buffer = instanceBuffer(n);
      const run = setup(n, buffer);
      return { ...run, between: flushGpu, dispose: () => { run.dispose?.(); buffer.destroy(); } };
    },
  });

  class TransformObject {
    x = 0;
    y = 0;
    z = 0;
  }

  const upload: Case[] = [
    uploadCase('JS objects, packed into a Float32Array each frame', (n, buffer) => {
      const entities = Array.from({ length: n }, () => new TransformObject());
      const data = new Float32Array(n * INSTANCE_FLOATS);
      return {
        iterate() {
          for (let i = 0; i < n; i++) {
            const e = entities[i]!;
            e.x += 0.001;
            const o = i * INSTANCE_FLOATS;
            data[o + 12] = e.x;
            data[o + 13] = e.y;
            data[o + 14] = e.z;
          }
          device.queue.writeBuffer(buffer, 0, data);
        },
      };
    }),
    uploadCase('Float32Array in the JS heap', (n, buffer) => {
      const data = new Float32Array(n * INSTANCE_FLOATS);
      return {
        iterate() {
          for (let i = 0; i < n; i++) data[i * INSTANCE_FLOATS + 12]! += 0.001;
          device.queue.writeBuffer(buffer, 0, data);
        },
      };
    }),
    uploadCase('Float32Array over wasm shared memory, uploaded directly', (n, buffer) => {
      const floats = nativeFloats(n * INSTANCE_FLOATS);
      const data = floats.view;
      return {
        iterate() {
          for (let i = 0; i < n; i++) data[i * INSTANCE_FLOATS + 12]! += 0.001;
          device.queue.writeBuffer(buffer, 0, data);
        },
        dispose: floats.free,
      };
    }),
    uploadCase('wasm shared memory, copied to a JS staging array first', (n, buffer) => {
      const floats = nativeFloats(n * INSTANCE_FLOATS);
      const data = floats.view;
      const staging = new Float32Array(n * INSTANCE_FLOATS);
      return {
        iterate() {
          for (let i = 0; i < n; i++) data[i * INSTANCE_FLOATS + 12]! += 0.001;
          staging.set(data);
          device.queue.writeBuffer(buffer, 0, staging);
        },
        dispose: floats.free,
      };
    }),
    uploadCase('writeBuffer alone (no JS loop)', (n, buffer) => {
      const data = new Float32Array(n * INSTANCE_FLOATS);
      return { iterate: () => device.queue.writeBuffer(buffer, 0, data) };
    }),
    uploadCase('one writeBuffer per entity (64 B each)', (n, buffer) => {
      const data = new Float32Array(n * INSTANCE_FLOATS);
      return {
        iterate() {
          for (let i = 0; i < n; i++) {
            data[i * INSTANCE_FLOATS + 12]! += 0.001;
            device.queue.writeBuffer(buffer, i * INSTANCE_FLOATS * 4, data, i * INSTANCE_FLOATS, INSTANCE_FLOATS);
          }
        },
      };
    }),
  ];

  // 结果累加到这里，JIT 就不能把被测的代码当成无用代码删掉。
  let sink = 0;
  class Counter {
    count = 3;
    get(): number {
      return this.count;
    }
  }

  const boundary: Case[] = [
    {
      group: 'boundary: n calls per iteration',
      name: 'JS method call',
      sizes: [10_000, 100_000],
      setup(n) {
        const counter = new Counter();
        return {
          iterate() {
            let total = 0;
            for (let i = 0; i < n; i++) total += counter.get();
            sink += total;
          },
        };
      },
    },
    {
      group: 'boundary: n calls per iteration',
      name: 'JS to wasm call (trivial export)',
      sizes: [10_000, 100_000],
      setup(n) {
        return {
          iterate() {
            let total = 0;
            for (let i = 0; i < n; i++) total += raw._sn_worker_thread_count();
            sink += total;
          },
        };
      },
    },
  ];

  /** n 个互不接触的箱子。 */
  const spreadBoxes = (n: number): BoxDesc[] =>
    Array.from({ length: n }, (_, i) => ({
      position: [(i % 100) * 3, 2, Math.floor(i / 100) * 3],
      halfExtent: [0.5, 0.5, 0.5],
    }));

  const physicsRead: Case[] = [
    {
      group: 'physics read: positions of n bodies per frame',
      name: 'positions(): the view step() rewrites, every y read',
      sizes: [1_000, 10_000],
      setup(n) {
        const world = native.createPhysicsWorld(n);
        world.addBoxes(spreadBoxes(n));
        return {
          iterate() {
            const p = world.positions();
            let total = 0;
            for (let i = 0; i < n; i++) total += p[i * 3 + 1]!;
            sink += total;
          },
          dispose: () => world.destroy(),
        };
      },
    },
  ];

  const defaults = { speed: 10, health: 100, armor: 0, jump: 1.2, team: 0, scale: 1 };
  type Values = typeof defaults;
  const keys = Object.keys(defaults) as (keyof Values)[];
  const overrides: Partial<Values> = { health: 120 };

  class ScriptObject {
    speed = 0;
    health = 0;
    armor = 0;
    jump = 0;
    team = 0;
    scale = 0;
    started = false;
    start(): void {
      this.started = true;
    }
  }

  const create: Case[] = [
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'script objects in the JS heap, start() called',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        return {
          iterate() {
            const scripts: ScriptObject[] = [];
            for (let i = 0; i < n; i++) {
              const s = new ScriptObject();
              for (const key of keys) s[key] = overrides[key] ?? defaults[key];
              s.start();
              scripts.push(s);
            }
            sink += scripts.length;
          },
        };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'script objects, props assigned by straight-line code',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        // 相当于登记时为每个 schema 生成一次的初始化函数：不按键名循环。
        const init = (s: ScriptObject) => {
          s.speed = defaults.speed;
          s.health = overrides.health ?? defaults.health;
          s.armor = defaults.armor;
          s.jump = defaults.jump;
          s.team = defaults.team;
          s.scale = defaults.scale;
        };
        return {
          iterate() {
            const scripts: ScriptObject[] = [];
            for (let i = 0; i < n; i++) {
              const s = new ScriptObject();
              init(s);
              s.start();
              scripts.push(s);
            }
            sink += scripts.length;
          },
        };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'rows in Float32Array columns (JS heap)',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const columns = keys.map(() => new Float32Array(n));
        const values = keys.map((key) => overrides[key] ?? defaults[key]);
        return {
          iterate() {
            for (let i = 0; i < n; i++) {
              for (let k = 0; k < columns.length; k++) columns[k]![i] = values[k]!;
            }
            sink += columns[0]![n - 1]!;
          },
        };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'one native allocation per entity (alloc + write + free)',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const pointers = new Uint32Array(n);
        const values = keys.map((key) => overrides[key] ?? defaults[key]);
        return {
          iterate() {
            for (let i = 0; i < n; i++) {
              const ptr = raw._sn_alloc(keys.length * 4);
              new Float32Array(native.buffer, ptr, keys.length).set(values);
              pointers[i] = ptr;
            }
            for (let i = 0; i < n; i++) raw._sn_free(pointers[i]!);
          },
        };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'physics bodies: world + n addBox calls + destroy',
      sizes: [1_000, 10_000],
      setup(n) {
        const boxes = spreadBoxes(n);
        return {
          iterate() {
            const world = native.createPhysicsWorld(n);
            for (const box of boxes) world.addBox(box);
            world.destroy();
          },
        };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'physics bodies: world + one addBoxes batch + destroy',
      sizes: [1_000, 10_000],
      setup(n) {
        const boxes = spreadBoxes(n);
        return {
          iterate() {
            const world = native.createPhysicsWorld(n);
            world.addBoxes(boxes);
            world.destroy();
          },
        };
      },
    },
  ];

  abstract class UpdateScript {
    y = 0;
    v = 1;
    abstract update(dt: number): void;
  }
  class WalkerA extends UpdateScript {
    update(dt: number): void { this.y += this.v * dt; }
  }
  class WalkerB extends UpdateScript {
    update(dt: number): void { this.y += this.v * dt * 1.01; }
  }
  class WalkerC extends UpdateScript {
    update(dt: number): void { this.y += this.v * dt * 0.99; }
  }
  class WalkerD extends UpdateScript {
    update(dt: number): void { this.y -= this.v * dt; }
  }
  const kinds = [WalkerA, WalkerB, WalkerC, WalkerD];

  class Vec3 {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    constructor(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
  }
  class AllocatingWalker extends UpdateScript {
    update(dt: number): void {
      const step = new Vec3(0, this.v * dt, 0);
      this.y += step.y;
    }
  }

  const updateGroup = 'update: per-frame logic over n entities';
  const update: Case[] = [
    {
      group: updateGroup,
      name: 'scripts: update() on 4 mixed classes (polymorphic call)',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const scripts: UpdateScript[] = Array.from({ length: n }, (_, i) => new kinds[i % kinds.length]!());
        return { iterate() { for (const s of scripts) s.update(DT); } };
      },
    },
    {
      group: updateGroup,
      name: 'scripts: one class, a temporary object per call',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const scripts = Array.from({ length: n }, () => new AllocatingWalker());
        return { iterate() { for (const s of scripts) s.update(DT); } };
      },
    },
    {
      group: updateGroup,
      name: 'system: loop over Float32Array columns (JS heap)',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const y = new Float32Array(n);
        const v = new Float32Array(n).fill(1);
        return {
          iterate() {
            for (let i = 0; i < n; i++) y[i]! += v[i]! * DT;
          },
        };
      },
    },
    {
      group: updateGroup,
      name: 'system: loop over columns in wasm shared memory',
      sizes: [1_000, 10_000, 100_000],
      setup(n) {
        const yf = nativeFloats(n);
        const vf = nativeFloats(n);
        const y = yf.view;
        const v = vf.view.fill(1);
        return {
          iterate() {
            for (let i = 0; i < n; i++) y[i]! += v[i]! * DT;
          },
          dispose() {
            yf.free();
            vf.free();
          },
        };
      },
    },
  ];

  return [...upload, ...boundary, ...physicsRead, ...create, ...update];
}

/**
 * 直接从 wasm 共享内存上传一组数据，再从 GPU 读回来核对：writeBuffer 接受 SharedArrayBuffer 上的视图，
 * 但要数据原样到达才有意义。
 */
export async function checkSharedUpload({ device, native }: Context): Promise<string> {
  const raw = rawOf(native);
  const count = 4096;
  const ptr = raw._sn_alloc(count * 4);
  try {
    const source = new Float32Array(native.buffer, ptr, count);
    for (let i = 0; i < count; i++) source[i] = i * 0.5;
    const target = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    device.queue.writeBuffer(target, 0, source);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(target, 0, readback, 0, count * 4);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(readback.getMappedRange());
    const mismatches = result.reduce((bad, value, i) => (value === i * 0.5 ? bad : bad + 1), 0);
    readback.unmap();
    target.destroy();
    readback.destroy();
    return mismatches === 0 ? `ok, ${count} floats match` : `${mismatches} of ${count} floats differ`;
  } finally {
    raw._sn_free(ptr);
  }
}
