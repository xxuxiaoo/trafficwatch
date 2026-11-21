# Windows 便携版 / Portable Windows

从 [Windows 构建](BUILD_WINDOWS.md) 生成的 ZIP 解压完整目录后，双击 `TrafficWatch-Tray.exe`。托盘会启动单路采集，流量中心在默认浏览器打开。默认数据目录为 `data/`。把 `config.example.json` 复制为 `config.local.json` 可配置采集模式和采样频率。明确设置 `captureMode: "mihomo"` 时，数据在「梯子流量」里显示。自动模式可能在本机和代理采集之间切换，历史标为便携采集。

The portable tray launches one collector and opens the viewer in the default browser. Configure the source in `config.local.json` using `config.example.json`. Explicit `mihomo` mode appears in the proxy view. For independent Windows and Mihomo collection at boot, use the [installed suite](BUILD_WINDOWS.md).

| 参数 / Option | 含义 / Meaning |
| --- | --- |
| `--demo` | 使用独立的 `data/demo` / Separate synthetic sample data |
| `--no-browser` | 启动采集与托盘 / Start without opening a browser |
| `--stop` | 暂停该托盘启动的采集 / Stop the matching tray's collector |
| `--start` | 恢复采集 / Resume the matching tray's collector |
| `--exit` | 退出托盘及其采集 / Exit the matching tray and its collector |

控制命令应使用与原托盘相同的 `--demo` 与 `CODEX_FLOW_DATA_DIR`。保留 `data/` 和 `config.local.json` 可沿用便携版记录。已安装的双路套件使用自己的程序目录、计划任务和数据目录。

The historical upstream documentation is retained under [docs/upstream](upstream/docs/WINDOWS_PORTABLE.md).
