# 大肥鱼 · 面板补充人格 → system prompt

面板里「补充人格设定」以前是拼在**新会话首条用户消息**里发出去的：

```text
【角色补充设定】……  【用户消息】……
```

这样 system 性质的内容和用户消息混在同一个 user message 里，模型看到的是「主人说了这一大段设定」。现在改成：

```text
panel state.json (state.prompt)
  → Host 注册 system prompt 变量 {{chonkyfish_supplement}}
  → 预设 persona 模板引用该变量（模板行内 `...如实说明。{{chonkyfish_supplement}}`）
  → 每次 assembly 动态渲染进 system prompt
  → 用户消息只包含用户真正输入的文字
```

## 工作方式

- **预设**（`cordis.patch.yml` / `preset/cordis.patch.yml`）的 persona `prefix` 末尾有一行
  `{{chonkyfish_supplement}}`，persona 仍然 `complete: true`，system prompt 依旧只有这一份人格；
- **Host**（[supplement.js](supplement.js)，在 [index.js](../../index.js) 注册）提供同名 system prompt 变量：
  - 读 `$DSH_HOME/chonkyfish/state.json` 的 `state.prompt`，按 mtime 缓存；
  - 等于默认文案 `DEFAULT_PANEL_PROMPT` 或为空时返回 `''`，渲染时该行自然消失；
  - 文件缺失/JSON 坏时返回 `''`，绝不抛错（system prompt 组装失败会拖垮整个会话）。
- **面板**（`src/runtime.js`）发送消息时不再拼接任何人格文案，用户消息只有用户输入。

## 注意

- persona 模板里的 `{{chonkyfish_supplement}}` 是**严格变量**：本 Host 插件必须加载，否则
  chonkyfish 会话的 system prompt 组装会报 `unknown prompt variable`。预设和面板由同一个 bundle
  安装/卸载，正常使用不会分离。
- 面板修改补充人格设定后，**下一轮**请求就会带上新内容（不需要重开会话）。
- 历史会话里已经写在首条用户消息中的旧前缀不会被改写；面板仍会把这类旧消息的
  `【角色补充设定】…【用户消息】` 前缀隐藏掉，只显示用户正文。
