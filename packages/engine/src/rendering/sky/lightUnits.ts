/**
 * 光源的强度换成照度。表面着色照 Stride：直射光 = 反照率 · 强度 · N·L（Lambert 的 1/π 和 Stride 的 "*PI over hemisphere" 抵掉了），
 * 所以 Stride 的强度 I 对应的物理照度是 E = π·I（点光、聚光的发光强度同理）。大气、云、体积雾按物理量算散射（相函数的单位是
 * 1/sr，散出的辐亮度 = E · σ · 相函数），光源的强度先乘这个数再喂进去，天空、天空给的环境光、雾里的光才和被直射光照亮的表面
 * 对得上。环境光（Stride 的 LightAmbient、天空盒的球谐）本来就是辐亮度，不乘。
 */
export const IRRADIANCE_PER_INTENSITY = Math.PI;
