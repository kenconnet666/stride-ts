// TopDownRPG 的 PlayerInput：鼠标指着箱子时把高亮实体换成箱子的模型（高亮材质）摆在箱子上；按下时打射线，点到地面或箱子就
// 广播 moveDestinationEvent（按着拖动时沿地面一直更新目的地），点到地面时放点击特效。
// 和 Stride 不同：Stride 的高亮把箱子模型的每个材质槽都换成高亮材质；我们的模型一个网格一个实体，箱子只有一个网格，换它的材质。
import { EventKey, Matrix, Model, prop, Quaternion, SyncScript, Transform, type Entity } from '@stride-ts/engine';
import type { ClickResult } from '../core/ClickResult';
import { screenPositionToWorldPositionRaycast, spawnPrefabInstance } from '../core/Utils';

export const MoveDestinationEventKey = new EventKey<ClickResult>();

export class PlayerInput extends SyncScript.props({
  controllerIndex: prop.int().default(0),
  deadZone: prop.number().default(0.25),
  highlight: prop.entity().optional(),
  highlightMaterial: prop.asset('material').optional(),
  camera: prop.entity(),
  clickEffect: prop.asset('prefab').optional(),
}) {
  #lastClickResult: ClickResult | undefined;

  override update(): void {
    const input = this.game.input;
    const camera = this.game.entities.entity(this.camera);
    const hover = screenPositionToWorldPositionRaycast(this.game, input.mousePosition, camera);
    const isMoving = input.isMouseButtonDown('left') && this.#lastClickResult?.type === 'ground' && hover.type === 'ground';
    if (isMoving) {
      this.#lastClickResult!.worldPosition.copy(hover.worldPosition);
      MoveDestinationEventKey.broadcast(this.#lastClickResult!);
    }
    this.#highlight(!isMoving && hover.type === 'lootCrate' ? hover.clickedEntity : undefined);

    for (const event of input.pointerEvents) {
      if (event.eventType !== 'pressed') continue;
      const click = screenPositionToWorldPositionRaycast(this.game, event.position, camera);
      if (click.type === 'empty') continue;
      this.#lastClickResult = click;
      MoveDestinationEventKey.broadcast(click);
      if (this.clickEffect && click.type === 'ground') {
        // 特效的 +Y 转到地面的法线上
        const { x, y, z, w } = Quaternion.betweenDirections({ x: 0, y: 1, z: 0 }, click.normal);
        spawnPrefabInstance(this, this.clickEffect, undefined, 1.2, Matrix.compose(Matrix.identity(), [click.worldPosition.x, click.worldPosition.y, click.worldPosition.z], [x, y, z, w], [1, 1, 1]));
      }
    }
  }

  /** 高亮实体换成 target 的模型、摆在它的位置；没有 target 时缩到 0。 */
  #highlight(target: Entity | undefined): void {
    if (this.highlight === undefined) return;
    const highlight = this.game.entities.entity(this.highlight);
    const transform = highlight.require(Transform);
    const model = target?.get(Model);
    if (!target || !model || !this.highlightMaterial) {
      transform.scale.x = transform.scale.y = transform.scale.z = 0;
      return;
    }
    const settings = { mesh: model.mesh, material: this.highlightMaterial.id, isShadowCaster: false };
    if (highlight.get(Model)) Object.assign(highlight.require(Model), settings);
    else highlight.add(Model.with(settings));
    transform.setLocalMatrix(target.require(Transform).world);
  }
}
