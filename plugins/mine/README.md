# mine

只能由用户用斜杠命令主动调用的 skill 合集。这里的每个 skill 都在 frontmatter 里设了 `disable-model-invocation: true`，Claude 不会根据对话内容自行触发，只有你输入 `/mine:<skill>` 时才执行。

## 安装

先添加市场（已添加过可跳过），再安装：

```
/plugin marketplace add lmk123/cc-plugins
/plugin install mine@lmk123
```

## Skills

| 命令 | 作用 |
| --- | --- |
| `/mine:ppr` | 把当前分支推送到它所属 PR 的远程分支，再检查 PR 标题和描述是否还符合整个 PR 的改动，过时就直接改写 |

## 新增 skill

在 `skills/<name>/SKILL.md` 新建文件，frontmatter 至少包含：

```yaml
---
name: <name>
description: <一句话说明，显示在斜杠命令菜单里>
disable-model-invocation: true
---
```

漏掉 `disable-model-invocation: true` 的话，Claude 会按 `description` 自行判断何时调用，就违背了这个插件的用途。加完记得更新上面的表格，并把 `plugin.json` 和根目录 `marketplace.json` 里的版本号一起升级。
