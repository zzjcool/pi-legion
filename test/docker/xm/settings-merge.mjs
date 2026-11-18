#!/usr/bin/env node
// 容器内 settings.json 的 **MERGE**（不是覆盖写）—— 契约 §6 第 4 步。
//
// 为什么必须 merge：沙箱镜像的 /root/.pi/agent/settings.json 默认内容是
//   { "packages": ["npm:pi-any-endpoint@0.1.3", "../../../plugin"] }
// 它是 provider 注册（pi-any-endpoint）与 /plugin 挂载的**唯一来源**。
// 覆盖成 { "subagents": { "crossMachine": { "enabled": true } } } 会让容器里的
// `pi --list-models` 直接变成 "No models available"（实测踩过的坑）。
//
// 用法（宿主或容器内都行）：
//   node settings-merge.mjs [settingsPath] [patchJson]
//     settingsPath 默认 /root/.pi/agent/settings.json
//     patchJson    默认 {"subagents":{"crossMachine":{"enabled":true}}}
//
// 幂等：重复执行结果不变；文件缺失时从 {} 起步；原子写（tmp + rename）。
// 成功打印一行：XM_SETTINGS_MERGED path=<p> packages=<n> keys=<a,b>
// 失败 exit 1（含原因），绝不静默丢 key。

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from "node:fs";

const DEFAULT_PATH = "/root/.pi/agent/settings.json";
const DEFAULT_PATCH = { subagents: { crossMachine: { enabled: true } } };

const settingsPath = process.argv[2] || DEFAULT_PATH;
const patchJson = process.argv[3];

function die(message) {
  process.stderr.write(`XM_SETTINGS_FAIL ${message}\n`);
  process.exit(1);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** patch 覆盖 base：对象递归合并，其余（标量 / 数组）整体替换。 */
function mergeInto(base, patch) {
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeInto(out[key], value);
    } else if (isPlainObject(value)) {
      out[key] = mergeInto({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

let patch = DEFAULT_PATCH;
if (patchJson !== undefined) {
  try {
    patch = JSON.parse(patchJson);
  } catch (error) {
    die(`invalid patch JSON :: ${patchJson} :: ${error.message}`);
  }
  if (!isPlainObject(patch)) die(`patch must be a JSON object :: ${patchJson}`);
}

let before = {};
let existed = false;
if (existsSync(settingsPath)) {
  let raw;
  try {
    raw = readFileSync(settingsPath, "utf8");
  } catch (error) {
    die(`cannot read ${settingsPath} :: ${error.message}`);
  }
  if (raw.trim().length > 0) {
    try {
      before = JSON.parse(raw);
    } catch (error) {
      die(`${settingsPath} is not valid JSON :: ${error.message}`);
    }
  }
  existed = true;
}

const after = mergeInto(before, patch);

// 硬不变量：原文件里的 packages 一个都不能少（这就是 merge 存在的理由）。
const packagesBefore = Array.isArray(before.packages) ? before.packages : [];
const packagesAfter = Array.isArray(after.packages) ? after.packages : [];
for (const entry of packagesBefore) {
  if (!packagesAfter.includes(entry)) {
    die(`merge would drop packages entry "${entry}" from ${settingsPath}`);
  }
}

const body = `${JSON.stringify(after, null, 2)}\n`;
const tmp = `${settingsPath}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, body, { mode: existed ? statSync(settingsPath).mode & 0o777 : 0o644 });
  renameSync(tmp, settingsPath);
} catch (error) {
  die(`cannot write ${settingsPath} :: ${error.message}`);
}

process.stdout.write(
  `XM_SETTINGS_MERGED path=${settingsPath} existed=${existed} packages=${packagesAfter.length} keys=${Object.keys(after).sort().join(",")}\n`,
);
