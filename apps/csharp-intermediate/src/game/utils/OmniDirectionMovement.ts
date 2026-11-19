// CSharpIntermediate 的 OmniDirectionMovement：按住键沿各轴移动实体（Q/E 上下，W/S 前后，A/D 左右，各由一个开关打开）。
import { prop, SyncScript, Transform } from '@stride-ts/engine';

export class OmniDirectionMovement extends SyncScript.props({
  moveSpeed: prop.f32().default(3),
  vertical: prop.bool().default(true),
  horizontal: prop.bool().default(false),
  forward: prop.bool().default(false),
}) {
  override update(): void {
    const input = this.game.input;
    const axis = (enabled: boolean, negative: string, positive: string) => (enabled ? Number(input.isKeyDown(positive)) - Number(input.isKeyDown(negative)) : 0);
    const step = this.game.updateTime.elapsed * this.moveSpeed;
    const position = this.entity.require(Transform).position;
    position.x += axis(this.horizontal, 'D', 'A') * step;
    position.y += axis(this.vertical, 'Q', 'E') * step;
    position.z += axis(this.forward, 'S', 'W') * step;
  }
}
