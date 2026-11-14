# TrafficWatch 流量中心

在 Windows 上记录和排查**本机已观测应用流量、Clash / Mihomo 代理流量，以及 Codex、Claude Code、dsh 的网络用量**。数据保存在本地 SQLite，可从一个界面按日期、应用、目标和时间高峰逐层定位。

[English](README.en.md) · [安装与构建](docs/BUILD_WINDOWS.md) · [统计口径与架构](docs/ARCHITECTURE.md) · [隐私与安全](SECURITY.md) · [许可证与来源](NOTICE.md)

> 本项目基于 **[GloryPkqa/codex-netwatch v0.5.1](https://github.com/GloryPkqa/codex-netwatch/tree/v0.5.1)** 修改，遵循 MIT 许可证。原作者为 GloryPkqa，原版权与许可证完整保留。本仓库是独立维护的修改版。

## 可以做什么

- **简洁总览**：先显示总量与上传 / 下载柱状图，再补齐应用归因；查看今天、24 小时、7 天、30 天、指定日期或全部历史。
- **本机应用**：Windows ETW 采集 TCP / UDP、IPv4 / IPv6 进程网络事件；可搜索应用并下钻到时段、目标和连接。
- **梯子流量**：单独读取 Clash / Mihomo 兼容控制接口，区分代理、DIRECT 和未知路由，查看应用、目标、节点和规则证据。
- **Harness**：按进程及有证据的子进程关系归类 Codex、Claude Code 和 dsh；无法确认的历史保持未知或其他应用。
- **高峰排查**：点击某一时段的柱子或高峰记录，查看该时段上传、下载最多的程序和连接。
- **缺口透明**：区分“未采集”“已采集但无匹配流量”和“部分缺采”，显示采集覆盖情况。
- **开机采集与独立控制台**：安装模式下以 SYSTEM 开机运行两路采集，托盘在用户登录后显示；控制台支持启停、恢复托盘和切换自启动。
- **无限保留**：安装默认 `retentionDays: 0`；原始历史与可重建查询缓存分开存放。
- **旧界面保留**：统一入口之外，两路旧版详情仍可使用。

## 开始使用

需要 **Windows 10/11 x64、.NET Framework 4.8**；桌面托盘还需要 Microsoft Edge WebView2 Runtime。源码运行与测试需要 **Node.js 24+**，无需安装 JavaScript 依赖。

```powershell
git clone https://github.com/xxuxiaoo/trafficwatch.git
cd trafficwatch
node scripts/check.mjs
node scripts/test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1
```

构建结果位于 `.build/windows/TrafficWatch/`。以管理员身份打开 PowerShell，在构建目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```

安装器会显示安装与数据路径，并拒绝覆盖现有 TrafficWatch 安装或同名计划任务。默认程序路径是 `%ProgramFiles%\TrafficWatch`，数据路径是 `%ProgramData%\TrafficWatch`；可通过安装器的 `-DataRoot` 指定数据路径。它按当前安装用户查找 Clash Verge 配置；其他兼容客户端可用 `-ClashConfigPath` 指定配置文件，详见[安装说明](docs/BUILD_WINDOWS.md)。

安装后打开桌面的 **TrafficWatch** 快捷方式，或访问 http://127.0.0.1:43131/ 。控制台和托盘能单独恢复，不需要关闭浏览器来停止采集。

仅预览旧版合成数据界面：`npm run demo`，访问 http://127.0.0.1:43128/ 。它使用独立的 `data/demo`，不展示真实记录。统一总览需要两路采集数据库；`npm start` 只启动总览查看服务。

## 数据怎么理解

| 页面 | 记录来源 | 需要注意 |
| --- | --- | --- |
| 本机应用 | Windows ETW 进程网络事件 | 包含本机回环；部分事件可能无法归属进程 |
| 梯子 | Clash / Mihomo 控制接口 | 只看该控制器可观测的连接；代理出口与 DIRECT 分开 |
| Harness | 上述记录中的进程与子进程证据 | 是应用分类，不是第三份独立网络账单 |

**本机与梯子用量不能相加作为账单**：应用到代理、代理到服务器可能分别被观测，两个视角也存在重叠。程序不解密 HTTPS、不修改代理规则、不估算离线时段，也不保证与运营商或机场账单一致。短连接尾部、ETW 丢事件、未运行采集及未识别进程都有测量限制。

选择 7 天和 30 天时，如果已有记录不足 7 天，两种范围可能得到相同总量；图表会保留缺采提示。上传为橙色，下载为蓝色。

## 开发与验证

```powershell
npm run check
npm test
npm run audit:publication
```

Windows 原生助手可单独构建：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1`。构建过程会执行助手自检。

性能改动包括请求取消、工作线程超时恢复、有界缓存、历史汇总、可见区域画布、后台暂停和应用列表分页。0.7.1 进一步减少长时间打开时的重复请求和界面重建，复用数字格式器，并在后台释放图表画布及事件。验证范围及限制见 [docs/VALIDATION.md](docs/VALIDATION.md)。

仓库仅包含源码、合成测试和文档。真实数据库、域名访问记录、个人截图、配置密钥、运行日志和编译产物不随源码发布。请保留 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 及分发包中的第三方许可文件。
