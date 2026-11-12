// 测试共用：建临时仓库、跑 hook 和检查脚本。跑法：node --test plugins/context-keeper/tests/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// files: { 仓库内相对路径: 内容 }。返回 { repo, tmp }：tmp 下另有 hook 的状态目录和转录文件，不放进仓库
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

function run(script, input, { tmp, env = {} }) {
  const r = spawnSync('node', [path.join(SCRIPTS, script)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp, ...env }, // os.tmpdir() 跟着 TMPDIR 走，状态文件落在 tmp 里
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

// 转录里的几种行。msg 是这次工具调用所在的 assistant 消息 id：同一条消息的几个工具调用各占一行，id 相同
export const use = (id, name, input, msg) => JSON.stringify({ type: 'assistant', message: { ...(msg ? { id: msg } : {}), content: [{ type: 'tool_use', id, name, input }] } });
export const result = (id, isError = false) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x', ...(isError ? { is_error: true } : {}) }] } });
export const compact = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary' });

// 模拟一次 Edit 触发 pointer-guard。返回拦截消息，放行时返回 null。
// toolUseId 是这次 Edit 自己的 tool_use id：要让 hook 查得到它在哪条消息里，transcript 里得有对应的 use() 行
export function guard(t, { file, old, session = 's1', agent, transcript = [], cwd, env, toolUseId }) {
  const transcriptPath = path.join(t.tmp, `${session}.jsonl`);
  fs.writeFileSync(transcriptPath, transcript.join('\n') + '\n');
  const out = run('pointer-guard.mjs', {
    hook_event_name: 'PreToolUse',
    session_id: session,
    ...(agent ? { agent_id: agent } : {}),
    ...(toolUseId ? { tool_use_id: toolUseId } : {}),
    transcript_path: transcriptPath,
    cwd: cwd || t.repo,
    tool_name: 'Edit',
    tool_input: { file_path: path.join(t.repo, file), old_string: old, new_string: 'x' },
  }, { tmp: t.tmp, env });
  return out ? out.permissionDecisionReason : null;
}

export function sessionStart(t, { session = 's1', source }) {
  run('pointer-guard.mjs', { hook_event_name: 'SessionStart', session_id: session, source }, { tmp: t.tmp });
}

// 把状态里的拦截时间往前拨，省得真等 3 秒的重复拦截窗口过去
export function age(t, ms = 5000) {
  const dir = path.join(t.tmp, 'context-keeper');
  for (const f of fs.readdirSync(dir)) {
    const state = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const k of Object.keys(state)) state[k].t -= ms;
    fs.writeFileSync(path.join(dir, f), JSON.stringify(state));
  }
}

// 模拟 Write / Edit 之后触发 comment-hook。返回提醒文字，没提醒时返回 null
export function commentHook(t, { file, tool = 'Write', response }) {
  const out = run('comment-hook.mjs', {
    cwd: t.repo,
    tool_name: tool,
    tool_input: { file_path: path.join(t.repo, file) },
    tool_response: response,
  }, { tmp: t.tmp });
  return out ? out.additionalContext : null;
}

export function check(t, args = []) {
  const r = spawnSync('node', [path.join(SCRIPTS, 'check.mjs'), ...args, '--json'], { cwd: t.repo, encoding: 'utf8' });
  return { status: r.status, ...JSON.parse(r.stdout) };
}
