# context-keeper 模板

## rule

**frontmatter 的 `---` 必须是文件第一行**，前面不能有任何内容（包括注释和空行），否则 `paths` 不生效，rule 会变成常驻。下面每个示例上方标注的是文件路径，不是文件内容。

包内 rule（只涉及这一个包），glob 相对该包写。文件 `apps/web/.claude/rules/styling/tokens.md`：

```markdown
---
paths:
  - "src/styles/tokens/*.css"
---

改这里的 token 后必须跑 `pnpm tokens:build`，否则 `src/styles/generated/` 不会更新，但页面不报错。
```

根作用域的 rule（单仓库的所有 rule，或 monorepo 的跨包 rule），glob 从仓库根写完整路径。文件 `.claude/rules/db/schema-web-sync.md`：

```markdown
---
paths:
  - "packages/schema/src/tables/*.ts"
  - "apps/web/src/generated/db/*.ts"
---

改 schema 后必须跑 `pnpm db:generate` 重新生成 apps/web 的类型。原因见 context/2026-08-12-generated-types.md
```

正文写"做什么"，"为什么"用一行路径指向文档。`paths` 的写法要求见 layout.md「硬约束」。

## 文档

没有固定模板，写什么、怎么分节由 Claude 按内容定。只有几条约束：

- 第一行是标题，说清这份文档讲的是什么主题，方便以后 grep 和判断要不要读
- 写的是现状，不是流水账：不按日期追加段落，情况变了就原地改（见 layout.md「硬约束」）
- 有条件成立的内容，在对应段落开头写明适用条件（如"仅 macOS："）
- 记数字时带上**日期**和**测法**，否则半年后没人知道它还成不成立；迁移来的数字原文没写的标 `未记录`，不要编造

示例，文件 `apps/web/context/api/2026-09-05-retry-policy.md`（文件名和领域目录的规则见 layout.md「硬约束」）：

```markdown
# 请求重试策略

重试次数固定为 3，间隔指数退避（200ms 起）。上游网关在连续 5 次失败后会把客户端 IP 拉黑 10 分钟，所以一次调用的总请求数（首次 + 重试）不能超过 4。

试过在网关前加熔断，但网关本身的限流会和熔断叠加导致长时间不可用，已放弃。
```

## skill

```markdown
---
name: release
description: 发布到生产环境。当用户要求发布、上线、打 tag 时使用。
---

# 发布

1. <步骤>
2. <步骤>
```

description 要写清"什么时候用"，它是启动时唯一常驻的部分。

## CLAUDE.md 索引小节

根 CLAUDE.md 末尾：

```markdown
## 更多上下文
- 项目文档：`context/` 和各包的 `context/`，按领域分目录（动手前先看对应领域，再 grep 一遍相关主题）
- 发布流程：用 `/release`
- 各包和各模块的专属约定会按路径自动加载，不用手动查
```

单仓库去掉"各包"的说法。索引里只列根作用域的 skill：包内 skill 要碰到该包的文件后才可用，名字也带目录前缀（如 `apps/web:release`），写进根索引会指向一个调不到的命令。包级 CLAUDE.md 所在的包有自己的 `context/` 时，末尾加一行：

```markdown
本包的文档在 `apps/web/context/`。
```
