# context-keeper 模板

## rule

包内 rule，glob 相对该包写：

```markdown
<!-- packages/schema/.claude/rules/db/sync-generated.md -->
---
paths:
  - "src/**/*.ts"
---

改这里之后必须跑 `pnpm db:generate`，否则 apps/web 类型对不上但构建不报错。
```

根作用域的 rule（单仓库的所有 rule，或 monorepo 的跨包 rule），glob 从仓库根写完整路径：

```markdown
<!-- .claude/rules/db/schema-web-sync.md -->
---
paths:
  - "packages/schema/**/*.ts"
  - "apps/web/src/generated/**"
---

改 schema 后必须重新生成 apps/web 的类型。原因见 context/decisions/2026-08-12-generated-types.md
```

`paths` 要窄到能真正起过滤作用。正文写"做什么"，"为什么"用一行路径指向 decision。

## decision

```markdown
<!-- context/decisions/2026-09-05-retry-count.md -->
# 重试次数固定为 3

状态：生效

## 背景
<当时面对的问题>

## 决定
<定了什么>

## 放弃的方案
<考虑过什么、为什么不用>
```

日期只写在文件名里，正文不重复。不要用递增编号——并发的 worktree 会各自抢同一个号。

推翻旧决策时，新建一个文件，并把旧文件的「状态」改成 `已被 2026-10-01-retry-backoff.md 取代`（写新文件的文件名），不要删除旧文件。

## data

```markdown
# 首屏加载耗时

| 日期 | 版本/改动 | 数值 | 测法 |
|---|---|---|---|
| 2026-09-05 | 引入路由级懒加载前 | 2.4s | Lighthouse 移动端 |
```

数字必须带**日期**和**测法**，否则半年后没人知道它还成不成立。如果这个数字有更自然的归属（CHANGELOG、benchmark 输出、代码里的常量），优先建议放那儿。

## skill

```markdown
---
name: release
description: 发布 apps/web 到生产环境。当用户要求发布、上线、打 tag 时使用。
---

# 发布 apps/web

1. <步骤>
2. <步骤>
```

description 要写清"什么时候用"，它是启动时唯一常驻的部分。

## CLAUDE.md 索引小节

根 CLAUDE.md 末尾：

```markdown
## 更多上下文
- 历史决策：`context/decisions/` 和各包的 `context/decisions/`（改架构前先 grep 一遍）
- 发布流程：用 `/release`
- 各包和各模块的专属约定会按路径自动加载，不用手动查
```

单仓库去掉"各包"的说法。包/目录级 CLAUDE.md 有自己的 decisions/data 时，末尾加一行：

```markdown
本包的历史决策在 `apps/web/context/decisions/`，实测数据在 `apps/web/context/data/`。
```
