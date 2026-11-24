// 游戏：加载一个世界（地址里的 ?world=…，默认测试世界 Worlds/Test；常驻场景是 MainScene：相机、太阳、天空），格子按相机附近流式加载。
// 导航网格按块流式地建：人群里的人、挂 NavigationInvoker 的实体周围才有（没有人时不建）。
// ?drive=<车的实体名>（空的是 PlayerCar）：主相机跟着那辆车（追车的镜头），用开车的输入映射开它（WASD、方向键、手柄）。
// ?hour=<钟点>：世界时钟从几点开始（默认 10 点：这几个世界没有日夜循环，太阳是白天的，行人按日程白天逛街、晚上 8 点以后回家）。
import { Camera, CameraRig, DEFAULT_NAVIGATION_STREAMING, Game } from '@stride-ts/engine';

export class OpenWorldGame extends Game {
  protected override async loadContent(): Promise<void> {
    const params = new URLSearchParams(location.search);
    await this.world.load(params.get('world') ?? 'Worlds/Test');
    if (this.navigation) this.navigation.settings = { ...this.navigation.settings, streaming: DEFAULT_NAVIGATION_STREAMING };
    this.clock.set({ hours: Number(params.get('hour') ?? 10) });
    const drive = params.get('drive');
    if (drive !== null) this.#chase(drive || 'PlayerCar');
  }

  /** 主相机追着名叫 name 的车（车自己的 VehicleDriver 读开车的输入）。 */
  #chase(name: string): void {
    const entities = this.entities.ids().map((id) => this.entities.entity(id));
    const car = entities.find((entity) => entity.name === name);
    // 加载时还没画过，渲染器还不知道哪台是主相机：常驻场景里只有一台
    const camera = entities.find((entity) => entity.has(Camera));
    if (!car) throw new Error(`?drive: no entity named '${name}' in the world`);
    if (!camera) throw new Error('?drive: the scene has no camera');
    camera.add(CameraRig.with({ follow: car.id, lookAt: car.id, offset: [0, 2.6, 7.5], followFrame: 'target', followDamping: 0.15, lookOffset: [0, 1, 0] }));
  }
}
