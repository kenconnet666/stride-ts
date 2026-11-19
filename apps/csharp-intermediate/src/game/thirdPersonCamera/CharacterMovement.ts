// CSharpIntermediate 的 CharacterMovement：WASD 走动。移动量是相对角色自己的（角色朝哪由相机脚本转），
// 写进 Character 的 moveX、moveY（Stride 的 MoveVector，乘 speed 是目标速度）。
import { Character, prop, SyncScript } from '@stride-ts/engine';

export class CharacterMovement extends SyncScript.props({
  /** 各个方向的速度（米每秒）：x 是左右，z 是前后。 */
  movementMultiplier: prop.vec3().default([3, 0, 4]),
}) {
  override update(): void {
    const input = this.game.input;
    const x = Number(input.isKeyDown('A')) - Number(input.isKeyDown('D'));
    const z = Number(input.isKeyDown('W')) - Number(input.isKeyDown('S'));
    const length = Math.hypot(x, z) || 1;
    const character = this.entity.require(Character);
    character.moveX = ((x / length) * this.movementMultiplier.x) / character.speed;
    character.moveY = ((z / length) * this.movementMultiplier.z) / character.speed;
  }
}
