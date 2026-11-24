/**
 * 镜头系统（Stride 没有；照 Cinemachine 的跟随、注视、噪声）：放在相机实体上，每帧摆相机——跟着一个目标走（世界空间的偏移，
 * 平滑地跟），看着一个目标（看向它加上偏移的点，平滑地转），加上手持晃动（旋转、位置按平滑的噪声抖）。是数据组件，时间轴的
 * 属性轨道能直接驱动它的参数（比如晃动渐强、跟随时的偏移推近）。
 *
 * 相机要在场景的根上（位置、旋转按世界写）。编辑器里（game.editing）不动相机。平滑的参数是半衰期：剩下的距离过多少秒少一半，
 * 和帧率无关；0 是直接到。
 */
import { prop, type EntityId } from '../data/prop';
import { Quaternion, Vector3 } from '../data/vectors';
import { component } from '../engine/component';
import type { EntityManager } from '../engine/EntityManager';
import { system } from '../engine/system';
import { Transform } from '../engine/transform';

export const CameraRig = component('CameraRig', {
  /** 跟着它走；-1 是不跟（位置不动，除了晃动）。 */
  follow: prop.entity().default(-1 as EntityId),
  /** 跟随时相机在目标的哪里（相对目标的位置，followFrame 的空间）。 */
  offset: prop.vec3().default([0, 2, 6]),
  /** offset 的空间：world 是世界空间；target 跟着目标绕竖直轴转（追车、追人的镜头：+Z 是目标的背后），上下不跟着倾斜。 */
  followFrame: prop.enum(['world', 'target']).default('world'),
  followDamping: prop.f32().default(0.2).min(0).unit('s'),
  /** 看着它；-1 是不转（朝向不动，除了晃动）。 */
  lookAt: prop.entity().default(-1 as EntityId),
  /** 看向目标位置加上这个偏移的点（世界空间；看人的头而不是脚）。 */
  lookOffset: prop.vec3().default([0, 1, 0]),
  lookDamping: prop.f32().default(0.05).min(0).unit('s'),
  /** 手持晃动：旋转的幅度（度）、位置的幅度（米）、频率；幅度为 0 不晃。 */
  shakeRotation: prop.f32().default(0).min(0).unit('deg'),
  shakePosition: prop.f32().default(0).min(0).unit('m'),
  shakeFrequency: prop.f32().default(1).min(0).unit('Hz'),
});

/** 每台相机记着的：平滑过的位置、注视点，上一帧加上的晃动（不跟随、不注视时下一帧先去掉，免得越晃越偏）。 */
interface RigState {
  readonly position: Vector3;
  readonly aim: Vector3;
  started: boolean;
  readonly shakeOffset: Vector3;
  readonly shakeRotation: Quaternion;
  readonly seed: number;
}

const UP = new Vector3(0, 1, 0);

/** 镜头系统的系统：editing() 为真时不动。 */
export function cameraRigSystem(entities: EntityManager, editing: () => boolean) {
  const states = new Map<EntityId, RigState>();
  const target = new Vector3(), desired = new Vector3(), back = new Vector3(), local = new Vector3();
  const base = new Quaternion(), shake = new Quaternion(), inverse = new Quaternion();
  return system('CameraRig', {
    with: { rig: CameraRig },
    update: ({ rig, count, entities: rows }, time) => {
      if (editing()) return;
      const dt = time.elapsed, t = time.total;
      for (let row = 0; row < count; row++) {
        const id = rows[row]!;
        const transform = entities.entity(id).get(Transform);
        if (!transform) continue;
        let state = states.get(id);
        if (!state) {
          state = { position: new Vector3(), aim: new Vector3(), started: false, shakeOffset: new Vector3(), shakeRotation: new Quaternion(), seed: (id % 97) * 13.7 };
          states.set(id, state);
        }
        const follow = rig.follow[row]! as EntityId, lookAt = rig.lookAt[row]! as EntityId;
        const following = follow >= 0 && entities.isAlive(follow), looking = lookAt >= 0 && entities.isAlive(lookAt);
        // 不由镜头系统摆的那部分先去掉上一帧的晃动，回到"本来"的位姿
        const position = new Vector3().copy(transform.position);
        if (!following) position.subtract(state.shakeOffset);
        base.copy(transform.rotation);
        if (!looking) base.multiply(inverse.copy(state.shakeRotation).invert());

        if (following) {
          worldPosition(entities, follow, target);
          let ox = rig.offset[row * 3]!, oz = rig.offset[row * 3 + 2]!;
          const world = rig.followFrame[row] === 'target' ? entities.entity(follow).get(Transform)?.world : undefined;
          if (world) {
            // 目标的本地 +Z 在水平面上的方向是 (sin yaw, cos yaw)：偏移绕竖直轴转同样的角度
            const yaw = Math.atan2(world[8]!, world[10]!), c = Math.cos(yaw), s = Math.sin(yaw);
            [ox, oz] = [ox * c + oz * s, -ox * s + oz * c];
          }
          desired.set(target.x + ox, target.y + rig.offset[row * 3 + 1]!, target.z + oz);
          if (!state.started) state.position.copy(desired);
          else state.position.lerp(desired, smoothing(rig.followDamping[row]!, dt));
          position.copy(state.position);
        }
        if (looking) {
          worldPosition(entities, lookAt, target);
          desired.set(target.x + rig.lookOffset[row * 3]!, target.y + rig.lookOffset[row * 3 + 1]!, target.z + rig.lookOffset[row * 3 + 2]!);
          if (!state.started) state.aim.copy(desired);
          else state.aim.lerp(desired, smoothing(rig.lookDamping[row]!, dt));
          // 相机看的是本地 -Z：+Z 朝背离注视点的方向
          back.copy(position).subtract(state.aim);
          if (back.length() > 1e-5) base.copy(Quaternion.lookRotation(back, UP));
        }
        state.started = true;

        // 手持晃动：几个频率不成整数比的正弦叠起来，平滑、不重复；绕本地的三个轴转，沿本地的三个轴挪
        const amplitude = rig.shakeRotation[row]!, distance = rig.shakePosition[row]!, frequency = rig.shakeFrequency[row]!;
        if (amplitude > 0 || distance > 0) {
          const phase = t * frequency * Math.PI * 2;
          const radians = (amplitude * Math.PI) / 180;
          shake.setYawPitchRoll(noise(phase, state.seed) * radians, noise(phase, state.seed + 31.1) * radians, noise(phase, state.seed + 57.3) * radians * 0.5);
          local.set(noise(phase, state.seed + 7.9), noise(phase, state.seed + 19.4), 0).scale(distance).rotate(base);
        } else {
          shake.identity();
          local.set(0, 0, 0);
        }
        state.shakeRotation.copy(shake);
        state.shakeOffset.copy(local);
        transform.position = position.add(local);
        transform.rotation = new Quaternion().copy(base).multiply(shake);
      }
      // 去掉的相机不再记
      if (states.size > count) for (const id of [...states.keys()]) if (!entities.isAlive(id) || !entities.hasComponent(id, CameraRig)) states.delete(id);
    },
  });
}

/** 半衰期 halfLife 秒的平滑在 dt 秒里走剩下距离的多少。 */
function smoothing(halfLife: number, dt: number): number {
  return halfLife <= 0 ? 1 : 1 - Math.pow(2, -dt / halfLife);
}

/** -1..1 左右的平滑噪声：三个频率不成整数比的正弦。 */
function noise(phase: number, seed: number): number {
  return Math.sin(phase + seed) * 0.5 + Math.sin(phase * 2.137 + seed * 1.7) * 0.3 + Math.sin(phase * 4.371 + seed * 2.3) * 0.2;
}

function worldPosition(entities: EntityManager, id: EntityId, out: Vector3): void {
  const world = entities.entity(id).get(Transform)?.world;
  if (world) out.set(world[12]!, world[13]!, world[14]!);
}
