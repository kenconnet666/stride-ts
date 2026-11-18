/**
 * 立方体贴图和天空盒（Stride 的 TextureCube 和 Skybox）。天空盒是环境光照：漫反射是 3 阶球谐（资源管线里用
 * stride-tools 算，同 Stride 的 SkyboxGenerator）；镜面是按粗糙度预滤波的立方体贴图，渲染系统第一次用到时在 GPU 上
 * 从 radiance 生成（SkyboxPrefilter.ts）。和 Mesh 一样只是数据，按 id 登记，组件的列里存 id；GPU 资源由渲染系统管理。
 */
import type { CubemapData } from '../content/format';
import type { Branded } from '../data/prop';
import { ResourceTable } from '../engine/ResourceTable';

export type CubemapId = Branded<number, 'CubemapId'>;
export type SkyboxId = Branded<number, 'SkyboxId'>;

const cubemaps = new ResourceTable<Cubemap>();
const skyboxes = new ResourceTable<Skybox>();

/** HDR 立方体贴图，带 mip（格式和布局见 content/format.ts 的 CubemapData）。 */
export class Cubemap {
  readonly id: CubemapId;
  readonly name: string;
  readonly data: CubemapData;

  constructor(name: string, data: CubemapData) {
    if (data.levels.length === 0) throw new RangeError(`cubemap '${name}' has no mip levels`);
    this.name = name;
    this.data = data;
    this.id = cubemaps.add(this) as CubemapId;
  }

  /** @internal 组件里存的 id 对应的立方体贴图。 */
  static byId(id: number): Cubemap | undefined {
    return cubemaps.get(id);
  }
}

export class Skybox {
  readonly id: SkyboxId;
  readonly name: string;
  /** 9 个 RGB 系数，已经乘过基函数常数（同 Stride 的 SphericalHarmonicsEnvironmentColor.SphericalColors）。 */
  readonly diffuseSH: Float32Array;
  /** 源立方体贴图；镜面的预滤波从它生成。 */
  readonly radiance: Cubemap;
  /** 预滤波的镜面立方体贴图的边长；第 i 级 mip 对应粗糙度 i / (级数 - 1)。 */
  readonly specularSize: number;

  constructor(name: string, diffuseSH: ArrayLike<number>, radiance: Cubemap, specularSize = 256) {
    if (diffuseSH.length !== 27) throw new RangeError(`skybox '${name}' needs 9 RGB spherical harmonics coefficients`);
    if (!Number.isInteger(Math.log2(specularSize))) throw new RangeError(`skybox '${name}': specular size ${specularSize} must be a power of two`);
    this.name = name;
    this.diffuseSH = Float32Array.from(diffuseSH);
    this.radiance = radiance;
    this.specularSize = specularSize;
    this.id = skyboxes.add(this) as SkyboxId;
  }

  /** 镜面立方体贴图的 mip 级数（着色器按 sqrt(alphaR) · 级数 选级）。 */
  get specularLevels(): number {
    return Math.log2(this.specularSize) + 1;
  }

  /** @internal Light 组件里存的 id 对应的天空盒。 */
  static byId(id: number): Skybox | undefined {
    return skyboxes.get(id);
  }
}
