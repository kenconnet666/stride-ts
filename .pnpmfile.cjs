// pnpm 10 给 URL 形式的 tarball 依赖（@stride-ts/native 从 GitHub Release 安装）不在锁文件里记 integrity，
// 之后的安装又因为没有 integrity 拒绝它（ERR_PNPM_MISSING_TARBALL_INTEGRITY）。依赖解析完以后在这里下载这些
// tarball、算出 sha512 补进锁文件，之后每次安装都按它校验下载的内容。
const { createHash } = require('node:crypto');

module.exports = {
  hooks: {
    async afterAllResolved(lockfile) {
      for (const [key, pkg] of Object.entries(lockfile.packages ?? {})) {
        const resolution = pkg.resolution;
        if (!resolution || resolution.integrity || !/^https?:\/\//.test(resolution.tarball ?? '')) continue;
        const response = await fetch(resolution.tarball);
        if (!response.ok) throw new Error(`${key}: downloading ${resolution.tarball} failed: HTTP ${response.status}`);
        const hash = createHash('sha512').update(Buffer.from(await response.arrayBuffer())).digest('base64');
        resolution.integrity = `sha512-${hash}`;
      }
      return lockfile;
    },
  },
};
