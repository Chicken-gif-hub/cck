# CCK 账号管理器（开源版）

CCK 账号管理器的桌面客户端。本仓库为**开源版**，包含账号管理与额度查询功能；官方发行版在此基础上额外提供客户端一键启动等能力（见下方「开源版与官方版差异」）。

## 下载

- Windows 安装包：<https://cck.btluo.com/download>
- 在线版：<https://cck.btluo.com>

## 功能

### 账号商城
- 按分类浏览可购买账号（12 个 AI 编程工具家族）
- 余额购买、兑换码充值
- 死号自动退款（服务端复核后按剩余额度比例退回余额）

### 我的账号
- 平台账号列表 + 额度自动查询（并发刷新、逐账号展示）
- 封禁状态检测与退款入口
- **自定义账号**：录入你自己的凭证，仅保存在本机（系统级加密），不上传服务器

### 支持额度查询的客户端

| 家族 | 客户端 |
|------|--------|
| Qoder | Qoder Work CN / Qoder CN IDE / Qoder 国际版 |
| Trae | Trae CN / TraeWork CN (SOLO) / Trae 国际版 |
| CodeBuddy | CodeBuddy/WorkBuddy / CodeBuddy 国际版 |
| 其他 | 千问办公 / Codex CLI / Cursor IDE / Kiro IDE |

额度口径随平台而异：credits、积分、fast requests、按请求计数等，界面按分类自动适配展示。

## 安全设计

- `contextIsolation: true` + `sandbox: true` + `nodeIntegration: false`，渲染进程只能通过 `contextBridge` 暴露的白名单 IPC 通道访问主进程能力
- 凭证类数据（会话 token、自定义账号）通过 Electron `safeStorage`（Windows 上为 DPAPI）加密后落盘
- CSP 禁止加载任意外部脚本；外链打开走主进程协议白名单（仅 http/https）
- 诊断日志写入前脱敏（JWT / 设备令牌 / 私钥 / token 类字段一律掩码）
- 文件锁单实例（带 PID 存活检测，防闪退后锁死）

## 开发

```bash
npm install
npm start        # 运行
npm run dev      # 运行并打开 DevTools
npm test         # 自定义账号模块测试
npm run build    # 打包 Windows 安装包（electron-builder + NSIS）
```

要求：Node.js ≥ 18，Windows（打包目标为 win x64）。

## 项目结构

```
├── main.js                 # 主进程：窗口管理 + IPC handler
├── preload.js              # contextBridge 白名单 IPC 接口
├── lib/
│   ├── api-client.js       # 后端 API 调用封装（Electron net，走系统代理）
│   ├── quota-checker.js    # 额度查询调度（按分类分发到各 context 模块）
│   ├── qwenwork-context.js # 千问办公额度查询
│   ├── codex-context.js    # Codex CLI 额度查询
│   ├── cursor-context.js   # Cursor IDE 额度查询
│   ├── kiro-context.js     # Kiro IDE 额度查询
│   ├── vscdb-secret.js     # state.vscdb 只读访问（sql.js）
│   ├── custom-accounts.js  # 自定义账号校验/存储逻辑
│   ├── local-store.js      # 本地配置存储（敏感值 safeStorage 加密）
│   ├── net-helper.js       # 共享网络请求工具
│   └── cck-logger.js       # 脱敏诊断日志
├── renderer/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js           # 渲染进程逻辑
├── test/                   # 测试
└── assets/icon.ico
```

## 开源版与官方版差异

本开源版**仅包含**账号管理与额度查询。官方发行版额外包含：

- 客户端一键启动（凭证注入后拉起对应 IDE/CLI）
- 设备身份修复与全新无痕重置
- 网络 IP 轮换

这些能力涉及对第三方客户端本地状态的深度写入，不在开源范围内。两个版本共用同一后端与更新通道。

## License

[MIT](./LICENSE)
