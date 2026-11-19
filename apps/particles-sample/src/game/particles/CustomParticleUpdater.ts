// ParticlesSample 的 CustomParticleUpdater：按剩下的寿命把矩形的两条边（RectangleXY）设成 cos、sin 的组合，形状跟着变。
// 后置的更新器：新生成的粒子当帧也更新。
import { particleModuleValue, ParticleUpdater, type ParticleModuleFile, type ParticlePool } from '@stride-ts/engine';
import { RectangleXY } from './CustomParticleFields';

type AnimatedCurve = 'cosCos' | 'sinSin' | 'cosSin' | 'sinCos';

export class CustomParticleUpdater extends ParticleUpdater {
  readonly requiredFields = ['life', RectangleXY] as const;
  readonly curve: AnimatedCurve;

  constructor(file: ParticleModuleFile) {
    super(file);
    this.curve = particleModuleValue(file, 'curve', 'cosCos') as AnimatedCurve;
  }

  override get isPostUpdater(): boolean {
    return true;
  }

  update(_dt: number, pool: ParticlePool): void {
    const life = pool.field('life'), rectangle = pool.field(RectangleXY);
    if (!life || !rectangle) return;
    const [x, y] = [this.curve.startsWith('cos') ? Math.cos : Math.sin, this.curve.endsWith('Cos') ? Math.cos : Math.sin];
    for (let i = 0; i < pool.living; i++) {
      const lifePi = life[i]! * Math.PI;
      rectangle[i * 2] = x(lifePi);
      rectangle[i * 2 + 1] = y(lifePi);
    }
  }
}
