// ParticlesSample 的 AnimationStart：启动时在 Target（没给时是这个实体的）AnimationComponent 上叠加播放列出的剪辑，然后把自己移除。
import { AnimationComponent, prop, StartupScript } from '@stride-ts/engine';

export class AnimationStart extends StartupScript.props({
  target: prop.component(() => AnimationComponent).optional(),
  animations: prop.list(prop.object({
    clip: prop.asset('animation').optional(),
    blendOperation: prop.enum(['LinearBlend', 'Add']).default('LinearBlend'),
    startTime: prop.number().default(0),
  })).default([]),
}) {
  override start(): void {
    const component = this.target ?? this.entity.get(AnimationComponent);
    if (component) {
      for (const { clip, blendOperation, startTime } of this.animations) {
        if (clip) component.add(clip, { startTime, blend: blendOperation === 'Add' ? 'add' : 'linearBlend' });
      }
    }
    this.entity.remove(AnimationStart);
  }
}
