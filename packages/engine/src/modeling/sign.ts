/**
 * 招牌的生成（`.sign.json`，格式见 content/formats/signFormat.ts）：外框是一个盒子，字面是贴在正面（和背面）的一片，字是字体
 * 轮廓的路径画进图集；灯箱的字面整块发光（字和底都亮，同真的灯箱），挂牌不发光。走 ProductBatch，同货架出一个模型、图集和材质。
 */
import type { SignFile } from '../content/formats/signFormat.ts';
import { hash32, seededRandom } from '../data/hash.ts';
import { textPath } from './product.ts';
import { svgNumber } from './svg.ts';
import { ProductBatch, type Cell, type MergedProducts } from './productBatch.ts';
import type { TextFont } from './textOutline.ts';

/** 字面比外框往里缩多少（米）、往外凸多少（贴在框的面上，不和框打架）。 */
const INSET = 0.02, PROUD = 0.002;

/**
 * 地贴的 SVG（毫米，透明底，见格式的说明）：外形填底色、白色描边，字在中间（箭头的在杆上）；wear 大于 0 时用遮罩按种子擦掉
 * 几道踩出来的划痕和几片磨掉的斑。
 */
export function floorStickerSvg(file: SignFile, font: TextFont | undefined, where = file.name): string {
  const [w, h] = file.size;
  if (!(w > 0 && h > 0)) throw new Error(`${where}: a floor sticker needs a width and a length greater than 0`);
  const W = w * 1000, H = h * 1000, stroke = Math.min(W, H) * 0.04;
  const fill = file.colors?.background ?? '#f6c40f', frame = file.colors?.frame ?? '#ffffff', ink = file.colors?.text ?? '#1d1d1f';
  const n = svgNumber;
  const outline = `fill="${fill}" stroke="${frame}" stroke-width="${n(stroke)}" stroke-linejoin="round"`;
  let shape: string, text: [number, number, number, number] = [W / 2, H / 2, W * 0.78, H * 0.6];
  switch (file.shape ?? 'rect') {
    case 'round': {
      const r = Math.min(W, H) / 2 - stroke / 2;
      shape = `<circle cx="${n(W / 2)}" cy="${n(H / 2)}" r="${n(r)}" ${outline}/>`;
      text = [W / 2, H / 2, r * 1.3, r * 0.8];
      break;
    }
    case 'arrow': {
      // 箭头朝上：头占长的四成（最多宽的九成），杆宽是宽的 36%
      const head = Math.min(H * 0.42, W * 0.9), s = stroke / 2, l = W * 0.32, r = W * 0.68;
      shape = `<path d="M${n(W / 2)} ${n(s)}L${n(W - s)} ${n(head)}L${n(r)} ${n(head)}L${n(r)} ${n(H - s)}L${n(l)} ${n(H - s)}L${n(l)} ${n(head)}L${n(s)} ${n(head)}Z" ${outline}/>`;
      text = [W / 2, (head + H) / 2, W * 0.3, (H - head) * 0.7];
      break;
    }
    default:
      shape = `<rect x="${n(stroke / 2)}" y="${n(stroke / 2)}" width="${n(W - stroke)}" height="${n(H - stroke)}" rx="${n(Math.min(W, H) * 0.12)}" ${outline}/>`;
  }
  const label = file.text && font ? textPath(font, file.text, text[0], text[1], text[2], text[3], ink) ?? '' : '';
  const wear = Math.min(1, Math.max(0, file.wear ?? 0));
  let mask = '', masked = '';
  if (wear > 0) {
    // 擦掉的：几道细长的划痕、几片不规则的斑（黑色在遮罩里就是透明）
    const random = seededRandom(hash32(file.seed ?? 1, 41));
    const marks: string[] = [];
    for (let i = 0; i < Math.round(30 * wear); i++) {
      const x = random() * W, y = random() * H, length = Math.min(W, H) * (0.1 + random() * 0.4);
      marks.push(`<rect x="${n(x - length / 2)}" y="${n(y)}" width="${n(length)}" height="${n(Math.min(W, H) * (0.004 + random() * 0.01))}" transform="rotate(${n(random() * 40 - 20)} ${n(x)} ${n(y)})" opacity="${n(0.4 + random() * 0.6)}"/>`);
    }
    for (let i = 0; i < Math.round(12 * wear); i++) {
      marks.push(`<ellipse cx="${n(random() * W)}" cy="${n(random() * H)}" rx="${n(Math.min(W, H) * (0.02 + random() * 0.06))}" ry="${n(Math.min(W, H) * (0.01 + random() * 0.03))}" opacity="${n(0.3 + random() * 0.5)}"/>`);
    }
    mask = `<mask id="wear"><rect width="${n(W)}" height="${n(H)}" fill="#fff"/><g fill="#000">${marks.join('')}</g></mask>`;
    masked = ' mask="url(#wear)"';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}">${mask}<g${masked}>${shape}${label}</g></svg>`;
}

/** 生成招牌；font 是读好的字体（没有时字面只有底色）。 */
export function signModel(file: SignFile, font: TextFont | undefined, where = file.name): MergedProducts {
  const [w, h, d] = file.size;
  if (!(w > 0 && h > 0 && d > 0)) throw new Error(`${where}: size needs a width, height and depth greater than 0`);
  const style = file.style ?? 'lightbox';
  const lightbox = style === 'lightbox';
  // 吊旗、价牌：印的面盖满整块（没有外框），两面都印
  const printed = style === 'banner' || style === 'stand';
  const background = file.colors?.background ?? (printed ? '#d7262b' : '#2f9e44'), ink = file.colors?.text ?? (printed ? '#f6e21a' : '#ffffff');
  const inset = printed ? 0 : INSET;
  const faceW = Math.max(0.01, w - 2 * inset), faceH = Math.max(0.01, h - 2 * inset);
  const batch = new ProductBatch({ products: new Map(), font: () => undefined }, where, [], {
    solids: [
      { color: file.colors?.frame ?? '#c8c9cc', roughness: 0.35, metalness: 0.7 },
      // 吊旗、价牌的边（同底色）、吊绳和底座（深色）
      { color: background, roughness: 0.5, metalness: 0 },
      { color: '#2a2b2e', roughness: 0.5, metalness: 0.2 },
    ],
    cells: [{
      size: [faceW * 1000, faceH * 1000], color: background, roughness: 0.3, metalness: 0, ...(lightbox ? { emissive: file.brightness ?? 3 } : {}),
      draw: ([x, y, cw, ch]: Cell) => (font ? textPath(font, file.text, x + cw / 2, y + ch / 2, cw * 0.86, ch * 0.72, ink) : undefined),
    }],
  });
  // 价牌的卡片在立杆顶上（原点在地面），别的以中心为原点
  const cy = style === 'stand' ? Math.max(h, file.standHeight ?? 1.2) - h / 2 : 0;
  batch.box([-w / 2, cy - h / 2, -d / 2], [w / 2, cy + h / 2, d / 2], printed ? EDGE : FRAME_SOLID);
  const face = (side: 1 | -1) => {
    const z = side * (d / 2 + PROUD), x = (faceW / 2) * side, y = faceH / 2;
    // 从这一面看：左下、右下、右上、左上（背面那一面的 x 反过来）
    batch.quad([[-x, cy - y, z], [x, cy - y, z], [x, cy + y, z], [-x, cy + y, z]], [0, 0, side], 0);
  };
  face(1);
  if (file.doubleSided || printed) face(-1);
  if (style === 'banner') {
    // 顶上一根横杆，两根吊绳往上收到一点
    const top = h / 2 + 0.012, hang = Math.max(0, file.hang ?? 0.5);
    batch.tube([-w / 2 - 0.015, top, 0], [w / 2 + 0.015, top, 0], 0.008, FRAME_SOLID, 8);
    if (hang > 0) for (const x of [-w * 0.4, w * 0.4]) batch.tube([x, top, 0], [0, top + hang, 0], 0.0015, CORD, 4);
  }
  if (style === 'stand') {
    // 圆底座（扁圆台盖顶）、立杆到卡片底
    batch.tube([0, 0, 0], [0, 0.02, 0], 0.16, CORD, 24);
    batch.tube([0, 0.02, 0], [0, 0.026, 0], 0.16, CORD, 24, 0);
    batch.tube([0, 0.02, 0], [0, cy - h / 2, 0], 0.012, FRAME_SOLID, 10);
  }
  return batch.finish();
}

/** 纯色的下标：外框（不锈钢）、吊旗价牌的边（同底色）、吊绳和底座。 */
const FRAME_SOLID = 0, EDGE = 1, CORD = 2;
