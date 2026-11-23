/**
 * 环境查询（照虚幻的 EQS）："找一个好地方"：先在周围生成一批候选点（贴到导航网格上），再按测试筛掉、打分，取最好的一个。
 * 用在状态树的 `findSpot` 任务里（结果写进位置参数），代码里 `runEnvironmentQuery`。运行时见 ai/EnvironmentQuery.ts。
 *
 *   躲起来：围着自己两圈点，看不见威胁的（visible from threat = false）才留，离威胁越远越好、离自己越近越好
 *
 * - 测试的 mode：filter 只筛（不满足的去掉），score 只打分（各测试的分数按候选点归一到 0..1 再乘 weight 加起来）。
 * - 位置参数名空着时是查询的人自己。
 */
import { s, type Infer, type InputOf } from '../schema/schema.ts';

export const ENVIRONMENT_QUERY_GENERATOR = s.union('type', {
  /** 几圈点：第 k 圈半径 radius × k / rings，每圈 count 个（错开半格）。 */
  rings: {
    radius: s.number({ min: 0.5, step: 0.5, unit: 'm' }).default(10),
    rings: s.integer(1, 16).default(2),
    count: s.integer(3, 64).default(12),
  },
  /** 方格：边长 size、间距 spacing 的一片点。 */
  grid: {
    size: s.number({ min: 1, step: 1, unit: 'm' }).default(20),
    spacing: s.number({ min: 0.5, step: 0.5, unit: 'm' }).default(2),
  },
}, { around: s.string().default('').describe('vector parameter at the center; empty: the querier') });

export const ENVIRONMENT_QUERY_TEST = s.union('type', {
  /** 到一个位置的水平距离：min、max 是筛的范围，打分时 prefer near（近的分高）或 far。 */
  distance: {
    to: s.string().default('').label('Distance to').describe('vector parameter; empty: the querier'),
    min: s.number({ min: 0, step: 0.5, unit: 'm' }).default(0),
    max: s.number({ min: 0, step: 0.5, unit: 'm' }).default(1e6),
    prefer: s.oneOf('near', 'far').default('near'),
  },
  /** 从一个位置（眼高 1.6 米）看不看得见这个点（1 米高）：want 是要看得见还是看不见。 */
  visible: {
    from: s.string().label('Seen from').describe('vector parameter of the viewer'),
    want: s.bool().default(false).describe('true: must be in sight; false: must be hidden'),
  },
  /** 从查询的人那里走得到（导航网格上有路，终点就在这个点上）。 */
  reachable: {},
  /** 随机分（打散同分的点）。 */
  random: {},
}, {
  mode: s.oneOf('filter', 'score').default('score'),
  weight: s.number({ min: 0, step: 0.1 }).default(1),
});

export const ENVIRONMENT_QUERY = s.object({
  generator: ENVIRONMENT_QUERY_GENERATOR,
  tests: s.list(ENVIRONMENT_QUERY_TEST).default([]),
  pick: s.oneOf('best', 'top25').default('best').describe('best: the highest score; top25: random among the best quarter'),
});

export type EnvironmentQueryFile = InputOf<typeof ENVIRONMENT_QUERY>;
export type EnvironmentQueryData = Infer<typeof ENVIRONMENT_QUERY>;
export type EnvironmentQueryTestData = Infer<typeof ENVIRONMENT_QUERY_TEST>;
