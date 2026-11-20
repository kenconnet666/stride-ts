import { createStrideNative, type StrideNative } from '@stride-ts/native';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Game } from '../src/games/Game';
import { Matrix } from '../src/mathematics/Matrix';
import { Transform, transformSlot } from '../src/engine/transform';
import type { GpuResources } from '../src/rendering/GpuResources';
import { RenderView } from '../src/rendering/RenderSystem';
import { SpriteBatch } from '../src/rendering/text/SpriteBatch';
import type { UIComponent } from '../src/ui/UIComponent';
import { Canvas } from '../src/ui/panels/Canvas';
import { UISystem } from '../src/ui/UISystem';
import { fakeGpu, firstArgs, stubGpuGlobals, type BufferWrite, type GpuCall } from './fakeGpu';

/** 贴图在测试里不用真的建。 */
const RESOURCES = { texture: () => ({ createView: () => ({}) }), linearClamp: {} } as unknown as GpuResources;

const scissors = (calls: readonly GpuCall[]) => calls.filter((call) => call.method === 'setScissorRect').map((call) => call.args);
/** SpriteBatch 写进 uniform 的 pickId（变换矩阵后面的那个 u32）。 */
const pickIds = (writes: readonly BufferWrite[]) =>
  writes.filter((write) => (write.buffer as GPUBuffer).label === 'SpriteBatch transform' && write.offset === 64).map((write) => new Uint32Array(write.bytes.buffer, write.bytes.byteOffset, 1)[0]);

describe('SpriteBatch 画进点选的编号缓冲', () => {
  test('设了 pickId：用 fsSpritePick、不混合，编号写进 uniform；元素的剪裁矩形和整批的 clip 取交集，画完恢复成 clip', () => {
    stubGpuGlobals();
    const { device, pass, calls, writes } = fakeGpu();
    const batch = new SpriteBatch(device, RESOURCES);
    batch.pickId = 7;
    batch.clip = [100, 50, 1, 1];
    batch.begin(pass, 200, 100, 'r32uint');
    const quad = { origin: [0, 0], axisX: [200, 0], axisY: [0, 100] } as const;
    batch.drawQuad(null, quad, [0, 0, 1, 1], [1, 1, 1, 1]);
    // ClipToBounds 的元素：一个包含被点的像素，一个不包含
    batch.setScissor([90, 40, 20, 20]);
    batch.drawQuad(null, quad, [0, 0, 1, 1], [1, 1, 1, 1]);
    batch.setScissor([0, 0, 10, 10]);
    batch.drawQuad(null, quad, [0, 0, 1, 1], [1, 1, 1, 1]);
    batch.end();
    expect(pickIds(writes)).toEqual([7]);
    const pipelines = firstArgs<GPURenderPipelineDescriptor>(calls, 'createRenderPipeline');
    expect(pipelines.map((pipeline) => [pipeline.label, pipeline.fragment!.entryPoint, pipeline.fragment!.targets])).toEqual([['SpriteBatch sprite picking', 'fsSpritePick', [{ format: 'r32uint' }]]]);
    // 第一段没有自己的剪裁矩形，用 pass 开始时的（就是 clip）；不相交的那段宽高是 0，位置仍在 clip 里
    expect(scissors(calls)).toEqual([[100, 50, 1, 1], [100, 50, 0, 0], [100, 50, 1, 1]]);
  });

  test('同一个设备上的 SpriteBatch 共用着色器模块、布局和管线（UI 每个组件一个，不各编一套）', () => {
    stubGpuGlobals();
    const { device, pass, calls } = fakeGpu();
    for (let i = 0; i < 3; i++) {
      const batch = new SpriteBatch(device, RESOURCES);
      batch.begin(pass, 200, 100, 'rgba8unorm');
      batch.drawQuad(null, { origin: [0, 0], axisX: [10, 0], axisY: [0, 10] }, [0, 0, 1, 1], [1, 1, 1, 1]);
      batch.end();
    }
    const count = (method: string) => calls.filter((call) => call.method === method).length;
    expect([count('createShaderModule'), count('createRenderPipeline'), count('createBindGroupLayout')]).toEqual([1, 1, 4]);
  });

  test('没设 pickId 照常画：预乘 alpha 混合，编号写 0，剪裁矩形限制在渲染目标里', () => {
    stubGpuGlobals();
    const { device, pass, calls, writes } = fakeGpu();
    const batch = new SpriteBatch(device, RESOURCES);
    batch.begin(pass, 200, 100, 'rgba8unorm');
    batch.setScissor([150, 80, 100, 100]);
    batch.drawQuad(null, { origin: [0, 0], axisX: [10, 0], axisY: [0, 10] }, [0, 0, 1, 1], [1, 1, 1, 1]);
    batch.end();
    expect(pickIds(writes)).toEqual([0]);
    const [pipeline] = firstArgs<GPURenderPipelineDescriptor>(calls, 'createRenderPipeline');
    expect([pipeline!.fragment!.entryPoint, pipeline!.fragment!.targets[0]!.blend]).toEqual(['fsSprite', { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } }]);
    expect(scissors(calls)).toEqual([[150, 80, 50, 20], [0, 0, 200, 100]]);
  });
});

describe('UI 的点选（UISystem.drawPicking）', () => {
  // UI 的实体的变换在原生内存里
  let native: StrideNative;
  beforeAll(async () => {
    native = await createStrideNative({ workerThreads: 1 });
  });
  afterAll(() => native?.shutdown());

  /** 带原生变换存储的游戏；ui 里加一个 100x100 虚拟像素、1x1 米的 UI，放在 z 处。 */
  function placeUI(game: Game, ui: UISystem, name: string, z: number, isFullScreen: boolean) {
    const root = new Canvas();
    root.backgroundColor = [1, 1, 1, 1];
    const entity = game.entities.create({ name, components: [Transform.with({ position: [0, 0, z] })] });
    const component = { entity, enabled: true, renderGroup: 0, isFullScreen, isBillboard: false, isFixedSize: false, page: { rootElement: root }, resolution: { x: 100, y: 100, z: 100 }, size: { x: 1, y: 1, z: 1 } } as unknown as UIComponent;
    ui.add(component);
    return { entity, component };
  }

  function createGame(): Game {
    const game = new Game();
    game.native = native;
    game.transforms = native.createTransforms(16);
    return game;
  }

  /** 看向 -Z 的透视相机。 */
  function cameraView(): RenderView {
    const view = new RenderView();
    Matrix.perspectiveFovRH(view.projection, Math.PI / 3, 16 / 9, 0.1, 100);
    Matrix.multiply(view.viewProjection, view.projection, view.view);
    return view;
  }

  test('编辑器的选中框（worldBox）：上一帧画的那块板，中心在实体上、大小是 Size；全屏的、还没画的没有', () => {
    stubGpuGlobals();
    const game = createGame();
    const { device, pass } = fakeGpu();
    const view = cameraView();
    const host = {
      graphicsDevice: { device, canvas: { width: 320, height: 180 }, frameEncoder: { beginRenderPass: () => pass }, currentBackBufferView: () => ({}), backBufferViewFormat: 'bgra8unorm' },
      graphicsCompositor: { mainView: view, mainDepth: { createView: () => ({}) } },
      renderSystem: { resources: RESOURCES },
      updateTime: { elapsed: 0 },
    } as unknown as Game;
    const ui = new UISystem();
    const board = placeUI(game, ui, 'board', -2, false), hud = placeUI(game, ui, 'hud', 0, true);
    game.transforms.update();
    expect(ui.worldBox(board.component)).toBeUndefined();
    ui.draw(host);
    const box = ui.worldBox(board.component)!;
    const [hx, hy, hz] = box.halfExtents;
    expect(hz).toBe(0);
    const corner = (sx: number, sy: number) => Matrix.transformPoint(box.matrix, sx * hx, sy * hy, 0).map((c) => +c.toFixed(5) + 0);
    expect([corner(-1, -1), corner(1, 1)]).toEqual([[-0.5, 0.5, -2], [0.5, -0.5, -2]]);
    expect(ui.worldBox(hud.component)).toBeUndefined();
  });

  test('只画放在 3D 里的 UI，从远到近，写各自实体的变换槽位加一，剪裁到被点的像素；全屏的 UI 不画', () => {
    stubGpuGlobals();
    const game = createGame();
    const { device, pass, calls, writes } = fakeGpu();
    // drawPicking 只用到游戏的这几样
    const host = { graphicsDevice: { device, canvas: { width: 320, height: 180 } }, renderSystem: { resources: RESOURCES }, updateTime: { elapsed: 0 } } as unknown as Game;
    const ui = new UISystem();
    const place = (name: string, z: number, isFullScreen: boolean) => placeUI(game, ui, name, z, isFullScreen).entity;
    const near = place('near', -2, false), hud = place('hud', 0, true), far = place('far', -5, false);
    game.transforms.update();
    const view = cameraView();
    ui.drawPicking(host, pass, view, [320, 180], [160, 90, 1, 1], 'r32uint', 'depth32float');
    expect(pickIds(writes)).toEqual([transformSlot(far) + 1, transformSlot(near) + 1]);
    expect(pickIds(writes)).not.toContain(transformSlot(hud) + 1);
    const pipelines = firstArgs<GPURenderPipelineDescriptor>(calls, 'createRenderPipeline');
    expect(pipelines.every((pipeline) => pipeline.fragment!.entryPoint === 'fsSpritePick' && pipeline.depthStencil?.format === 'depth32float')).toBe(true);
    // UI 自己没剪裁，从头到尾用 pass 开始时的（ScenePicker 设的那个像素）
    expect(scissors(calls)).toEqual([]);
  });
});
