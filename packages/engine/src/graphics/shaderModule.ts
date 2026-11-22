/**
 * 建着色器模块，编译出错时把出错的行打到控制台（会进调试 CLI 的日志）：游戏写的颜色树、着色器类、网格效果拼进来的 WGSL 出错时，
 * 不然只看到管线无效、画面全黑。
 */
export function createCheckedShaderModule(device: GPUDevice, label: string, code: string): GPUShaderModule {
  const module = device.createShaderModule({ label, code });
  void module.getCompilationInfo().then(({ messages }) => {
    const lines = code.split('\n');
    for (const m of messages) {
      if (m.type !== 'error') continue;
      console.error(`[stride] ${label}: WGSL ${m.lineNum}:${m.linePos}: ${m.message}\n  ${lines[m.lineNum - 1]?.trim() ?? ''}`);
    }
  });
  return module;
}
