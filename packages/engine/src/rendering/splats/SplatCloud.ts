/**
 * 一个泼溅资源（`.splat`，content/splatFile.ts）在运行时：头、节点表，和按需读进来的各节点的数据。
 *
 * 按需加载（流式）：内容管理器能按范围读（HTTP 的 Range）时，先读头和节点表，节点的数据等渲染器选节点时要了才读
 * （request：要的按优先从高到低给，相邻的节点合成一次请求，最多 MAX_IN_FLIGHT 个同时在读）；读到的放进 arrived，渲染器每帧
 * 取走、传进 GPU、在 ready 里记下。所以场景先出最粗的一级，近处的细节跟着到；看不见、离得远的细节不下载。不能按范围读的
 * （测试、编辑器后端读的文件，或者服务器不认 Range、回了整个文件）一次读完，全部节点一起到。
 *
 * GPU 上的缓冲照整个文件的大小建（数据到了才写进去）：这一步省的是下载、读文件的内存和首帧的时间，显存的分页回收以后要再做。
 */
import { ResourceTable } from '../../engine/ResourceTable';
import type { Branded } from '../../data/prop';
import { readSplatLayout, readSplatNodes, shWords, SPLAT_WORDS, type SplatLayout, type SplatNode } from '../../content/splatFile';

export type SplatCloudId = Branded<number, 'SplatCloudId'>;

/** 按范围读：[start, end) 的字节；服务器回了整个文件时 whole 是 true（bytes 是整个文件）。 */
export type SplatRangeReader = (url: URL, start: number, end: number) => Promise<{ readonly bytes: ArrayBuffer; readonly whole: boolean }>;

/** 读到的一段：连着的几个节点（first 起 count 个泼溅）的字和高阶球谐。 */
export interface SplatChunk {
  readonly nodes: readonly number[];
  readonly first: number;
  readonly count: number;
  readonly words: Uint32Array;
  readonly sh: Uint32Array;
}

/** 同时最多几个请求；一次请求最多读多少字节（相邻的节点合到这么大为止）。 */
const MAX_IN_FLIGHT = 4;
const MAX_REQUEST_BYTES = 8 << 20;
/** 一个节点读失败几次就不再要。 */
const MAX_FAILURES = 3;
/** 第一次读多少字节（头和节点表通常都在里面；不够再补读）。 */
const FIRST_READ_BYTES = 64 << 10;

const clouds = new ResourceTable<SplatCloud>();

export class SplatCloud {
  readonly id: SplatCloudId;
  readonly name: string;
  readonly count: number;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** 高阶球谐的阶数（0 是没有）和量化范围（content/splatFile.ts）。 */
  readonly shBands: number;
  readonly shRange: number;
  /** 细节层次的节点（至少一个根）。 */
  readonly nodes: readonly SplatNode[];
  /** 读到了、还没传进 GPU 的（渲染器取走）。 */
  readonly arrived: SplatChunk[] = [];
  /** 每个节点的数据进了 GPU 没有（渲染器传完设 1；选节点只选进了的）。 */
  readonly ready: Uint8Array;
  readonly #layout: SplatLayout;
  readonly #source: { readonly url: URL; readonly read: SplatRangeReader } | undefined;
  /** 每个节点：0 没要过，1 在读或者读到了。 */
  readonly #requested: Uint8Array;
  /** 每个节点读失败过几次。 */
  readonly #failures: Uint8Array;
  #inFlight = 0;

  private constructor(name: string, layout: SplatLayout, nodes: readonly SplatNode[], source?: { readonly url: URL; readonly read: SplatRangeReader }) {
    this.name = name;
    this.#layout = layout;
    this.#source = source;
    this.count = layout.count;
    this.min = layout.min;
    this.max = layout.max;
    this.shBands = layout.shBands;
    this.shRange = layout.shRange;
    this.nodes = nodes;
    this.ready = new Uint8Array(nodes.length);
    this.#requested = new Uint8Array(nodes.length);
    this.#failures = new Uint8Array(nodes.length);
    this.id = clouds.add(this) as SplatCloudId;
  }

  /** 整个文件已经读进来了：全部节点一起到。 */
  static fromBytes(name: string, buffer: ArrayBuffer): SplatCloud {
    const layout = readSplatLayout(buffer, name);
    if (buffer.byteLength < layout.byteLength) throw new Error(`${name}: truncated (${layout.count} splats, ${layout.nodeCount} nodes)`);
    const cloud = new SplatCloud(name, layout, readSplatNodes(buffer, layout, name));
    cloud.#arriveWhole(buffer);
    return cloud;
  }

  /** 按范围读：先读头和节点表（这个 Promise 完成时就能画了，数据在后面陆续到），根节点马上开始读。 */
  static async stream(name: string, url: URL, read: SplatRangeReader): Promise<SplatCloud> {
    const first = await read(url, 0, FIRST_READ_BYTES);
    if (first.whole) return SplatCloud.fromBytes(name, first.bytes);
    const layout = readSplatLayout(first.bytes, name);
    let head = first.bytes;
    if (head.byteLength < layout.dataStart) {
      const rest = await read(url, head.byteLength, layout.dataStart);
      if (rest.whole) return SplatCloud.fromBytes(name, rest.bytes);
      const joined = new Uint8Array(layout.dataStart);
      joined.set(new Uint8Array(head));
      joined.set(new Uint8Array(rest.bytes), head.byteLength);
      head = joined.buffer;
    }
    const cloud = new SplatCloud(name, layout, readSplatNodes(head, layout, name), { url, read });
    cloud.request([0]);
    return cloud;
  }

  /** @internal GaussianSplat 组件里存的 id 对应的资源。 */
  static byId(id: number): SplatCloud | undefined {
    return id === 0 ? undefined : clouds.get(id);
  }

  /** 正在读的请求个数（0 且 ready 都是 1 时整个资源都到了）。 */
  get loading(): number {
    return this.#inFlight;
  }

  /**
   * 要这些节点的数据（按优先从高到低）：没要过的按文件里的次序把相邻的合成一次请求，同时最多 MAX_IN_FLIGHT 个；排不上的
   * 不记，下一帧渲染器再要（那时的优先可能变了）。
   */
  request(wanted: readonly number[]): void {
    const source = this.#source;
    if (!source) return;
    for (const n of wanted) {
      if (this.#inFlight >= MAX_IN_FLIGHT) return;
      if (this.#requested[n]) continue;
      // 从这个节点往后接着文件里紧挨着的、也没要过的节点，合成一次请求
      const nodes = [n];
      let end = this.nodes[n]!.first + this.nodes[n]!.count;
      const bytesPer = (SPLAT_WORDS + shWords(this.shBands)) * 4;
      for (let next = n + 1; next < this.nodes.length; next++) {
        const node = this.nodes[next]!;
        if (this.#requested[next] || node.first !== end || (end + node.count - this.nodes[n]!.first) * bytesPer > MAX_REQUEST_BYTES) break;
        if (!wanted.includes(next)) break;
        nodes.push(next);
        end += node.count;
      }
      for (const m of nodes) this.#requested[m] = 1;
      this.#inFlight++;
      void this.#fetch(source, nodes, this.nodes[n]!.first, end - this.nodes[n]!.first).finally(() => this.#inFlight--);
    }
  }

  async #fetch(source: { readonly url: URL; readonly read: SplatRangeReader }, nodes: readonly number[], first: number, count: number): Promise<void> {
    const layout = this.#layout, shPer = shWords(this.shBands);
    try {
      const wordsStart = layout.dataStart + first * SPLAT_WORDS * 4;
      const words = await source.read(source.url, wordsStart, wordsStart + count * SPLAT_WORDS * 4);
      if (words.whole) return this.#arriveWhole(words.bytes);
      let sh = new Uint32Array(0);
      if (shPer > 0) {
        const shStart = layout.shStart + first * shPer * 4;
        const read = await source.read(source.url, shStart, shStart + count * shPer * 4);
        if (read.whole) return this.#arriveWhole(read.bytes);
        sh = new Uint32Array(read.bytes);
      }
      this.arrived.push({ nodes, first, count, words: new Uint32Array(words.bytes), sh });
    } catch (error) {
      // 读失败（网络断了一下、请求被中断）的节点放回去，下一帧再要；同一个节点失败 MAX_FAILURES 次就不要了（画父节点那一级，
      // 不每帧重试刷屏）
      const giveUp = nodes.some((n) => ++this.#failures[n]! >= MAX_FAILURES);
      if (!giveUp) for (const n of nodes) this.#requested[n] = 0;
      console.warn(`[splats] ${this.name}: loading ${count} splats from ${first} failed${giveUp ? ', giving up' : ', will retry'}: ${(error as Error).message}`);
    }
  }

  /** 整个文件都到了：全部节点作为一段。 */
  #arriveWhole(buffer: ArrayBuffer): void {
    const layout = this.#layout;
    this.#requested.fill(1);
    this.arrived.length = 0;
    this.arrived.push({
      nodes: this.nodes.map((_, n) => n), first: 0, count: layout.count,
      words: new Uint32Array(buffer, layout.dataStart, layout.count * SPLAT_WORDS),
      sh: new Uint32Array(buffer, layout.shStart, layout.count * shWords(this.shBands)),
    });
  }
}
