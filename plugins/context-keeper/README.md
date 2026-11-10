# context-keeper

整理与沉淀项目上下文：CLAUDE.md 的常驻部分尽量小，读代码得不到的背景挂在它所属的代码路径上（rule），rule 装不下或挂不到代码上的才进项目文档（`.context/`），不散在 CLAUDE.md 和代码注释里。兼容 monorepo 与单仓库。

## 它解决什么

不加约束时，项目知识会往两个地方堆：

- **CLAUDE.md**：每条都常驻，越写越长，大部分内容和当前任务无关。
- **代码注释**：为什么这么写、以前的方案、实测数字，一段段写在代码里，读代码的人被迫看一遍历史。

context-keeper 把这些内容按"什么时候需要知道"分流：

| 内容 | 去处 | 什么时候进 context |
| --- | --- | --- |
| 任何任务都可能违反的硬约束 | `CLAUDE.md`，一条一行 | 一直 |
| 碰到特定文件才需要知道的：做什么、坑，连同原因、经过、数字 | `.claude/rules/<领域>/<name>.md`，带 `paths:` | 读/改到匹配文件时，一定被看到 |
| 有步骤的流程 | `.claude/skills/<name>/SKILL.md` | 启动时只有 description |
| 能挂到代码上、但 rule 装不下的长背景（长篇权衡、实测数字的历史表格、外部系统调研） | `.context/<领域>/<slug>.md`，登记在领域索引 rule | 碰到该领域代码时出现文档清单，按需读 |
| 挂不到代码上的背景（评估过但没做的需求、外部系统限制、还没有代码的决定） | `.context/<领域>/<slug>.md`，登记在 `.context/README.md` | 根 CLAUDE.md 常驻一行指向入口，做新需求前查 |
| 个人偏好 / 环境绑定 | 不进仓库，留在自动记忆 | — |

monorepo 中，只涉及一个包的内容放进该包自己的 `CLAUDE.md`、`.claude/`、`.context/`，跨包内容放在仓库根。

### 为什么背景优先写进 rule

带 `paths` 的 rule 命中就一定被 Claude 看到；`.context/` 里的文档要 Claude 自己决定去读，还得另外维护登记行和指针。所以能挂到代码上的背景默认和"做什么"写在同一条 rule 里，只有 rule 正文超过 20 行、是会一直追加的实测表格、或几条 rule 共用同一段背景时，才拆进文档。

`.context/` 真正不可替代的，是**挂不到任何代码路径上**的知识。比如"分期付款评估过，支付渠道不支持，没做"：没有对应的代码，`paths` 触发不了；它该在有人再提这个需求时被看到。这类文档登记在 `.context/README.md`，由根 CLAUDE.md 常驻的一行指过去。

## 怎么起作用

**写入端**

- `record-context`：要记一条项目知识时，决定它写到哪里，按模板写入，并登记进对应入口。
- 根 CLAUDE.md 的「更多上下文」索引里有一行常驻的写入约定，让 Claude 默认不把背景写成长注释或只记在自动记忆里。
- PostToolUse hook：Claude 写入 5 行以上的独立注释块时，提醒它考虑移进 rule 或 `.context/`。只提醒、不阻断，JSDoc、license、行尾注释不算。设环境变量 `CONTEXT_KEEPER_COMMENT_HOOK=0` 可关闭。

**读取端**

- rule：碰到匹配的文件时自动加载，背景就在正文里。
- 领域索引 rule `.claude/rules/<领域>/context-index.md`：`paths` 覆盖这个领域的代码，正文是长文档的清单，碰到代码时这几行进 context，Claude 按需读文档。
- 文档入口 `.context/README.md`：挂不到代码上的文档清单，根 CLAUDE.md 里常驻一行：

  ```markdown
  - 做新需求、评估方案前，先看 `.context/README.md`：评估过但没做的需求、外部系统限制、还没有代码的决定
  ```

**整理与体检**

- `organize-context`：把现有项目迁移到这套结构，已经在用的项目则做体检。先出计划，批准后才动文件。也能把自动记忆里与环境无关的内容沉淀进项目。
- `scripts/check.mjs`：确定性检查，skill 会自动调用，也可以手动跑：

  ```bash
  node <插件目录>/scripts/check.mjs [路径] [--comments]
  ```

  检查 rule 的 `paths` 是否生效、rule 是否过长、`@` import、文档命名、失效指针、孤儿文档、文档入口有没有被根 CLAUDE.md 指到等，失效指针只查 CLAUDE.md、rule、skill、`.context/` 文档和源码，其他 Markdown 和代码块里的示例路径不算。有错误时退出码为 1。没有依赖，接 CI 时把 `check.mjs` 连同 `lib/` 目录一起复制进项目。

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
// 重试次数不能超过 3，原因见 apps/web/.claude/rules/api/retry.md
const MAX_RETRY = 3;
```

背景进了 `apps/web/.claude/rules/api/retry.md`（`paths: src/api/retry.ts`），改这个文件时自动加载，不需要另建文档。

## 从 0.3.x 升级

0.4.0 调整了 rule 和文档的分界：

- 以前 rule 只写"做什么"、原因超过一句就进文档；现在能挂到代码上的原因、经过、数字默认写进 rule，正文超过 20 行等情况才拆文档
- 新增文档入口 `.context/README.md`，登记挂不到代码上的文档，由根 CLAUDE.md 指过去；这类文档不再被当成"多半该删"
- 检查脚本新增：rule 正文过长、文档入口没被根 CLAUDE.md 指到；孤儿文档和缺领域索引的判断会认文档入口

升级后跑一次 `organize-context`，它会列出可以并回 rule 的短文档、该登记进 `.context/README.md` 的文档，以及要同步的指针，批准后执行。

完整规范见 [references/layout.md](references/layout.md)，模板见 [references/templates.md](references/templates.md)。
