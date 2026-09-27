# context-keeper

整理与沉淀项目上下文：让 CLAUDE.md 的常驻部分尽量小，其余内容按需加载。兼容 monorepo 与单仓库。

## Skills

- `organize-context` —— 把现有项目迁移到这套结构；已经在用的项目则做一次体检，找出需要调整的地方。先出计划，批准后才动文件。也能把 Claude 自动记忆里与环境无关的内容沉淀进项目。
- `record-context` —— 当 Claude 或用户想记录一条持久知识时，决定它该写到哪里（CLAUDE.md、rule、skill、decision、data，或者不进仓库），并按模板写入。

## 结构速览

| 内容 | 去处 |
| --- | --- |
| 任何任务都可能违反的硬约束 | `CLAUDE.md`，一条一行 |
| 只在碰到特定文件时才需要知道的 | `.claude/rules/<领域>/<name>.md`，带 `paths:` |
| 有步骤的流程 | `.claude/skills/<name>/SKILL.md` |
| 为什么这么定 | `context/decisions/YYYY-MM-DD-<slug>.md` |
| 数字（耗时、benchmark、价格） | `context/data/<name>.md` |
| 个人偏好 / 环境绑定 | 不进仓库 |

monorepo 中，只涉及一个包的内容放进该包自己的 `CLAUDE.md`、`.claude/`、`context/`，跨包内容放在仓库根。

本插件只往 `.claude/` 里写 Claude Code 需要从那里加载的 rules 和 skills。decisions、data 这类沉淀文档放在 `context/`，因为 Claude 偶尔会把 `.claude/` 下的文件当成敏感配置而拒绝编辑。

完整规范见 [references/layout.md](references/layout.md)，模板见 [references/templates.md](references/templates.md)。
