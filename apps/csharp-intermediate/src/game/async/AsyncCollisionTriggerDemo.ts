// CSharpIntermediate 的 AsyncCollisionTriggerDemo：用异步脚本等触发器的事件：有球进来就把它的材质换成黄色，等它出去再换回来。
import { AsyncScript, Model, TriggerHandler, type EntityId } from '@stride-ts/engine';

const YELLOW = 'CSharpIntermediate/Materials/Yellow';

export class AsyncCollisionTriggerDemo extends AsyncScript {
  override async execute(): Promise<void> {
    const trigger = this.game.simulation!.trigger(this.entity);
    const yellow = await this.game.content.loadMaterial(YELLOW);
    for (;;) {
      const ball = await this.#next(trigger.onEnter.bind(trigger), () => true);
      const model = this.game.entities.entity(ball).require(Model);
      const original = model.material;
      model.material = yellow.id;
      await this.#next(trigger.onLeave.bind(trigger), (other) => other === ball);
      // 在里面的时候球被销毁了就不用换回来
      if (this.game.entities.isAlive(ball)) model.material = original;
    }
  }

  /** 等触发器的下一次事件（accept 挑要等的物体）；脚本移除时以中止原因拒绝，execute 就此结束。 */
  #next(subscribe: TriggerHandler['onEnter'], accept: (other: EntityId) => boolean): Promise<EntityId> {
    return new Promise((resolve, reject) => {
      const stop = () => {
        subscription[Symbol.dispose]();
        this.signal.removeEventListener('abort', abort);
      };
      const abort = () => {
        stop();
        reject(this.signal.reason);
      };
      const subscription = subscribe(({ other }) => {
        if (!accept(other)) return;
        stop();
        resolve(other);
      });
      this.signal.addEventListener('abort', abort);
    });
  }
}
