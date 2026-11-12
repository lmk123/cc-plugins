# cc-plugins

lmk123 自用的 [Claude Code](https://docs.claude.com/en/docs/claude-code) 插件市场。

## 使用

添加市场：

```bash
claude plugin marketplace add lmk123/cc-plugins
```

安装插件：

```bash
claude plugin install context-keeper@lmk123
```

或在 Claude Code 交互界面中使用 `/plugin marketplace add lmk123/cc-plugins` 和 `/plugin install context-keeper@lmk123`。

更新市场：

```bash
claude plugin marketplace update lmk123
```

### 在项目中共享插件

以项目范围（`--scope project`）安装插件时，Claude Code 只会往项目的 `.claude/settings.json` 写入 `enabledPlugins`，不会记录市场来源。换一台没添加过本市场的电脑打开项目，Claude Code 不认识 `lmk123`，会直接跳过这些插件，也不会提示安装。

要让其他电脑（或其他协作者）打开项目时自动提示安装，需要在 `.claude/settings.json` 里手动补上 `extraKnownMarketplaces`：

```json
{
  "extraKnownMarketplaces": {
    "lmk123": {
      "source": {
        "source": "github",
        "repo": "lmk123/cc-plugins"
      }
    }
  },
  "enabledPlugins": {
    "context-keeper@lmk123": true
  }
}
```

提交后，在新电脑上打开项目并信任该文件夹时，Claude Code 会先提示添加 `lmk123` 市场，再提示安装 `enabledPlugins` 中的插件。`extraKnownMarketplaces` 要在信任文件夹后才生效。

## 插件列表

| 插件 | 说明 |
| --- | --- |
| [context-keeper](plugins/context-keeper) | 整理与沉淀项目上下文：CLAUDE.md 常驻部分尽量小，单个文件的知识写成紧贴代码的短注释，多个文件共用的写成 rule，扩展内容进 .context/ 并在原处留指针按需读；兼容 monorepo 与单仓库 |

## 目录结构

```
.
├── .claude-plugin/
│   └── marketplace.json        # 市场清单，列出所有插件
└── plugins/
    └── <plugin-name>/
        ├── .claude-plugin/
        │   └── plugin.json     # 插件清单
        ├── commands/           # 斜杠命令（*.md）
        ├── agents/             # 子代理（*.md）
        ├── skills/             # skills（<name>/SKILL.md）
        ├── hooks/hooks.json    # hooks
        ├── .mcp.json           # MCP servers
        └── README.md
```

只需创建用得到的目录即可。

## 新增插件

1. 在 `plugins/` 下新建目录，例如 `plugins/my-plugin/`。
2. 创建 `plugins/my-plugin/.claude-plugin/plugin.json`（可参考 [context-keeper](plugins/context-keeper/.claude-plugin/plugin.json)）。
3. 按需添加 `commands/`、`agents/`、`skills/`、`hooks/` 等组件。
4. 在 [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) 的 `plugins` 数组中登记该插件。
5. 校验：

   ```bash
   claude plugin validate .
   claude plugin validate plugins/my-plugin
   ```

6. 本地调试：`claude plugin marketplace add ./` 后安装测试。

## License

[MIT](LICENSE)
