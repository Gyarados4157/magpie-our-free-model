import fs from 'node:fs';
import path from 'node:path';

const UPGRADE_FILE = 'packages/standalone/web/upgrade-magpie.js';
const PAGE = `import{j as e,d as L}from"./app.js";
export function Upgrade({summary:s}){const plugin=s?.pluginVersion??"—",ofm=s?.version??"—";
return e.jsxs("div",{className:"settings-browser","data-testid":"upgrade-ready",children:[
e.jsxs("header",{className:"dashboard-heading",children:[e.jsxs("div",{children:[
e.jsx("div",{className:"heading-eyebrow",children:"MANAGEMENT / UPGRADE"}),
e.jsx("h1",{children:"插件升级"}),
e.jsx("p",{children:"查看当前 Magpie 插件与内置 Our Free Model 运行时版本。该页独立于服务设置。"})]}),
e.jsx(L,{children:"本机"})]}),
e.jsxs("section",{className:"settings-card",children:[
e.jsx("h2",{children:"当前版本"}),
e.jsxs("p",{children:["Magpie 插件 ",e.jsx("strong",{children:plugin})]}),
e.jsxs("p",{children:["内置独立服务 / OFM 运行时 ",e.jsx("strong",{children:ofm})]}),
e.jsx("p",{className:"settings-note",children:"免费车道已迁移到 /inference/v1，会话映射保存在本插件数据目录。"})]}),
e.jsxs("section",{className:"settings-card",children:[
e.jsx("h2",{children:"如何更新"}),
e.jsx("p",{children:"Magpie 没有 DSH 应用内热升级。路径安装请在仓库目录执行 git pull --ff-only，然后完全退出并重启 Magpie。ZIP 安装请用新版文件替换旧目录，保留账号数据目录。"}),
e.jsx("p",{className:"footnote",children:"升级后重载插件或重启 Magpie 才会读取新的包入口与 vendor 快照。不要用删除数据目录或凭据的方式处理升级失败。"})]})]})}
`;

/** The one match, or a hard failure naming what upstream changed. */
function replaceMatch(source, pattern, build, label) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...source.matchAll(global)];
  if (matches.length !== 1) throw new Error(`Upstream console ${label} changed (${matches.length} matches)`);
  return source.replace(pattern, (...args) => build(...args));
}

/** Where a file sits in the bundle's own dependency array. */
function dependencyIndex(app, name) {
  const matches = [...app.matchAll(/\bm\.f=\[([^\]]*)\]/g)];
  if (matches.length !== 1) throw new Error(`Upstream console dependency array changed (${matches.length})`);
  const array = matches[0][1];
  const index = array.split(',').findIndex(entry => entry.trim() === `"${name}"`);
  if (index === -1) throw new Error(`Upstream console dependency array is missing ${name}`);
  return index;
}

export function patchConsoleUpgrade(directory) {
  const appFile = 'packages/standalone/web/app.js';
  const assetsFile = 'packages/standalone/web/assets.json';
  // The console bundle is minified and its asset hashes rotate every release,
  // so every anchor is a pattern with the identifiers and hashes captured from
  // the bundle itself; only the shape of the hook is asserted.
  let app = fs.readFileSync(path.join(directory, appFile), 'utf8');
  app = replaceMatch(app,
    /\{label:"管理",items:\[\{id:"settings",name:"服务设置",icon:([a-zA-Z_$][\w$]*)\}\]\}/,
    (match, icon) => `{label:"管理",items:[{id:"settings",name:"服务设置",icon:${icon}},{id:"upgrade",name:"插件升级",icon:${icon}}]}`,
    'nav');
  app = replaceMatch(app,
    /\["overview","models","usage","channels","eac","settings",/,
    match => match.replace('"settings",', '"settings","upgrade",'),
    'page list');
  app = replaceMatch(app,
    /settings:"服务设置",connection:"API 接入"/,
    match => match.replace('settings:"服务设置",', 'settings:"服务设置",upgrade:"插件升级",'),
    'page titles');
  app = replaceMatch(app,
    /"settings-([A-Za-z0-9_-]+)\.js"\]\)\)\)=>i\.map\(i=>d\[i\]\);/,
    (match, hash) => `"settings-${hash}.js","upgrade-magpie.js"])))=>i.map(i=>d[i]);`,
    'asset map');
  app = replaceMatch(app,
    /c==="models"\?\(\)=>import\("\.\/models-[A-Za-z0-9_-]+\.js"\):c==="usage"\?\(\)=>import\("\.\/usage-[A-Za-z0-9_-]+\.js"\):\(\)=>import\("\.\/settings-([A-Za-z0-9_-]+)\.js"\),__vite__mapDeps\(\[([0-9, ]+)\]\)/,
    (match, settings, deps) => {
      const upgrade = dependencyIndex(app, 'upgrade-magpie.js');
      return ':c==="upgrade"?()=>import("./upgrade-magpie.js"):()=>import("./settings-'
        + settings + '.js"),__vite__mapDeps(c==="upgrade"?[' + upgrade + ']:[' + deps + '])';
    },
    'lazy import');
  app = replaceMatch(app,
    /c==="models"\?"Models":c==="usage"\?"Usage":"Settings"/,
    match => match.replace('"Usage":"Settings"', '"Usage":c==="upgrade"?"Upgrade":"Settings"'),
    'lazy export');
  fs.writeFileSync(path.join(directory, appFile), app);
  let assets = fs.readFileSync(path.join(directory, assetsFile), 'utf8');
  assets = replaceMatch(assets,
    /  "settings-[A-Za-z0-9_-]+\.js",\n/,
    match => `${match}  "upgrade-magpie.js",\n`,
    'assets manifest');
  fs.writeFileSync(path.join(directory, assetsFile), assets);
  fs.writeFileSync(path.join(directory, UPGRADE_FILE), PAGE);
  return { appFile, assetsFile, upgradeFile: UPGRADE_FILE };
}
