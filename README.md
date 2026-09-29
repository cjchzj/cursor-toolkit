# 工作台 (cursor-toolkit)

非官方的 Cursor / VS Code 扩展，加上一个 Windows 托盘助手。用来截图、看额度、管理插件和 Skills，不改 Cursor 本体。

## 功能

- **截图**：`Alt+9` 选区截图，松手后可移动/缩放，再复制、保存或滚动拼接
- **悬浮窗**：`Alt+8` 打开工作台
- **额度**：显示上次用量（金额 + token）
- **中文界面**
- **独立助手**：用户级安装，登录后自动启动，Agent 打开时也能用

## 环境

- Windows
- [Cursor](https://cursor.com) 或 VS Code
- Node.js（打包和运行助手）
- .NET Framework 4.x（本机 `csc.exe` 编译截图组件）

## 安装

```bash
git clone https://github.com/cjchzj/cursor-toolkit.git
cd cursor-toolkit
npm install
npm run package
cursor --install-extension .\cursor-toolkit-0.3.0.vsix --force
npm run install:companion
```

卸载助手：

```bash
npm run uninstall:companion
```

扩展装好后，从活动栏打开「工作台」，或在命令面板搜索「工作台」。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| `Alt+9` | 截图 |
| `Alt+8` | 开关悬浮窗 |
| `Esc` / 右键 | 取消截图 |

截图选区出现后，工具条提供复制、保存、滚动、取消、完成。

## 开发

源码主要在：

- `extension-lite.js`：扩展入口，负责装助手、打开面板
- `companion.js` / `server.js`：本机 HTTP 助手
- `native/Host.cs`：WinForms 截图与托盘
- `media/`：工作台界面

改完 `Host.cs` 后需要重新执行 `npm run uninstall:companion` 再 `npm run install:companion`，才会重新编译并部署助手。

## 许可

[MIT](LICENSE)
