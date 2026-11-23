/**
 * greybox 自己的材质节点，示范工程怎么给材质节点图加节点："警示条纹"——斜着的两色条纹（关卡白盒里标危险区、可互动的东西）。
 * 着色器在游戏页面里编，所以游戏入口（main.ts）登记；编辑器的"加节点"菜单、节点预览靠编辑器扩展（editor/extension.ts）的
 * materialNodes 登记同一批。数值参数用 graphParam 写进代码：编材质时进 uniform，拖滑块不用重新编译。
 */
import { graphParam, type MaterialNode } from '@stride-ts/engine/material-graph';

const hazardStripes: MaterialNode = {
  type: 'greybox.hazardStripes',
  category: 'generator',
  label: { 'zh-CN': '警示条纹', en: 'Hazard stripes' },
  inputs: [{ name: 'uv', type: 'vec2', fallback: 'streams.uv' }],
  outputs: [{ name: 'color', type: 'color' }, { name: 'mask', type: 'float' }],
  params: [
    { name: 'count', type: { kind: 'number', min: 1, step: 1 }, default: 6, description: 'stripes across the UV square' },
    { name: 'angle', type: { kind: 'number', min: -90, max: 90, step: 5, unit: 'deg' }, default: 45, description: 'direction of the stripes' },
    { name: 'a', type: { kind: 'color', alpha: false, space: 'linear' }, default: [0.85, 0.55, 0.02], description: 'first color' },
    { name: 'b', type: { kind: 'color', alpha: false, space: 'linear' }, default: [0.02, 0.02, 0.02], description: 'second color' },
  ],
  emit: ({ uv }, p) => {
    // 角度选方向是代码结构的一部分（字面量），条数、颜色进 uniform
    const radians = (Number(p['angle']) * Math.PI) / 180;
    const along = `dot(${uv}, vec2f(${Math.cos(radians).toFixed(6)}, ${Math.sin(radians).toFixed(6)}))`;
    const mask = `step(0.5, fract(${along} * ${graphParam.float(p['count'])}))`;
    return { mask, color: `mix(${graphParam.color(p['a'])}, ${graphParam.color(p['b'])}, ${mask})` };
  },
};

export const GREYBOX_MATERIAL_NODES: readonly MaterialNode[] = [hazardStripes];
