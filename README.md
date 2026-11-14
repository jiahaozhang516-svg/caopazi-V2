# caopazi-V2

南京林业大学图书馆座位**自动预约**工具（Windows / Node.js）。

每天 07:00 自动抢次日座位：唤醒电脑 → 连校园网 → 过瑞数 WAF → CAS 登录 → 端点下单 → 写状态板。

> 仅供个人预约自己的座位使用。请遵守学校图书馆的预约规则。

---

## 它解决什么

学校座位系统 2026-11 上线了瑞数（Riversafe）WAF：

- 非浏览器客户端一律返回 412 挑战页；
- 写请求还会被追加动态签名参数，纯 Node 直接 POST 必然 412。

本工具的做法是：**用真实的 Edge 浏览器完成挑战**，拿到合法 cookie，再把登录态注入同一个浏览器，在页面里发下单请求——这样瑞数的签名由页面脚本自己完成，不需要逆向算法。

---

## 环境要求

- Windows 10/11
- Microsoft Edge（系统自带即可）
- Node.js ≥ 20（`node --version` 确认）

**零 npm 依赖**：只用 Node 内置模块，克隆下来就能跑。

---

## 快速开始

```powershell
# 1. 复制配置模板
Copy-Item config.example.json config.json

# 2. 编辑 config.json，填入学号、统一认证密码、校园网账号密码
notepad config.json

# 3. 干跑验证整条链路（不会真的预约）
node src\runner.mjs --dry
```

看到 `干跑下单探针: 200 {...}` 和 `RESULT {"ok":true}` 就说明链路通了。

---

## 配置说明

| 字段 | 含义 |
|---|---|
| `user` / `pass` | 统一认证（CAS）学号 / 密码 |
| `roomId` | 座位区域 ID（三层 B 区 = `100455352`） |
| `preferred` | 优先座位名，按顺序尝试 |
| `anchor` | 兜底锚点座位 |
| `maxDistance` | 兜底时允许的**座位号**差值 |
| `parity` | 兜底座位尾数：`even` / `odd` / 空 |
| `fallbackAny` | 以上都不满足时，是否随便选一个 |
| `startTime` / `endTime` | 预约时段 |
| `thursdayStart` | 周四最早开始时间 |
| `fridayEnd` | 周五闭馆时间 |
| `prepareLeadSec` | 开抢前多少秒开始建会话（默认 30，保证 cookie 新鲜） |
| `wifiSsid` | 校园网 Wi-Fi 名称 |
| `campusPrefix` | 校园网 IP 前缀，用于判断是否已连上 |
| `portalEnabled` | 是否启用门禁自动认证 |
| `portalIp` / `portalUrl` | 校园网 Portal 地址 |
| `portalUser` / `portalPass` | 校园网账号 / 密码 |
| `gistId` | 可选：状态板 gist（手机端读取） |

> `config.json` 含密码，已在 `.gitignore` 中排除，**不要提交**。

---

## 每天自动运行

注册计划任务（06:56 触发，带唤醒）：

```powershell
$root = 'D:\path\to\caopazi-V2'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $root 'run-seat.ps1')) `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '06:56'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'caopazi-V2' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force
```

还需要打开「允许使用唤醒定时器」（管理员 PowerShell）：

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /setactive SCHEME_CURRENT
```

**电脑要保持「睡眠」而不是「关机」**——关机（S5）无法被定时器唤醒。

---

## 运行时序

| 时刻 | 动作 |
|---|---|
| 06:55:31 | 定时器唤醒电脑 |
| 06:56:00 | 任务启动，检查校园网 IP；没有就 `netsh` 连回 Wi-Fi |
| 06:56:1x | 外网不通 → 自动完成校园网门禁认证 |
| 06:59:30 | 建会话：瑞数 cookie → CAS 登录 → 注入浏览器 |
| 07:00:00 | 页面内下单，失败自动换座位重试 |
| 07:05:00 | 补跑一次，已成功则跳过 |

日志写在 `logs/`，失败会留 `logs/FAILED.txt`。

---

## 状态板（可选）

抢座结果可以写到一个 secret gist，手机端轮询显示：

```json
{ "date": "2026-11-16", "ok": true, "seat": "3F-B004",
  "start": "07:30", "end": "22:00", "message": "新增成功", "at": "..." }
```

需要：建一个 secret gist，把 gistId 填进 `config.json`，token 放到 `.secrets/github-token.txt`（只需 `gist` 权限）。

---

## 已知限制

- 瑞数会随版本变化，若某天开始 412/400，需要更新取 cookie 的逻辑；
- 服务端 07:00 前后有「请求频繁」限流，重试节奏已做退避；
- 图书馆系统本身若改协议（接口/字段），需要同步调整 `src/libseat.mjs`。

---

## 目录

```
src/
  runner.mjs    主流程（时序、选座、重试、状态板）
  browser.mjs   无头 Edge + CDP 封装
  libseat.mjs   CAS 登录 + 座位表 + 下单
  portal.mjs    校园网 Portal 自动认证
  status.mjs    gist 状态板
run-seat.ps1    计划任务启动器
config.example.json
```
