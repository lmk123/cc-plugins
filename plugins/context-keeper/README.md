# context-keeper

整理与沉淀项目上下文：CLAUDE.md 的常驻部分尽量小，读代码得不到的背景集中放进项目文档，碰到相关代码时才加载，不散在 CLAUDE.md 和代码注释里。兼容 monorepo 与单仓库。

## 它解决什么

不加约束时，项目知识会往两个地方堆：

- **CLAUDE.md**：每条都常驻，越写越长，大部分内容和当前任务无关。
- **代码注释**：为什么这么写、以前的方案、实测数字，一段段写在代码里，读代码的人被迫看一遍历史。

context-keeper 把这些内容按"什么时候需要知道"分流：

| 内容 | 去处 | 什么时候进 context |
| --- | --- | --- |
| 任何任务都可能违反的硬约束 | `CLAUDE.md`，一条一行 | 一直 |
| 碰到特定文件才需要知道的"做什么" | `.claude/rules/<领域>/<name>.md`，带 `paths:` | 读/改到匹配文件时 |
| 有步骤的流程 | `.claude/skills/<name>/SKILL.md` | 启动时只有 description |
| 读代码得不到的背景（原因、实测数字、踩坑经过、外部约束……） | `.context/<领域>/<slug>.md` | 碰到该领域代码时，领域索引 rule 列出文档清单，按需读 |
| 个人偏好 / 环境绑定 | 不进仓库，留在自动记忆 | — |

monorepo 中，只涉及一个包的内容放进该包自己的 `CLAUDE.md`、`.claude/`、`.context/`，跨包内容放在仓库根。

## 怎么起作用

**写入端**

- `record-context`：要记一条项目知识时，决定它写到哪里，按模板写入，并登记进领域索引。
- 根 CLAUDE.md 的「更多上下文」索引里有一行常驻的写入约定，让 Claude 默认不把背景写成长注释或只记在自动记忆里。
- PostToolUse hook：Claude 写入 5 行以上的独立注释块时，提醒它考虑移进 `.context/`。只提醒、不阻断，JSDoc、license、行尾注释不算。设环境变量 `CONTEXT_KEEPER_COMMENT_HOOK=0` 可关闭。

**读取端**

`.context/` 里的文档不会自动加载。每个领域有一个 `.claude/rules/<领域>/context-index.md`，`paths` 覆盖这个领域的代码，正文是文档清单：

```markdown
---
paths:
  - "src/api/**"
---

api 相关的项目文档，改动前按需读：
- `apps/web/.context/api/retry-policy.md`：改重试次数、退避间隔前
```

改 `src/api/` 下的代码时，这几行自动进 context，Claude 知道有哪些文档、什么时候该读。代码里不需要再留"原因见……"的注释，除非那个位置确有讲究。

**整理与体检**

- `organize-context`：把现有项目迁移到这套结构，已经在用的项目则做体检。先出计划，批准后才动文件。也能把自动记忆里与环境无关的内容沉淀进项目。
- `scripts/check.mjs`：确定性检查，skill 会自动调用，也可以手动跑：

  ```bash
  node <插件目录>/scripts/check.mjs [路径] [--comments]
  ```

  检查 rule 的 `paths` 是否生效、`@` import、文档命名、失效指针、孤儿文档等，有错误时退出码为 1。没有依赖，可以复制进项目接 CI。

## 改造前后

改造前，`apps/web/src/api/retry.ts`：

```ts
// 重试次数固定为 3。以前是 5 次，但上游网关连续 5 次失败
// 会把客户端 IP 拉黑 10 分钟，线上出过一次事故。
// 首次 + 3 次重试 = 4 次，留一次余量。
// 试过在网关前加熔断，和网关限流叠加后导致长时间不可用，放弃了。
// 退避从 200ms 起指数增长。
const MAX_RETRY = 3;
```

改造后：

```ts
// 重试次数不能超过 3，原因见 apps/web/.context/api/retry-policy.md
const MAX_RETRY = 3;
```

背景进了 `apps/web/.context/api/retry-policy.md`，并登记在 `apps/web/.claude/rules/api/context-index.md`。

## 从 0.2.x 升级

0.3.0 调整了文档结构：

- 文件名去掉日期前缀：`2026-09-05-retry-policy.md` → `retry-policy.md`
- 第一份文档就放进领域目录，不再"攒够 3 份再分"
- 新增领域索引 rule，文档要登记进去才会被读到
- 不再专门兼容 0.1.x 的 `context/decisions/`、`context/data/`，体检时它们按"按类型分目录的文档"处理，建议迁走

升级后跑一次 `organize-context`，它会列出要改名、移动、登记的文档和要同步的指针，批准后执行。

完整规范见 [references/layout.md](references/layout.md)，模板见 [references/templates.md](references/templates.md)。
