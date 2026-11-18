import type { StrideNative } from '@stride-ts/native';
import type { Case, Run } from './harness';

/** The raw Emscripten exports the cases need; the wrapper keeps them internal, a benchmark has to reach past it. */
interface RawModule {
  _sn_alloc(size: number): number;
  _sn_free(ptr: number): void;
  _sn_worker_thread_count(): number;
  _sn_physics_get_positions(world: number, out: number, count: number): number;
  _sn_physics_add_box(world: number, position: number, halfExtent: number, dynamic: number): number;
}

export interface Context {
  readonly device: GPUDevice;
  readonly native: StrideNative;
}

/** Floats per instance: one 4x4 world matrix, the layout the renderer uploads. */
const INSTANCE_FLOATS = 16;
const DT = 1 / 60;

const rawOf = (native: StrideNative) => (native as unknown as { module: RawModule }).module;

export function createCases({ device, native }: Context): Case[] {
  const raw = rawOf(native);

  const instanceBuffer = (n: number) =>
    device.createBuffer({ size: n * INSTANCE_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  const flushGpu = () => device.queue.onSubmittedWorkDone();

  /** A Float32Array over native memory; the allocation is released by dispose. */
  const nativeFloats = (count: number) => {
    const ptr = raw._sn_alloc(count * 4);
    if (ptr === 0) throw new Error(`native alloc of ${count * 4} bytes failed`);
    return { ptr, view: new Float32Array(native.buffer, ptr, count), free: () => raw._sn_free(ptr) };
  };

  /** Moves every entity and uploads all instance matrices: the per-frame cost of the data's location. */
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

  // Results are added here so the JIT cannot drop the measured work.
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

  /** A physics world with n bodies spread out so none touch; the cases only read positions. */
  const physicsWorld = (n: number) => {
    const world = native.createPhysicsWorld(n);
    for (let i = 0; i < n; i++) world.addBox([(i % 100) * 3, 2, Math.floor(i / 100) * 3], [0.5, 0.5, 0.5], true);
    return world;
  };

  const physicsRead: Case[] = [
    {
      group: 'physics read: positions of n bodies per frame',
      name: 'current API: positions() allocates, copies, slices, frees',
      sizes: [1_000, 10_000],
      setup(n) {
        const world = physicsWorld(n);
        return {
          iterate() {
            const p = world.positions();
            sink += p[p.length - 1]!;
          },
          dispose: () => world.destroy(),
        };
      },
    },
    {
      group: 'physics read: positions of n bodies per frame',
      name: 'native fills a persistent buffer, JS reads a view',
      sizes: [1_000, 10_000],
      setup(n) {
        const world = physicsWorld(n);
        const out = nativeFloats(n * 3);
        const handle = (world as unknown as { handle: number }).handle;
        return {
          iterate() {
            raw._sn_physics_get_positions(handle, out.ptr, n);
            sink += out.view[n * 3 - 1]!;
          },
          dispose: () => {
            out.free();
            world.destroy();
          },
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
        // What a per-schema initializer built once at registration would do: no loop over key names.
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
      name: 'physics bodies through the current API (world + n addBox + destroy)',
      sizes: [1_000, 10_000],
      setup(n) {
        return { iterate: () => physicsWorld(n).destroy() };
      },
    },
    {
      group: 'create: spawn n entities with 6 props (defaults merged with one override)',
      name: 'physics bodies, raw export with reused argument buffers',
      sizes: [1_000, 10_000],
      setup(n) {
        // Same native work as above without the wrapper's per-call allocations: separates Jolt's cost from ours.
        const args = nativeFloats(6);
        args.view.set([0, 2, 0, 0.5, 0.5, 0.5]);
        return {
          iterate() {
            const world = native.createPhysicsWorld(n);
            const handle = (world as unknown as { handle: number }).handle;
            for (let i = 0; i < n; i++) {
              args.view[0] = (i % 100) * 3;
              args.view[2] = Math.floor(i / 100) * 3;
              raw._sn_physics_add_box(handle, args.ptr, args.ptr + 12, 1);
            }
            world.destroy();
          },
          dispose: args.free,
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
 * Uploads a pattern straight from wasm shared memory and reads it back from the GPU:
 * writeBuffer accepting a view over a SharedArrayBuffer is only useful if the data arrives intact.
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
