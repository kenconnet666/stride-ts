// SpaceEscape 的 BackgroundScript：关卡一段一段往相机这边移，跑过去的段删掉，前面不够时随机再接一段；天空板的 UV 往一边滚。
// 跑过的距离（米）变了就通知 onDistanceUpdated；GameScript 用 detectCollisions、detectHoles 判断角色撞上障碍物、掉进洞里。
//
// 和 Stride 不同：LevelBlocks 场景（模板）是异步加载的，加载好之前没有关卡（Stride 在 Start 里同步加载）。
import { prop, SyncScript, Transform, type Bounds, type Entity, type GameTime, type Mesh } from '@stride-ts/engine';
import { ENABLE_BEND, ENABLE_TEXTURE_UV, TEXTURE_REGION } from '../SpaceEscapeEffectMain';
import { LevelGenerator } from './LevelGenerator';
import type { Hole, Obstacle, Section } from './Section';

const GAME_SPEED = 30;
const REMOVE_BLOCK_POSITION = -16;
const ADD_BLOCK_POSITION = 280;
const NUMBER_OF_START_BLOCKS = 5;
const SKY_PLANE_POSITION = { x: 0, y: -10, z: 340 };

export class BackgroundScript extends SyncScript.props({
  levelBlocks: prop.asset('scene').optional(),
  skyplaneModel: prop.asset('model').optional(),
}) {
  /** 跑过的距离（米）变了时调用。 */
  onDistanceUpdated: ((distance: number) => void) | undefined;
  readonly #levelBlocks: Section[] = [];
  #levelGenerator: LevelGenerator | undefined;
  #runningDistance = 0;
  #isScrolling = false;
  #skyplane: Entity | undefined;
  #skyplaneMesh: Mesh | undefined;
  readonly #skyplaneUvRegion = [0, 0, 1, 1];

  get #distance(): number {
    return this.#runningDistance;
  }

  set #distance(value: number) {
    this.#runningDistance = value;
    this.onDistanceUpdated?.(value);
  }

  override start(): void {
    this.#distance = 0;
    const skyplane = this.skyplaneModel;
    if (skyplane) {
      // 天空板不弯，UV 滚动（网格效果的参数，见 SpaceEscapeEffectMain）
      this.#skyplane = this.game.entities.create({ name: 'Skyplane', components: [Transform.with({ position: [SKY_PLANE_POSITION.x, SKY_PLANE_POSITION.y, SKY_PLANE_POSITION.z] })] });
      this.game.content.addModel(this.#skyplane, skyplane);
      this.#skyplaneMesh = skyplane.meshes[0]!.mesh;
      this.#skyplaneMesh.setEffectParameters([0], ENABLE_BEND);
      this.#skyplaneMesh.setEffectParameters([1], ENABLE_TEXTURE_UV);
    }
    const levelBlocks = this.levelBlocks;
    if (!levelBlocks) throw new Error('SpaceEscape: BackgroundScript has no LevelBlocks scene');
    this.addTask(async () => {
      const template = await this.game.content.loadSceneTemplate(levelBlocks.path);
      this.#levelGenerator = new LevelGenerator(template, this.game.entities);
      this.#createStartLevelBlocks();
    });
  }

  override cancel(): void {
    for (const block of this.#levelBlocks) block.rootEntity.destroy();
    this.#skyplane?.destroy();
  }

  override update(time: GameTime): void {
    if (!this.#isScrolling || this.#levelBlocks.length === 0) return;
    const first = this.#levelBlocks[0]!;
    if (first.positionZ + first.length * 0.5 < REMOVE_BLOCK_POSITION) this.#removeLevelBlock(first);
    const last = this.#levelBlocks.at(-1)!;
    if (last.positionZ - last.length * 0.5 < ADD_BLOCK_POSITION) this.#addLevelBlock(this.#levelGenerator!.randomCreateLevelBlock());
    const moveDistance = GAME_SPEED * time.elapsed;
    for (const block of this.#levelBlocks) {
      block.positionZ -= moveDistance;
      // 同 Stride：每段都加一次（距离按段数放大）
      this.#distance += moveDistance / 100;
    }
    if (this.#skyplaneUvRegion[0]! < -1) this.#skyplaneUvRegion[0] = 0;
    this.#skyplaneUvRegion[0]! -= 0.0005;
    this.#skyplaneMesh?.setEffectParameters(this.#skyplaneUvRegion, TEXTURE_REGION);
  }

  reset(): void {
    this.#distance = 0;
    this.#isScrolling = false;
    for (const block of this.#levelBlocks.splice(0)) block.rootEntity.destroy();
    if (this.#levelGenerator) this.#createStartLevelBlocks();
  }

  startScrolling(): void {
    this.#isScrolling = true;
  }

  stopScrolling(): void {
    this.#isScrolling = false;
  }

  /** 角色的包围盒（世界坐标）和哪个障碍物的包围盒有交叠。 */
  detectCollisions(agent: Bounds): boolean {
    return this.#levelBlocks.some((block) => block.collidableObstacles.some((obstacle) => detectCollision(agent, obstacle)));
  }

  /** 角色是不是在洞上；在的话返回洞底的高度。 */
  detectHoles(agent: { readonly x: number; readonly z: number }): number | undefined {
    for (const block of this.#levelBlocks) {
      for (const hole of block.holes) {
        if (inHole(agent, hole, block.positionZ)) return hole.height;
      }
    }
    return undefined;
  }

  #createStartLevelBlocks(): void {
    this.#addLevelBlock(this.#levelGenerator!.createSafeLevelBlock());
    for (let i = 0; i < NUMBER_OF_START_BLOCKS; i++) this.#addLevelBlock(this.#levelGenerator!.randomCreateLevelBlock());
  }

  /** 接在最后一段后面（两段的中心相距两段长度的一半之和）。 */
  #addLevelBlock(section: Section): void {
    const previous = this.#levelBlocks.at(-1);
    if (previous) section.positionZ = previous.positionZ + 0.5 * (previous.length + section.length);
    section.rootEntity.require(Transform).parent = this.entity;
    this.#levelBlocks.push(section);
  }

  #removeLevelBlock(section: Section): void {
    this.#levelBlocks.splice(this.#levelBlocks.indexOf(section), 1);
    section.rootEntity.destroy();
  }
}

/** 障碍物的各个包围盒放到它的世界位置上，和角色的包围盒有交叠（Stride 的 BoxContainsBox 不是 Disjoint）。 */
function detectCollision(agent: Bounds, obstacle: Obstacle): boolean {
  // 同 Stride 先算世界矩阵：这一帧刚接上的段还没传播过变换
  const transform = obstacle.entity.require(Transform);
  transform.updateWorldMatrix();
  const world = transform.world;
  const at = [world[12]!, world[13]!, world[14]!];
  return obstacle.boundingBoxes.some(({ min, max }) => [0, 1, 2].every((i) => min[i]! + at[i]! <= agent.max[i]! && max[i]! + at[i]! >= agent.min[i]!));
}

/** 洞的矩形在 (-x, z) 平面上：Y 是远端，往近处量 Height（Stride 的 RectContains）。 */
function inHole(agent: { readonly x: number; readonly z: number }, hole: Hole, blockZ: number): boolean {
  const { x, y, width, height } = hole.area;
  const ax = -agent.x, az = agent.z, top = y + blockZ;
  return x <= ax && x + width >= ax && top >= az && top - height <= az;
}
