// SpaceEscape 的 BackgroundInfo、ObstacleInfo：LevelBlocks 场景里各段背景、障碍物上只带数据的脚本（Stride 的 ScriptComponent）。
import { prop, StartupScript } from '@stride-ts/engine';

/** 一段背景：最多放几个障碍物，地上的洞（Area 是 x、z 平面上的矩形，Y 是远端的 z，往近处量 Height；掉进去落到 height）。 */
export class BackgroundInfo extends StartupScript.props({
  maxNbObstacles: prop.int().default(0),
  holes: prop.list(prop.object({
    area: prop.object({ x: prop.number().default(0), y: prop.number().default(0), width: prop.number().default(0), height: prop.number().default(0) }),
    height: prop.number().default(0),
  })),
}) {}

/** 障碍物：碰撞用各个网格的包围盒（true），还是整个模型的。 */
export class ObstacleInfo extends StartupScript.props({
  useSubMeshBoundingBoxes: prop.bool().default(false),
}) {}
