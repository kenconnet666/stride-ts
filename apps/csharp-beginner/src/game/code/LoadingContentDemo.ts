// CSharpBeginner 的 LoadingContentDemo：按 L 从代码加载人体模型，U 卸载，S 在随机位置建一个挂着这个模型的实体，C 清掉建的实体。
// 和 Stride 不同：加载是异步的（Content.Load 是同步的），加载完之前算没加载；卸载只是放下引用（内容管理还不释放资源）。
import { SyncScript, Transform, type LoadedModel, type Entity } from '@stride-ts/engine';

const MODEL = 'mannequinModel/Models/mannequinModel';
/** C# 的 Random.Next(min, max)：[min, max) 里的整数。 */
const nextInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

export class LoadingContentDemo extends SyncScript {
  #model: LoadedModel | undefined;
  readonly #spawned: Entity[] = [];

  override update(): void {
    const input = this.game.input;
    if (input.isKeyPressed('L')) void this.game.content.loadModel(MODEL).then((model) => (this.#model = model));
    if (input.isKeyPressed('U')) this.#model = undefined;
    if (input.isKeyPressed('S')) this.#spawn();
    if (input.isKeyPressed('C')) while (this.#spawned.length > 0) this.#spawned.pop()!.destroy();
    const print = (text: string, y: number) => this.game.debugText.print(text, [340, y]);
    print(`Model is ${this.#model ? 'loaded' : 'not loaded'}`, 580);
    print('Press L to load the manequin model', 600);
    print('Press U to unload the mannequin model', 620);
    print('Press S to spawn an entity if the model has been loaded', 660);
    print('Press C to clear all spawned entities', 680);
    print(`Spawned entities count: ${this.#spawned.length}`, 700);
  }

  #spawn(): void {
    if (!this.#model) return;
    const position = { x: nextInt(-2, 4), y: 0, z: nextInt(-2, 2) };
    const entity = this.game.entities.create({ name: 'My new entity with a model component', scene: this.entity.scene, components: [Transform.with({ position })] });
    this.game.content.addModel(entity, this.#model);
    this.#spawned.push(entity);
  }
}
