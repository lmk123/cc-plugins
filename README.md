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

## 插件列表

| 插件 | 说明 |
| --- | --- |
| [context-keeper](plugins/context-keeper) | 整理与沉淀项目上下文：CLAUDE.md 常驻部分尽量小，其余按需加载；兼容 monorepo 与单仓库 |

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
