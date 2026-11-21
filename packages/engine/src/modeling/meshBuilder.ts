/**
 * 建三角形网格的小工具（样条、树这些生成的几何共用）：顶点每个 8 个数（位置、法线、UV），按法线定绕向（逆时针朝着法线是正面），
 * 一个材质槽一个 MeshBuilder，最后换成按槽分好的网格（slotMeshes）。
 */

/** 一个材质槽的三角形网格（同 polyMesh.ts 的 PolySlotMesh）。 */
export interface SlotMesh {
  readonly material: number;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
}

export class MeshBuilder {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];

  vertex(position: readonly number[], normal: readonly number[], u: number, v: number): number {
    this.vertices.push(position[0]!, position[1]!, position[2]!, normal[0]!, normal[1]!, normal[2]!, u, v);
    return this.vertices.length / 8 - 1;
  }

  /** 四边形 a b c d：按法线定绕向（逆时针朝着法线是正面）。 */
  quad(a: number, b: number, c: number, d: number, normal: readonly number[]): void {
    const p = (i: number) => this.vertices.slice(i * 8, i * 8 + 3);
    const facing = dot(cross(sub(p(b), p(a)), sub(p(c), p(a))), normal);
    if (facing >= 0) this.indices.push(a, b, c, a, c, d);
    else this.indices.push(a, c, b, a, d, c);
  }

  /** 三角形 a b c：按法线定绕向。 */
  triangle(a: number, b: number, c: number, normal: readonly number[]): void {
    const p = (i: number) => this.vertices.slice(i * 8, i * 8 + 3);
    if (dot(cross(sub(p(b), p(a)), sub(p(c), p(a))), normal) >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }
}

/** 各个槽的网格（空的槽不要），material 是槽的下标。 */
export function slotMeshes(slots: readonly MeshBuilder[]): SlotMesh[] {
  return slots.flatMap((builder, material) => (builder.indices.length === 0 ? [] : [{ material, vertices: Float32Array.from(builder.vertices), indices: Uint32Array.from(builder.indices) }]));
}

const sub = (a: readonly number[], b: readonly number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
