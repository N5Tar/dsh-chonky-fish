# 平台层（src/platform）设计

## 目的

同一个插件要跑在 macOS / Windows / Linux 上。凡是 **文件系统与路径语义** 上会随操作系统变化的
行为，集中放在 `src/platform/`，业务模块只调用能力，不判断 `process.platform`、不自己写兼容分支。

## 布局

```
src/platform/
  index.js         选路：process.platform → 具体实现；导出 createPlatform/platform/describePlatform
  posix.js         文件系统语义（macOS / Linux / *BSD）
  win32.js         Windows 语义
  tests/run-platform.mjs
```

选路只发生在 `index.js`：

```js
export const platform = platformNameFor() === 'win32' ? win32Platform : posixPlatform
```

业务模块一律 `import { platform } from '../platform/index.js'`。

## 当前能力

| 能力 | POSIX | Windows | 说明 |
|---|---|---|---|
| `syncDirectory(dir)` | 打开目录句柄并 fsync | **空实现** | rename 之后让目录项可持久化；Windows 没有对应操作 |
| `isWithin(root, path)` | `'/'` 边界、大小写敏感 | `'\\'`/`'/'` 均可、大小写不敏感、识别盘符 | 判断绝对路径是否位于某个根目录下 |
| `directorySync` | `true` | `false` | 诊断字段 |
| `caseInsensitivePaths` | `false` | `true` | 诊断字段 |

`describePlatform()` 返回 `{ name, directorySync, caseInsensitivePaths }`，便于面板/日志说明"当前实际生效的是哪套语义"。

## 持久化契约差异（必须写清）

两边都保证：先写临时文件 → `file.sync()` → 原子 `rename`，因此**不会读到半个文件**。

差别只在目录项：

- POSIX：目录 fsync 成功，`rename` 在掉电后仍可见；只有 `ENOTSUP`/`ENOSYS`（文件系统表达不了）会被吞掉，其他错误照旧抛出。
- Windows：**不做也不会成功**。`FlushFileBuffers` 只对文件句柄有效，目录句柄会得到 `EPERM`/`EISDIR`/`EINVAL`。
  所以这里是显式 no-op，而不是"试一下再把错误吞掉"——后者会把"平台不支持"伪装成"操作成功"。

如果将来需要跨平台一致的崩溃一致性，方案是**单文件 append-only journal**（只 fsync 文件），
而不是"两个文件 + rename + 目录 fsync"。

## 加一个操作系统 / 加一个能力

1. 在 `src/platform/` 新增 `<os>.js`，导出同名能力（可以先用 POSIX 版本兜底）。
2. 在 `index.js` 的 `platformNameFor()` 与 `platform` 选路里登记。
3. 在 `tests/run-platform.mjs` 增加该实现的用例（能力函数应当是纯函数或可注入依赖，保证在任何 host 上都能测）。
4. 业务模块不改，只换 `platform` 的实现。

## 约束（由测试守着）

- `src/` 下除 `src/platform/` 外，**不允许出现 `process.platform`**。
- 业务模块不允许自己 `open(dir).sync()`，也不允许用 `relative(resolve(...))` 之类的字符串前缀判断路径归属。
- 路径归属判断必须走 `platform.isWithin`；目录持久化必须走 `platform.syncDirectory`。

`src/platform/tests/run-platform.mjs` 会扫描 `src/**/*.js`（跳过 `tests/` 与 `platform/`）执行上述检查，
并且在任何 host 上都能跑（win32 的 `isWithin` 是纯字符串实现，不需要真的在 Windows 上）。

## 路径与依赖边界补充

- `isSamePath(left, right)` 判断同一路径；`isWithin(root, target)` 仅判断严格子路径。两者接收调用方 resolve 后的绝对路径，均不解析符号链接。
- 会话身份判断使用这两个接口，避免 Windows 路径大小写差异导致漏采集。POSIX 的 `/` 根目录同样支持子路径判断。
- 业务模块只能导入 `platform/index.js`；两份平台实现仅依赖 Node 内建模块，不依赖业务层或彼此。
- 静态测试检查常见的直接实现导入和路径前缀写法；它是回归护栏，不是完整 JavaScript 语法分析器。
- macOS 与 Linux 当前共享 POSIX 实现；这里的大小写规则是词法比较策略，不是对实际卷大小写敏感性的探测。
