// UIElementLink 的 AnimationStart：启动时在实体的 AnimationComponent（没有就加一个）上叠加播放列出的剪辑，然后把自己移除。
import { AnimationComponent, prop, StartupScript } from '@stride-ts/engine';

export class AnimationStart extends StartupScript.props({
  animations: prop.list(prop.object({
    clip: prop.asset('animation').optional(),
    blendOperation: prop.enum(['LinearBlend', 'Add']).default('LinearBlend'),
    startTime: prop.number().default(0),
  })).default([]),
}, { requires: [() => AnimationComponent] }) {
  override start(): void {
    if (!this.entity.has(AnimationComponent)) this.entity.add(AnimationComponent);
    const component = this.entity.require(AnimationComponent);
    for (const { clip, blendOperation, startTime } of this.animations) {
      if (clip) component.add(clip, { startTime, blend: blendOperation === 'Add' ? 'add' : 'linearBlend' });
    }
    this.entity.remove(AnimationStart);
  }
}
