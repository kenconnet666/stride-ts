/**
 * 渲染图（Frostbite 的 FrameGraph，GDC 2017）：一帧里的每个通道先声明它读哪些贴图、写哪些贴图，图再决定哪些通道真的要跑、
 * 临时贴图什么时候建、能不能几个通道轮着用同一张。
 *
 *   graph.beginFrame();
 *   const backBuffer = graph.import({ label: 'back buffer', width, height, format }, view);
 *   const color = graph.texture({ label: 'scene color', width, height, format: 'rgba16float' });
 *   graph.pass('opaque', (pass) => pass.write(color), (resources) => { ...beginRenderPass({ view: resources.view(color) })... });
 *   graph.pass('tone map', (pass) => { pass.read(color); pass.write(backBuffer); }, (resources) => { ... });
 *   graph.execute();
 *
 * 规则：
 * - 通道按加进来的顺序跑。读一张贴图读到的是在它前面加进来的通道写的内容，所以顺序由调用方的代码决定，图不重排
 *   （重排要每次写都换一个版本号的句柄，调用方的代码绕；这里的通道本来就是按顺序写下来的）。
 * - 结果没人用的通道不跑：从后往前看，一个通道写的贴图后面没有人读、它自己又没有图外面看得见的效果，就裁掉；
 *   它读的东西也就不算有人读。导入的贴图（后备缓冲、渲染目标贴图、要留到下一帧的历史）默认算"有人用"。
 * - 临时贴图只在第一次用到最后一次用之间占着一张真的贴图；两张描述相同、用的时间不重叠的临时贴图共用一张
 *   （后处理的一串中间结果就是这样省下显存的）。真的贴图跨帧留在池里，连着几帧没人用才销毁。
 *
 * - 预热（warm）：录好的一帧不执行，只把会跑的通道要的管线在后台编好（通道加的时候给 warm）。加载场景时先空录一帧，第一次
 *   真画的时候就不用当场编译着色器。
 *
 * 只有图的逻辑，不认识渲染器；贴图由 TextureAllocator 建（真的那个在 GraphTexturePool.ts，单测里换成假的）。
 */

export interface GraphTextureDesc {
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  readonly mipLevelCount?: number;
  readonly sampleCount?: number;
  /** 默认是 RENDER_ATTACHMENT | TEXTURE_BINDING。 */
  readonly usage?: GPUTextureUsageFlags;
}

/** 图里的一张贴图（句柄，只在这一帧有效）。 */
export interface GraphTexture {
  readonly id: number;
  readonly desc: GraphTextureDesc;
  /** 同 desc 里的（和 GPUTexture 的属性同名：效果的代码拿到哪种都这样读）。 */
  readonly width: number;
  readonly height: number;
  readonly format: GPUTextureFormat;
  /** 图外面的贴图（图不建也不回收它）。 */
  readonly imported: boolean;
}

/** 通道声明它怎么用贴图。 */
export interface PassBuilder {
  /** 读前面的通道写好的内容（采样，或者当深度缓冲只比不写）。 */
  read(texture: GraphTexture): void;
  /** 整张重写：原来的内容不要了（清屏以后画、全屏的效果）。 */
  write(texture: GraphTexture): void;
  /** 在原来的内容上接着画（load）。 */
  readWrite(texture: GraphTexture): void;
  /** 这个通道有图看不见的效果（写缓冲、读回），没人读它的贴图也要跑。 */
  sideEffect(): void;
}

/** 通道执行时拿真的贴图。只能拿自己声明过的。 */
export interface PassResources {
  texture(texture: GraphTexture): GPUTexture;
  view(texture: GraphTexture): GPUTextureView;
}

/** 建、收临时贴图的真东西（跨帧的池）。 */
export interface TextureAllocator {
  /** 一张符合描述的贴图：池里有闲着的就给它，没有就建。 */
  acquire(desc: GraphTextureDesc): GPUTexture;
  /** 这一帧用完了，还给池。 */
  release(desc: GraphTextureDesc, texture: GPUTexture): void;
}

export interface RenderGraphStats {
  /** 这一帧跑了的通道、裁掉的通道（名字，按顺序）。 */
  readonly passes: readonly string[];
  readonly culled: readonly string[];
  /** 声明了几张临时贴图（跑了的通道用到的），实际占了几张真的。 */
  readonly transientTextures: number;
  readonly physicalTextures: number;
}

interface Pass {
  readonly name: string;
  readonly reads: GraphTexture[];
  readonly writes: GraphTexture[];
  readonly readWrites: GraphTexture[];
  sideEffect: boolean;
  readonly execute: (resources: PassResources) => void;
  readonly warm: (() => Promise<void> | undefined) | undefined;
}

interface Imported {
  readonly texture: GPUTexture | undefined;
  readonly view: GPUTextureView;
  readonly output: boolean;
}

export class RenderGraph {
  readonly #allocator: TextureAllocator;
  #textures: GraphTexture[] = [];
  #imports = new Map<number, Imported>();
  #passes: Pass[] = [];
  #stats: RenderGraphStats = { passes: [], culled: [], transientTextures: 0, physicalTextures: 0 };

  constructor(allocator: TextureAllocator) {
    this.#allocator = allocator;
  }

  /** 上一次 execute 的统计。 */
  get stats(): RenderGraphStats {
    return this.#stats;
  }

  /** 开始新的一帧：上一帧的通道和句柄都作废。 */
  beginFrame(): void {
    this.#textures = [];
    this.#imports = new Map();
    this.#passes = [];
  }

  /** 一张临时贴图：图在它第一次用到之前建好，最后一次用完以后收回。 */
  texture(desc: GraphTextureDesc): GraphTexture {
    const texture: GraphTexture = { id: this.#textures.length, desc, width: desc.width, height: desc.height, format: desc.format, imported: false };
    this.#textures.push(texture);
    return texture;
  }

  /**
   * 图外面的贴图。output（默认 true）：帧结束以后还有人要它的内容（后备缓冲、渲染目标贴图、历史），写它的通道不会被裁掉；
   * 只是拿来读的（阴影图集已经在别处画好）给 false。texture 可以不给（只有视图，比如后备缓冲）：这时通道只能要视图。
   */
  import(desc: GraphTextureDesc, view: GPUTextureView, { texture, output = true }: { texture?: GPUTexture; output?: boolean } = {}): GraphTexture {
    const handle: GraphTexture = { id: this.#textures.length, desc, width: desc.width, height: desc.height, format: desc.format, imported: true };
    this.#textures.push(handle);
    this.#imports.set(handle.id, { texture, view, output });
    return handle;
  }

  /**
   * 加一个通道：setup 里声明读写（马上调用），execute 在 execute() 时、轮到它而且没被裁掉才调用。warm 在后台编它要的管线
   * （已经有了返回 undefined），warm() 时调用。
   */
  pass(name: string, setup: (builder: PassBuilder) => void, execute: (resources: PassResources) => void, warm?: () => Promise<void> | undefined): void {
    const pass: Pass = { name, reads: [], writes: [], readWrites: [], sideEffect: false, execute, warm };
    setup({
      read: (texture) => void pass.reads.push(texture),
      write: (texture) => void pass.writes.push(texture),
      readWrite: (texture) => void pass.readWrites.push(texture),
      sideEffect: () => void (pass.sideEffect = true),
    });
    this.#passes.push(pass);
  }

  /** 裁掉没用的通道，按顺序跑剩下的；临时贴图用到才占、用完就让给后面的。 */
  execute(): void {
    const passes = this.#passes;
    const live = this.#cull();
    // 每张临时贴图在跑的通道里第一次、最后一次用到的位置
    const first = new Map<number, number>(), last = new Map<number, number>();
    passes.forEach((pass, index) => {
      if (!live[index]) return;
      for (const texture of [...pass.reads, ...pass.writes, ...pass.readWrites]) {
        if (texture.imported) continue;
        if (!first.has(texture.id)) first.set(texture.id, index);
        last.set(texture.id, index);
      }
    });
    const physical = new Map<number, GPUTexture>();
    const views = new Map<number, GPUTextureView>();
    const acquired = new Set<GPUTexture>();
    passes.forEach((pass, index) => {
      if (!live[index]) return;
      const declared = new Set([...pass.reads, ...pass.writes, ...pass.readWrites].map((texture) => texture.id));
      // 读还没人写过的临时贴图：读到的是池里上一个用它的通道留下的东西
      for (const texture of [...pass.reads, ...pass.readWrites]) {
        if (!texture.imported && first.get(texture.id) === index) throw new Error(`render graph: pass '${pass.name}' reads '${texture.desc.label}' before any pass has written it`);
      }
      for (const texture of pass.writes) {
        if (!texture.imported && !physical.has(texture.id)) {
          const allocated = this.#allocator.acquire(texture.desc);
          physical.set(texture.id, allocated);
          acquired.add(allocated);
        }
      }
      const check = (texture: GraphTexture) => {
        if (!declared.has(texture.id)) throw new Error(`render graph: pass '${pass.name}' uses '${texture.desc.label}' without declaring it`);
      };
      pass.execute({
        texture: (texture) => {
          check(texture);
          const found = texture.imported ? this.#imports.get(texture.id)!.texture : physical.get(texture.id);
          if (!found) throw new Error(`render graph: '${texture.desc.label}' was imported as a view only; pass '${pass.name}' cannot get the texture`);
          return found;
        },
        view: (texture) => {
          check(texture);
          if (texture.imported) return this.#imports.get(texture.id)!.view;
          let view = views.get(texture.id);
          if (!view) views.set(texture.id, (view = physical.get(texture.id)!.createView()));
          return view;
        },
      });
      // 这个通道是最后一个用它的：还给池，后面的临时贴图可以接着用这一张
      for (const id of declared) {
        const texture = this.#textures[id]!;
        if (!texture.imported && last.get(id) === index) this.#allocator.release(texture.desc, physical.get(id)!);
      }
    });
    this.#stats = {
      passes: passes.filter((_, index) => live[index]).map((pass) => pass.name),
      culled: passes.filter((_, index) => !live[index]).map((pass) => pass.name),
      transientTextures: physical.size,
      physicalTextures: acquired.size,
    };
  }

  /** 不执行这一帧，只在后台编会跑的通道（裁掉的不算）要的管线；都编好了 Promise 才完成。 */
  async warm(): Promise<void> {
    const live = this.#cull();
    // 已经预热过的通道的 warm 返回 undefined
    await Promise.all(this.#passes.filter((_, index) => live[index]).map((pass) => pass.warm?.()).filter((warming) => warming !== undefined));
  }

  /** 哪些通道要跑：从后往前，写了"后面有人要"的贴图的、有副作用的。 */
  #cull(): boolean[] {
    const needed = new Set<number>();
    for (const [id, { output }] of this.#imports) if (output) needed.add(id);
    const live = new Array<boolean>(this.#passes.length).fill(false);
    for (let index = this.#passes.length - 1; index >= 0; index--) {
      const pass = this.#passes[index]!;
      if (!pass.sideEffect && ![...pass.writes, ...pass.readWrites].some((texture) => needed.has(texture.id))) continue;
      live[index] = true;
      // 整张重写的：这之前的内容没人要了；读的、接着画的：这之前的内容有人要
      for (const texture of pass.writes) needed.delete(texture.id);
      for (const texture of [...pass.reads, ...pass.readWrites]) needed.add(texture.id);
    }
    return live;
  }
}
