#!/usr/bin/env node
// Wire this plugin into the local DSH profile without touching pnpm resolution.
//
//   node scripts/install.mjs            # 挂载到当前 desktop profile（备份原文件）
//   node scripts/install.mjs --check    # 只看状态，不改
//   node scripts/install.mjs --uninstall
//
// What it does: adds a `link:` dependency to the profile package.json, adds a
// cordis.yml entry, and creates node_modules/dsh-wechat-voice as a junction.
// Everything is idempotent and backed up as <file>.bak-wechat-voice-<stamp>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const projectRoot = path.resolve(pluginDir, '..', '..');
const packageName = 'dsh-wechat-voice';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const uninstall = args.includes('--uninstall');

const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
const profileDir = process.env.DSH_PROFILE_DIR || path.join(dshHome, 'profiles', 'desktop');
const packageFile = path.join(profileDir, 'package.json');
const cordisFile = path.join(profileDir, 'cordis.yml');
const linkPath = path.join(profileDir, 'node_modules', packageName);

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = file => {
  const target = `${file}.bak-wechat-voice-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
};

function report() {
  const pkg = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')) : null;
  const cordis = fs.existsSync(cordisFile) ? fs.readFileSync(cordisFile, 'utf8') : '';
  let link = null;
  try { link = fs.readlinkSync(linkPath); } catch { link = null; }
  console.log(JSON.stringify({
    pluginDir,
    projectRoot,
    profileDir,
    dependency: pkg?.dependencies?.[packageName] ?? null,
    cordisEntry: new RegExp(`name:\\s*${packageName}\\b`).test(cordis),
    nodeModulesLink: link,
    linkHealthy: !!link && fs.existsSync(path.join(linkPath, 'index.js')),
  }, null, 2));
}

if (!fs.existsSync(packageFile)) {
  console.error(`找不到 DSH profile：${packageFile}（可用 DSH_PROFILE_DIR 指定）`);
  process.exit(1);
}
if (checkOnly) { report(); process.exit(0); }

try {
  if (uninstall) {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (pkg.dependencies?.[packageName]) { backup(packageFile); delete pkg.dependencies[packageName]; fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n'); }
    const cordis = fs.readFileSync(cordisFile, 'utf8');
    const trimmed = cordis.replace(new RegExp(`- id: ${packageName}\\n(?:  .*\\n)*?(?=-|$)`, 'g'), '');
    if (trimmed !== cordis) { backup(cordisFile); fs.writeFileSync(cordisFile, trimmed); }
    try { fs.unlinkSync(linkPath); } catch { /* already gone */ }
    console.log('已卸载（配置文件已备份）。重启 DSH 生效。');
    process.exit(0);
  }

  const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  pkg.dependencies = pkg.dependencies ?? {};
  const wanted = 'link:' + pluginDir.replaceAll('\\', '/');
  if (pkg.dependencies[packageName] !== wanted) {
    const saved = backup(packageFile);
    pkg.dependencies[packageName] = wanted;
    fs.writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    console.log(`已写入依赖：${packageName} = ${wanted}（备份 ${path.basename(saved)}）`);
  }

  let cordis = fs.readFileSync(cordisFile, 'utf8');
  if (!new RegExp(`name:\\s*${packageName}\\b`).test(cordis)) {
    const saved = backup(cordisFile);
    // Only id + name here: DSH strips config keys it does not know when it
    // rewrites this file, so durable settings live in state/voice/config.json.
    const entry = [
      `- id: ${packageName}`,
      `  name: ${packageName}`,
      '  config:',
      `    root: ${projectRoot.replaceAll('\\', '/')}`,
      '',
    ].join('\n');
    cordis = cordis.replace(/\s*$/, '\n') + entry;
    fs.writeFileSync(cordisFile, cordis);
    console.log(`已写入 cordis.yml 条目（备份 ${path.basename(saved)}）`);
  }

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try { fs.unlinkSync(linkPath); } catch { /* nothing linked yet */ }
  fs.symlinkSync(pluginDir, linkPath, 'junction');
  console.log(`已建立 node_modules 链接：${linkPath} -> ${pluginDir}`);

  report();
  console.log(['', '下一步：', '  1. 从托盘完整退出 DSH 再打开（插件在启动时加载）。',
    '  2. WeChatAgent → 聊天范围 → 选一个聊天 → 技能与工具 → 勾上 wechat_voice_say / wechat_voice_preview → 保存此会话。',
    '  3. 先跑 node scripts/preview.mjs --status 看 voiceRoute.supported。'].join('\n'));
} catch (error) {
  console.error('安装失败：' + (error?.message ?? error));
  process.exit(1);
}
