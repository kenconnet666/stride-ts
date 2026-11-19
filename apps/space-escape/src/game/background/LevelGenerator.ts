// SpaceEscape 的 LevelGenerator：从 LevelBlocks 场景（当模板加载）里克隆背景和障碍物，拼出一段关卡。Stride 里它是 LevelBlocks
// 实体上的脚本，属性引用六种背景和两种障碍物的实体；这里读模板上这个脚本的属性（实体引用换成了名字），按名字实例化。
import { Transform, type Entity, type EntityManager, type SceneTemplate } from '@stride-ts/engine';
import { BackgroundInfo, ObstacleInfo } from './BackgroundInfo';
import { Section } from './Section';

export const BACKGROUNDS = ['background_a00', 'background_b00', 'background_b01', 'background_b02', 'background_b03', 'background_b04'] as const;
export const OBSTACLES = ['obstacle1', 'obstacle2'] as const;
export type BackgroundName = (typeof BACKGROUNDS)[number];
export type ObstacleName = (typeof OBSTACLES)[number];

/** 0..count-1 的随机整数（Stride 的 Random.Next(count)）。 */
const randomInt = (count: number) => Math.floor(Math.random() * count);

export class LevelGenerator {
  readonly #template: SceneTemplate;
  readonly #entities: EntityManager;
  /** 属性名 → 模板里的实体名。 */
  readonly #names: Readonly<Record<string, string>>;

  constructor(template: SceneTemplate, entities: EntityManager) {
    this.#template = template;
    this.#entities = entities;
    const props = template.scriptProps('LevelBlocks', 'LevelGenerator');
    if (!props) throw new Error(`${template.path}: the LevelBlocks entity has no LevelGenerator`);
    this.#names = props as Readonly<Record<string, string>>;
  }

  randomCreateLevelBlock(): Section {
    return this.createLevelBlock(BACKGROUNDS[randomInt(BACKGROUNDS.length)]!);
  }

  /** 开头那段：没有障碍物的 a00。 */
  createSafeLevelBlock(): Section {
    return this.createLevelBlock('background_a00', 0);
  }

  /** 一段背景，随机放最多 maxObstacles 个障碍物（默认按背景的 MaxNbObstacles）。 */
  createLevelBlock(background: BackgroundName, maxObstacles?: number): Section {
    const entity = this.#clone(background);
    const info = entity.require(BackgroundInfo);
    const section = new Section(this.#entities).addBackgroundEntity(entity).addHoleRange(info.holes);
    this.#randomAddObstacles(section, section.length, maxObstacles ?? info.maxNbObstacles);
    return section;
  }

  /** 在这一段里 (x, z) 处（相对这一段的中心）放一个障碍物。 */
  addObstacle(section: Section, obstacle: ObstacleName, x: number, z: number): void {
    const entity = this.#clone(obstacle);
    Object.assign(entity.require(Transform).position, { x, y: 0, z });
    section.addObstacleEntity(entity, entity.require(ObstacleInfo).useSubMeshBoundingBoxes);
  }

  /** 克隆模板里的实体（Stride 的 Entity.Clone），放回原点。 */
  #clone(prop: string): Entity {
    const name = this.#names[prop];
    if (!name) throw new Error(`${this.#template.path}: LevelGenerator.${prop} is not set`);
    const [entity] = this.#template.prefab(name).instantiate(this.#entities);
    Object.assign(entity!.require(Transform).position, { x: 0, y: 0, z: 0 });
    return entity!;
  }

  /** 障碍物沿这一段均匀分开（每个在自己那一份里随机），随机放在三条道中的一条上。 */
  #randomAddObstacles(section: Section, patternLength: number, count: number): void {
    for (let i = 0; i < count; i++) {
      // 原点在这一段的中间
      const z = (patternLength * (i + Math.random())) / count - patternLength / 2;
      const lane = randomInt(3);
      this.addObstacle(section, OBSTACLES[randomInt(OBSTACLES.length)]!, (1 - lane) * 5, z);
    }
  }
}
