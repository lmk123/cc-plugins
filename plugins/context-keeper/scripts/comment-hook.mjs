#!/usr/bin/env node
// PostToolUse hook：Write / Edit / MultiEdit 新写入了长注释块时，提醒 Claude 背景信息该进 rule 或 .context/。
// 只提醒，不阻断。设环境变量 CONTEXT_KEEPER_COMMENT_HOOK=0 可关闭。

import fs from 'node:fs';
import { findCommentBlocks } from './lib/comments.mjs';

if (process.env.CONTEXT_KEEPER_COMMENT_HOOK === '0') process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const tool = input.tool_name;
const ti = input.tool_input || {};
const file = ti.file_path;
if (!file || !['Write', 'Edit', 'MultiEdit'].includes(tool)) process.exit(0);
if (/(^|[\\/])(\.context|\.claude|node_modules)([\\/])/.test(file)) process.exit(0);

const pieces = [];
if (tool === 'Write') pieces.push({ next: ti.content || '', prev: '' });
else if (tool === 'Edit') pieces.push({ next: ti.new_string || '', prev: ti.old_string || '' });
else for (const e of ti.edits || []) pieces.push({ next: e.new_string || '', prev: e.old_string || '' });

let current = null;
try {
  current = fs.readFileSync(file, 'utf8');
} catch {}

const squash = (s) => s.replace(/\s+/g, ' ').trim();
const hits = [];
for (const { next, prev } of pieces) {
  const base = tool !== 'Write' && current ? current.indexOf(next) : 0;
  const offset = base > 0 ? current.slice(0, base).split('\n').length - 1 : 0;
  const prevSquashed = squash(prev);
  const nextLines = next.split(/\r?\n/);
  for (const b of findCommentBlocks(next, file)) {
    const raw = squash(nextLines.slice(b.start - 1, b.end).join('\n'));
    if (prevSquashed && prevSquashed.includes(raw)) continue; // 原来就有的注释，不是这次新写的
    hits.push(`第 ${b.start + offset}–${b.end + offset} 行（${b.lines} 行）`);
  }
}
if (!hits.length) process.exit(0);

const msg = [
  `[context-keeper] 刚写入的 ${file} 里有长注释块：${hits.join('、')}。`,
  '如果其中讲的是为什么这么做、以前的方案、实测数字、踩坑经过、外部约束这类背景，按 context-keeper 规范用 record-context 把它移进 paths 指向这个文件的 rule（放不下的才进 .context/ 文档），',
  '原处只在这段代码确有讲究（顺序不能换、数值不能随便改）时留一行带路径的指针。注释只是在说明这段代码做什么、怎么用的，忽略本提示。',
].join('');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: msg },
}));
