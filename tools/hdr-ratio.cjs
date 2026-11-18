// 截 stride-ts 的画面（可先执行设置），和参考图逐像素反推色调映射前的 HDR 值（sRGB → 线性 → Hejl2 白点 5 的反函数，曝光 EV0），
// 按画面的行分组打印 参考/我们 的比值（p10、中位数、p90）：比值处处相同说明是整体倍数（光强、反照率），随行变化说明和角度有关（高光、N·L）。
// 两边都要固定曝光 EV0、关掉 FXAA 和亮部提取（参考图用 stride-capture 的 --exposure 0 --disable fxaa,brightfilter）。
// 用法：node hdr-ratio.cjs <playwright> <地址> <参考.png> <输出目录> [设置]
const { chromium } = require(process.argv[2]);
const fs = require('fs');
const [url, reference, out, setup = ''] = process.argv.slice(3);
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(url);
  await page.waitForFunction(() => globalThis.strideGame?.frames > 240, null, { timeout: 60000 });
  if (setup) { await page.evaluate(setup); await page.waitForTimeout(3000); }
  await page.evaluate(() => { for (const e of document.querySelectorAll('#stats')) e.style.display = 'none'; });
  const ours = await page.screenshot();
  fs.writeFileSync(`${out}/ours.png`, ours);
  const result = await page.evaluate(async ([a, b]) => {
    const load = async (src) => { const i = new Image(); i.src = src; await i.decode(); const c = new OffscreenCanvas(i.width, i.height), x = c.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height).data; };
    const [ref, our] = [await load(a), await load(b)];
    const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const hejl = (x) => { const va = 1.425 * x + 0.05; return (x * va + 0.004) / (x * (va + 0.55) + 0.0491) - 0.0821; };
    const W = hejl(5);
    const inv = new Float32Array(256);
    for (let v = 0; v < 256; v++) { const y = lin(v) * W; let lo = 0, hi = 50; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (hejl(m) < y) lo = m; else hi = m; } inv[v] = (lo + hi) / 2; }
    const rows = [];
    for (let band = 0; band < 720; band += 60) {
      const ratios = [];
      for (let y = band; y < band + 60; y++) for (let x = 0; x < 1280; x++) {
        const p = (y * 1280 + x) * 4, r = ref[p + 1], o = our[p + 1];
        if (r > 20 && o > 20 && r < 250) ratios.push(inv[r] / inv[o]);
      }
      ratios.sort((p, q) => p - q);
      const q = (f) => ratios.length ? +ratios[Math.floor(f * (ratios.length - 1))].toFixed(2) : null;
      rows.push(`rows ${band}-${band + 59}: n=${ratios.length} p10=${q(0.1)} median=${q(0.5)} p90=${q(0.9)}`);
    }
    return rows;
  }, ['data:image/png;base64,' + fs.readFileSync(reference).toString('base64'), 'data:image/png;base64,' + ours.toString('base64')]);
  console.log(result.join('\n'));
  await browser.close();
})();
