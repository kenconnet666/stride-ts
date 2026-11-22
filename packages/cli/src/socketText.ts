import type { RawData } from 'ws';

/** ws 收到的一条消息的文字（Buffer、分片的 Buffer 数组或 ArrayBuffer，都按 UTF-8 解）。 */
export function socketText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
