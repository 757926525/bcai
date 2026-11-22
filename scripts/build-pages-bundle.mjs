import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');
const OUT_DIR = path.join(ROOT, 'dist-pages');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    throw new Error('请先运行 npm run build 生成前端 dist/ 产物');
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  copyDirRecursive(DIST_DIR, OUT_DIR);

  const workerEntry = path.join(ROOT, 'functions', '_worker-entry.ts');
  if (fs.existsSync(workerEntry)) {
    await esbuild.build({
      entryPoints: [workerEntry],
      bundle: true,
      outfile: path.join(OUT_DIR, '_worker.js'),
      format: 'esm',
      target: 'es2022',
      platform: 'browser',
      minify: true,
    });
  }

  for (const cfg of ['_routes.json', 'wrangler.toml', 'edgeone.json', 'esa.jsonc', 'netlify.toml', 'schema.sql']) {
    const src = path.join(ROOT, cfg);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, cfg));
    }
  }

  console.log(`✅ 已生成多平台 Pages 上传目录: ${OUT_DIR}`);
  console.log('   可直接上传 dist-pages/ 到 Cloudflare Pages / 腾讯云 EdgeOne Pages / 阿里云 ESA Pages');
}

main().catch((err) => {
  console.error('❌ 生成 Pages 部署包失败:', err);
  process.exit(1);
});
