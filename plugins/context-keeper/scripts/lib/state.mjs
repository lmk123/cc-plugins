// hook 的会话状态文件，pointer-guard.mjs 和 doc-hook.mjs 共用：各自记本会话里拦过、提醒过什么。
// 放在系统临时目录下，一个会话一个文件；kind 区分不同 hook 的状态。

import os from 'node:os';
import path from 'node:path';

const safe = (s) => String(s).replace(/[^\w-]/g, '_').slice(0, 120);

// 子代理里 session_id、transcript_path 都是主会话的，靠 agent_id 区分：状态各记各的
export function stateFile(input, kind = '') {
  const sid = safe(input.session_id || input.transcript_path || 'unknown');
  const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
  return path.join(os.tmpdir(), 'context-keeper', `${sid}${agentId ? `.${safe(agentId)}` : ''}${kind ? `.${kind}` : ''}.json`);
}
