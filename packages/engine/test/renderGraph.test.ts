import { describe, expect, test } from 'vitest';
import { GraphTexturePool } from '../src/rendering/GraphTexturePool';
import { RenderGraph, type GraphTextureDesc, type TextureAllocator } from '../src/rendering/RenderGraph';

// 渲染图的逻辑：不碰 GPU，贴图是假的。

interface FakeTexture {
  readonly name: string;
  destroyed: boolean;
}

/** 假的池：描述相同的轮着用，记下建过几张。 */
function fakeAllocator() {
  const free = new Map<string, FakeTexture[]>();
  const created: string[] = [];
  const key = (desc: GraphTextureDesc) => `${desc.format}:${desc.width}x${desc.height}`;
  const allocator: TextureAllocator = {
    acquire: (desc) => {
      const reused = free.get(key(desc))?.pop();
      if (reused) return reused as unknown as GPUTexture;
      const texture = { name: `#${created.length} ${key(desc)}`, destroyed: false, createView: () => ({ of: texture.name }) };
      created.push(texture.name);
      return texture as unknown as GPUTexture;
    },
    release: (desc, texture) => void (free.get(key(desc)) ?? free.set(key(desc), []).get(key(desc))!).push(texture as unknown as FakeTexture),
  };
  return { allocator, created };
}

const desc = (label: string, format: GPUTextureFormat = 'rgba16float', width = 1280, height = 720): GraphTextureDesc => ({ label, width, height, format });
const view = (name: string) => ({ of: name }) as unknown as GPUTextureView;
const nameOf = (texture: GPUTexture) => (texture as unknown as FakeTexture).name;

describe('渲染图（RenderGraph）', () => {
  test('预热：只调会跑的通道的 warm，不执行、不要贴图；都编好了才完成', async () => {
    const { allocator, created } = fakeAllocator();
    const graph = new RenderGraph(allocator);
    graph.beginFrame();
    const backBuffer = graph.import(desc('back buffer', 'bgra8unorm-srgb'), view('back buffer'));
    const unused = graph.texture(desc('unused'));
    const color = graph.texture(desc('color'));
    const warmed: string[] = [];
    let finish = () => {};
    const slow = new Promise<void>((resolve) => (finish = resolve));
    graph.pass('unused', (pass) => pass.write(unused), () => { throw new Error('executed'); }, () => void warmed.push('unused'));
    graph.pass('scene', (pass) => pass.write(color), () => { throw new Error('executed'); }, () => (warmed.push('scene'), slow));
    graph.pass('tone map', (pass) => { pass.read(color); pass.write(backBuffer); }, () => { throw new Error('executed'); }, () => (warmed.push('tone map'), undefined));
    let done = false;
    const warming = graph.warm().then(() => (done = true));
    await Promise.resolve();
    expect([warmed, done]).toEqual([['scene', 'tone map'], false]);
    finish();
    await warming;
    expect([done, created]).toEqual([true, []]);
  });

  test('通道按加进来的顺序跑；结果没人用的裁掉，它读的东西也不算有人读；有副作用的照跑', () => {
    const { allocator } = fakeAllocator();
    const graph = new RenderGraph(allocator);
    const ran: string[] = [];
    const run = (name: string) => () => void ran.push(name);
    graph.beginFrame();
    const backBuffer = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    const color = graph.texture(desc('color')), depth = graph.texture(desc('depth', 'depth24plus'));
    const debugView = graph.texture(desc('debug view')), unusedInput = graph.texture(desc('only for the debug view'));
    graph.pass('depth prepass', (pass) => pass.write(depth), run('depth prepass'));
    graph.pass('opaque', (pass) => { pass.read(depth); pass.write(color); }, run('opaque'));
    graph.pass('transparent', (pass) => { pass.read(depth); pass.readWrite(color); }, run('transparent'));
    // 没人读它的结果：它和只给它用的那个通道都不跑
    graph.pass('debug input', (pass) => pass.write(unusedInput), run('debug input'));
    graph.pass('debug view', (pass) => { pass.read(unusedInput); pass.read(color); pass.write(debugView); }, run('debug view'));
    graph.pass('readback', (pass) => { pass.read(depth); pass.sideEffect(); }, run('readback'));
    graph.pass('tone map', (pass) => { pass.read(color); pass.write(backBuffer); }, run('tone map'));
    graph.pass('ui', (pass) => pass.readWrite(backBuffer), run('ui'));
    graph.execute();
    expect(ran).toEqual(['depth prepass', 'opaque', 'transparent', 'readback', 'tone map', 'ui']);
    expect(graph.stats).toEqual({ passes: ran, culled: ['debug input', 'debug view'], transientTextures: 2, physicalTextures: 2 });
  });

  test('整张重写的通道让它前面写同一张贴图的通道白写：前面的裁掉；只拿来读的导入贴图不算输出', () => {
    const { allocator } = fakeAllocator();
    const graph = new RenderGraph(allocator);
    const ran: string[] = [];
    graph.beginFrame();
    const backBuffer = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    const shadowAtlas = graph.import(desc('shadow atlas', 'depth32float'), view('shadow atlas'), { output: false });
    graph.pass('shadows', (pass) => pass.write(shadowAtlas), () => void ran.push('shadows'));
    graph.pass('first try', (pass) => pass.write(backBuffer), () => void ran.push('first try'));
    graph.pass('final', (pass) => pass.write(backBuffer), () => void ran.push('final'));
    graph.execute();
    // 阴影图集没人读，画它的通道裁掉；后备缓冲被 final 整张重写，first try 白写
    expect([ran, graph.stats.culled]).toEqual([['final'], ['shadows', 'first try']]);

    graph.beginFrame();
    const atlas = graph.import(desc('shadow atlas', 'depth32float'), view('shadow atlas'), { output: false });
    const output = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    ran.length = 0;
    graph.pass('shadows', (pass) => pass.write(atlas), () => void ran.push('shadows'));
    graph.pass('opaque', (pass) => { pass.read(atlas); pass.write(output); }, () => void ran.push('opaque'));
    graph.execute();
    expect(ran).toEqual(['shadows', 'opaque']);
  });

  test('临时贴图只在第一次到最后一次用之间占着真的贴图：描述相同、时间不重叠的共用一张', () => {
    const { allocator, created } = fakeAllocator();
    const graph = new RenderGraph(allocator);
    const used: Record<string, string> = {};
    graph.beginFrame();
    const backBuffer = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    // 一串全屏效果：a → b → c → d → 后备缓冲，每一步只读上一步的
    const chain = ['a', 'b', 'c', 'd'].map((label) => graph.texture(desc(label)));
    const half = graph.texture(desc('half', 'rgba16float', 640, 360));
    chain.forEach((target, i) => {
      graph.pass(`effect ${target.desc.label}`, (pass) => {
        if (i > 0) pass.read(chain[i - 1]!);
        pass.write(target);
      }, (resources) => {
        used[target.desc.label] = nameOf(resources.texture(target));
        // 同一个通道里读的和写的不是同一张
        if (i > 0) expect(nameOf(resources.texture(chain[i - 1]!))).not.toBe(used[target.desc.label]);
        expect(resources.view(target)).toEqual({ of: used[target.desc.label] });
      });
    });
    graph.pass('downscale', (pass) => { pass.read(chain[3]!); pass.write(half); }, (resources) => void (used['half'] = nameOf(resources.texture(half))));
    graph.pass('present', (pass) => { pass.read(half); pass.write(backBuffer); }, (resources) => expect(resources.view(backBuffer)).toEqual({ of: 'back buffer' }));
    graph.execute();
    // 四张全尺寸的中间结果只占两张真的（来回倒），半尺寸的另算
    expect(used).toEqual({ a: '#0 rgba16float:1280x720', b: '#1 rgba16float:1280x720', c: '#0 rgba16float:1280x720', d: '#1 rgba16float:1280x720', half: '#2 rgba16float:640x360' });
    expect([graph.stats.transientTextures, graph.stats.physicalTextures, created.length]).toEqual([5, 3, 3]);
    // 下一帧接着用池里的，不再建
    graph.beginFrame();
    const next = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    const again = graph.texture(desc('a'));
    graph.pass('effect', (pass) => pass.write(again), () => {});
    graph.pass('present', (pass) => { pass.read(again); pass.write(next); }, () => {});
    graph.execute();
    expect(created).toHaveLength(3);
  });

  test('用错了当场报：读还没人写过的临时贴图、用没声明的贴图、向只有视图的导入贴图要贴图', () => {
    const graph = new RenderGraph(fakeAllocator().allocator);
    graph.beginFrame();
    const backBuffer = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    const color = graph.texture(desc('color'));
    graph.pass('tone map', (pass) => { pass.read(color); pass.write(backBuffer); }, () => {});
    expect(() => graph.execute()).toThrow("pass 'tone map' reads 'color' before any pass has written it");

    graph.beginFrame();
    const output = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    const other = graph.texture(desc('other'));
    graph.pass('sneaky', (pass) => pass.write(output), (resources) => resources.view(other));
    expect(() => graph.execute()).toThrow("pass 'sneaky' uses 'other' without declaring it");

    graph.beginFrame();
    const viewOnly = graph.import(desc('back buffer', 'bgra8unorm'), view('back buffer'));
    graph.pass('copy', (pass) => pass.write(viewOnly), (resources) => resources.texture(viewOnly));
    expect(() => graph.execute()).toThrow('imported as a view only');
  });
});

describe('临时贴图的池（GraphTexturePool）', () => {
  test('描述相同的轮着用；闲了 30 帧的销毁', () => {
    const made: FakeTexture[] = [];
    const device = {
      createTexture: (descriptor: GPUTextureDescriptor) => {
        const texture = { name: descriptor.label!, destroyed: false, destroy: () => void (texture.destroyed = true) };
        made.push(texture);
        return texture;
      },
    } as unknown as GPUDevice;
    const pool = new GraphTexturePool(device);
    const full = desc('scene color'), half = desc('half', 'rgba16float', 640, 360);
    const a = pool.acquire(full), b = pool.acquire(full), c = pool.acquire(half);
    expect([made.map((texture) => texture.name), pool.count]).toEqual([['RenderGraph rgba16float 1280x720', 'RenderGraph rgba16float 1280x720', 'RenderGraph rgba16float 640x360'], 3]);
    pool.release(full, a);
    pool.release(full, b);
    pool.release(half, c);
    // 每帧都用到的一直留着，没人用的那张 30 帧以后销毁
    for (let frame = 0; frame < 40; frame++) {
      pool.endFrame();
      const x = pool.acquire(full);
      pool.release(full, x);
    }
    expect([made.map((texture) => texture.destroyed), pool.count]).toEqual([[true, false, true], 1]);
    pool.destroy();
    expect(made.every((texture) => texture.destroyed)).toBe(true);
  });
});
