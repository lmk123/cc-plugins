// 测试共用：建临时仓库、跑 comment-hook 和检查脚本。跑法：node --test plugins/context-keeper/tests/*.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// files: { 仓库内相对路径: 内容 }。返回 { repo, tmp }：tmp 是仓库的上一级，测试需要仓库外的目录时用它
export function makeRepo(files) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ck-test-')));
  const repo = path.join(tmp, 'repo');
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  spawnSync('git', ['init', '-q'], { cwd: repo });
  return { repo, tmp };
}

// 模拟 Write / Edit 之后触发 comment-hook。返回提醒文字，没提醒时返回 null
export function commentHook(t, { file, tool = 'Write', response }) {
  const input = {
    cwd: t.repo,
    tool_name: tool,
    tool_input: { file_path: path.join(t.repo, file) },
    tool_response: response,
  };
  const r = spawnSync('node', [path.join(SCRIPTS, 'comment-hook.mjs')], { input: JSON.stringify(input), encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : null;
}

export function check(t, args = []) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'check.mjs'), ...args, '--json'], { cwd: t.repo, encoding: 'utf8' });
  return { status: r.status, ...JSON.parse(r.stdout) };
}
