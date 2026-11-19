// ParticlesSample 的 CustomParticleFields：样例自己的粒子字段，CustomParticleUpdater 写、CustomParticleShape 读。
import { particleField } from '@stride-ts/engine';

/** 矩形的两条边相对粒子大小的比例（默认正方形）。 */
export const RectangleXY = particleField('RectangleXY', [1, 1]);
