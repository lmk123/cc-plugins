# context-keeper 模板

下面每个示例上方标注的是文件路径，不是文件内容。所有指向文档的路径都从仓库根写起。

## rule

**frontmatter 的 `---` 必须是文件第一行**，前面不能有任何内容（包括注释和空行）。

包内 rule，glob 相对该包写。文件 `apps/web/.claude/rules/styling/tokens.md`：

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

改 schema 后必须跑 `pnpm db:generate` 重新生成 apps/web 的类型。原因见 .context/db/generated-types.md
```

正文写"做什么"；原因一句话能说完的直接跟在后面（第一个示例），说不完的用一行路径指向文档（第二个示例）。

## 领域索引 rule

每个有文档的领域一个，文件名固定为 `context-index.md`，`paths` 覆盖这个领域的代码。文件 `apps/web/.claude/rules/api/context-index.md`：

```markdown
---
paths:
  - "src/api/**"
  - "src/hooks/useRequest.ts"
---

api 相关的项目文档，改动前按需读：
- `apps/web/.context/api/retry-policy.md`：改重试次数、退避间隔前
- `apps/web/.context/api/error-codes.md`：新增或改动错误码映射前
- `.context/auth-session-flow.md`：改登录态刷新、401 处理前
```

每份文档一行：仓库根起的路径 + 什么时候该读。不要把文档内容抄进来。

## 文档

没有固定模板，写什么、怎么分节按内容定。约束：

- 第一行是标题，说清这份文档讲的是什么主题
- 写现状，不按日期追加段落，情况变了就原地改
- 有条件成立的内容，在对应段落开头写明适用条件（如"仅 macOS："）
- 同一指标的多次实测用表格，新值追加一行，不覆盖旧值：

  ```markdown
  | 日期 | 改动 | 数值 | 测法 |
  |---|---|---|---|
  | 2026-09-05 | 引入路由级懒加载前 | 2.4s | Lighthouse 移动端 |
  | 2026-09-20 | 引入路由级懒加载后 | 1.1s | Lighthouse 移动端 |
  ```

示例，文件 `apps/web/.context/api/retry-policy.md`：

```markdown
# 请求重试策略

现在重试 3 次，间隔指数退避（200ms 起）。上限定在 3，是因为上游网关在连续 5 次失败后会把客户端 IP 拉黑 10 分钟：首次加 3 次重试共 4 次，留出一次余量。

试过在网关前加熔断，但网关本身的限流会和熔断叠加导致长时间不可用，已放弃。
```

文档只写背景。"改重试逻辑时总请求数不能超过 4"这类"做什么"的约束写成 rule；文档本身登记进 `api` 的领域索引 rule。

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
- 项目文档在 `.context/` 和各包的 `.context/`，按领域分目录；改某块代码时，对应领域的文档清单会通过 rule 自动加载
- 记下读代码看不出来的项目知识（原因、踩坑、实测数字、外部约束）：写进 `.context/` 或 `.claude/rules/`（装了 context-keeper 插件就用 `record-context`），不写成长注释，也不只记在自动记忆里
- 发布流程：用 `/release`
- 各包和各模块的专属约定会按路径自动加载，不用手动查
```

单仓库去掉"各包"的说法。第二行是常驻的写入约定，**不要省**：没有它，Claude 会按默认习惯把背景写进注释或自动记忆。索引里只列根作用域的 skill：包内 skill 要碰到该包的文件后才可用，名字也带目录前缀，写进根索引会指向一个调不到的命令。

包级 CLAUDE.md 所在的包有自己的 `.context/` 时，末尾加一行：

```markdown
本包的文档在 `apps/web/.context/`，按领域分目录。
```
