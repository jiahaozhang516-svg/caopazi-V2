# 安装指南（给 AI 助手 / DSH 用）

> 你正在帮一位同学安装 **caopazi-V2**（南京林业大学图书馆座位自动预约）。
> 请按顺序执行，每完成一步就确认结果，不要跳步。
> 遇到失败先停下来向用户说明，不要自行猜测或跳过。

---

## 0. 先确认环境

逐项检查，把结果告诉用户：

```powershell
# Windows 版本
[System.Environment]::OSVersion.VersionString

# Node 版本（必须 ≥ 20）
node -v

# Edge 是否存在
Test-Path 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
```

还需要向用户索取（**不要凭空填写**）：

| 信息 | 说明 |
|---|---|
| 学号 | 统一认证登录用 |
| 统一认证密码 | CAS 密码 |
| 校园网账号 | 一般是 `w` + 学号 |
| 校园网密码 | Dr.COM 门禁密码 |

---

## 1. 解压并检查文件

解压到一个**不含中文和空格的路径**，例如 `D:\caopazi-V2`。

确认这些文件存在：

```
src\runner.mjs  src\browser.mjs  src\libseat.mjs
src\portal.mjs  src\status.mjs   src\notify.mjs  src\remote-config.mjs
run-seat.ps1  keepawake.ps1  healthcheck.ps1
tools\healthcheck.mjs
dashboard.html  config.example.json
```

---

## 2. 生成配置文件

```powershell
Copy-Item config.example.json config.json
notepad config.json
```

逐项让用户确认，**不要替用户猜**：

| 字段 | 怎么填 |
|---|---|
| `user` | 学号 |
| `pass` | 统一认证密码 |
| `portalUser` | 通常是 `w` + 学号 |
| `portalPass` | 校园网密码 |
| `roomId` | 默认 `100455352`（三层B区）。换区域的方法见下面「附录 A」 |
| `preferred` | 座位名列表，按优先级排列，例如 `["3F-B004","3F-B010"]` |
| `wifiSsid` | 校园 Wi-Fi 名，默认 `CMCC-EDU` |
| `campusPrefix` | 校园网 IP 前缀，默认 `10.14.` |

保存后确认文件里**没有中文引号**、没有多余逗号：

```powershell
node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('JSON OK')"
```

---

## 3. 干跑验证（不会真的预约）

```powershell
node src\runner.mjs --dry
```

成功的标志，最后一行是：

```
RESULT {"ok":true}
```

同时应该看到：

- `校园网 IP: 10.14.x.x`
- `网络就绪：站点可达（校园网）`
- `瑞数 cookie: xxxO(109) xxxP(364)`
- `登录成功`
- `座位表 N 个`
- `干跑下单探针: 200 {"code":1,"message":"预约时间要大于当前时间"...}`

**任何一步失败都不要继续**，按下表排查：

| 现象 | 原因 |
|---|---|
| `403 非校园网` | 没连校园网，或走的是流量/VPN 出口 |
| `30 秒没拿到瑞数 P cookie` | Edge 被安全软件拦截，或网络太慢 |
| `登录成功` 之前报错 | 学号/密码错误，或 CAS 页面改版 |
| `没找到可用座位` | `preferred` 里的座位名写错，或该区域当天全满 |

---

## 4. 注册计划任务

### 4.1 预热任务（06:45，负责把电脑按醒）

```powershell
$root = (Get-Location).Path
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -Minutes 25' -f (Join-Path $root 'keepawake.ps1')) `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '06:45'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'caopazi-Prewake' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force
```

### 4.2 抢座任务（06:56 主跑 + 07:05 补跑）

```powershell
$root = (Get-Location).Path
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $root 'run-seat.ps1')) `
  -WorkingDirectory $root
$t1 = New-ScheduledTaskTrigger -Daily -At '06:56'
$t2 = New-ScheduledTaskTrigger -Daily -At '07:05'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'caopazi-Seat' -Action $action -Trigger $t1,$t2 `
  -Settings $settings -Principal $principal -Force
```

### 4.3 每晚自检（23:00）

```powershell
$root = (Get-Location).Path
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f (Join-Path $root 'healthcheck.ps1')) `
  -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '23:00'
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'caopazi-Health' -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force
```

### 4.4 打开唤醒定时器（**需要管理员**）

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP RTCWAKE 1
# 电池模式下不要自动转休眠，否则唤醒定时器失效
powercfg /setdcvalueindex SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 0
powercfg /setactive SCHEME_CURRENT
```

验证：

```powershell
Get-ScheduledTask -TaskName 'caopazi-*' | Select-Object TaskName, State
```

---

## 5. 通知设置（可选，但推荐）

**没有通知也能正常抢座**，只是不会提醒。装好通知后，抢到/失败都会推到手机。

### 方式一：Server酱³（推荐，手机 App 弹窗）

1. 手机装 [Server酱³](https://sc3.ft07.com/)
2. 登录后复制 SendKey（形如 `sctp12345t...`）
3. 存成文件：

```powershell
New-Item -ItemType Directory -Force -Path .secrets | Out-Null
Set-Content -Path .secrets\serverchan3.txt -Value 'sctp你的key' -NoNewline
```

4. `config.json` 里确认：

```json
"notifyChannels": ["serverchan3"],
"notifyEnabled": true
```

### 方式二：Server酱（推到微信）

1. [sct.ftqq.com](https://sct.ftqq.com/) 微信扫码
2. 复制 SendKey（`SCT...`）
3. `Set-Content .secrets\serverchan.txt 'SCT你的key' -NoNewline`
4. `"notifyChannels": ["serverchan"]`

### 测试推送

```powershell
node tools\healthcheck.mjs
```

自检跑完会推一条「✅ 抢座自检 正常」，手机上收到就说明通了。

---

## 6. 手机看板（可选）

需要用户自己的 gist：

1. 手机上建一个 secret gist，文件名 `status.json`，内容 `{}`
2. 生成一个只有 `gist` 权限的 token
3. `config.json` 填 `gistId`
4. token 存到 `.secrets\github-token.txt`
5. 把 `dashboard.html` 传到手机，或托管到 GitHub Pages
6. 看板里填 Gist ID + token

---

## 7. 最终验收清单

逐项确认，全部打勾才算装好：

- [ ] `node src\runner.mjs --dry` 输出 `RESULT {"ok":true}`
- [ ] 三个任务都是 `Ready`，且 `WakeToRun = True`
- [ ] `powercfg /waketimers` 能看到明天的唤醒时间
- [ ] 电脑设置为**睡眠**（不是关机/休眠）
- [ ] 通知测试收到消息（如果配了）
- [ ] 第一次真实运行后，`logs\booked-日期.json` 里有记录

---

## 附录 A：换区域 / 查座位名

`roomId` 和座位名需要从网站的选座页面拿：

1. 浏览器打开图书馆座位页，进入目标区域
2. F12 → Network → 找 `reserve.js?roomIds=数字` 或 `roomId` 参数
3. 那个数字就是 `roomId`
4. 座位名形如 `3F-B004`（楼层 + 区 + 编号），在页面座位图上能看到

改完 `config.json` 后重新干跑，确认 `座位表 N 个` 不是 0。

---

## 附录 B：常见故障

| 现象 | 处理 |
|---|---|
| 任务显示 Ready 但早上没跑 | 检查 `powercfg /waketimers`；确认是睡眠不是休眠 |
| 日志里 `403 非校园网` | 校园网掉了，检查 `portalEnabled` 和门禁密码 |
| 抢到后又重复下单 | 检查 `logs\booked-*.json` 是否存在（幂等靠它） |
| 通知收不到 | 看 `logs\healthcheck-run.log` 里的推送结果 |
| 瑞数 400/412 | WAF 版本更新，需要更新取 cookie 逻辑 |
