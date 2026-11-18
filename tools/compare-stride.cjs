// 截 stride-ts 的画面（1280x720，藏掉统计文字），和桌面 Stride 的参考图（stride-capture/）逐像素比较：打印平均差（有符号、绝对值）
// 和差超过 10 的像素比例，输出目录里写 ours.png 和 diff.png（差 ×2 的灰度图）。设置是在页面里执行的一段脚本（关效果、固定曝光等）。
// 用法：node compare-stride.cjs <playwright> <地址> <参考图> <输出目录> [设置]
const { chromium } = require(process.argv[2]);
const fs = require('fs');
const [url, reference, out, setup = ''] = process.argv.slice(3);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.strideGame?.frames > 240, null, { timeout: 60000 });
  if (setup) await page.evaluate(setup);
  await page.waitForTimeout(setup ? 3000 : 0);
  await page.evaluate(() => { for (const e of document.querySelectorAll('#stats')) e.style.display = 'none'; });
  await page.waitForTimeout(200);
  const ours = await page.screenshot({ path: `${out}/ours.png` });
  const stats = await page.evaluate(async ([a, b]) => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); return i; };
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = ia.width, h = ia.height;
    const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, w, h).data;
    x.drawImage(ib, 0, 0, w, h); const db = x.getImageData(0, 0, w, h).data;
    const diff = x.createImageData(w, h);
    const sum = [0, 0, 0], abs = [0, 0, 0];
    let over10 = 0;
    for (let i = 0; i < da.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 3; k++) { sum[k] += da[i + k] - db[i + k]; abs[k] += Math.abs(da[i + k] - db[i + k]); d += Math.abs(da[i + k] - db[i + k]); }
      if (d / 3 > 10) over10++;
      const v = Math.min(255, d * 2);
      diff.data.set([v, v, v, 255], i);
    }
    const n = da.length / 4;
    const blob = await (async () => { const cc = new OffscreenCanvas(w, h); cc.getContext('2d').putImageData(diff, 0, 0); const bl = await cc.convertToBlob({ type: 'image/png' }); return [...new Uint8Array(await bl.arrayBuffer())]; })();
    return { size: [w, h, ib.width, ib.height], meanSigned: sum.map((s) => +(s / n).toFixed(2)), meanAbs: abs.map((s) => +(s / n).toFixed(2)), over10Percent: +(100 * over10 / n).toFixed(2), blob };
  }, ['data:image/png;base64,' + ours.toString('base64'), 'data:image/png;base64,' + fs.readFileSync(reference).toString('base64')]);
  fs.writeFileSync(`${out}/diff.png`, Buffer.from(stats.blob));
  delete stats.blob;
  console.log('ours minus Stride (0..255 per channel):', JSON.stringify(stats));
  await browser.close();
})();
