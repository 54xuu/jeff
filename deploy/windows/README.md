# Windows 自动部署首次配置

Ubuntu 固定为 `192.168.3.176`，Windows 固定为 `192.168.3.143`。初始化只需执行一次；Windows 日常保持目标用户登录，确保任务计划程序能打开验收窗口。

## Windows 11（一次性管理员步骤）

1. 在仓库中把 `deploy/windows/` 目录复制到 Windows 临时目录。
2. 安装当前受支持的 Node.js LTS 与 Android SDK Platform Tools，确保 `node.exe`、`npm.cmd` 和 `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe` 对登录用户可用。安装 Android 手机 USB 驱动，并在手机确认 USB 调试授权；启用网络调试时确认 Windows 可访问 `192.168.3.121:5555`。运行 `adb devices` 并记录 USB serial。
3. 在 Ubuntu 生成专用密钥：

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/jeff-win11 -C jeff-ubuntu-deploy
   cat ~/.ssh/jeff-win11.pub
   ```

4. 在 Windows 用「以管理员身份运行」的 PowerShell 执行：

   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass
   .\Configure-Windows.ps1 -UbuntuPublicKey '<上一步生成的整行公钥>'
   ```

   脚本安装并启用 OpenSSH Server、把入站 SSH 限制为 Ubuntu 地址、安装公钥，并注册由当前登录用户运行的后台任务。该任务安装 Playwright 并负责实际桌面与 USB 测试。若组织策略要求标准用户 SSH 登录，把该用户加入 `OpenSSH Users` 组。

5. 回到 Ubuntu，检查 Windows 显示的 host-key 指纹。指纹一致后执行 `ssh-keyscan 192.168.3.143 >> ~/.ssh/known_hosts`，并再次运行 `ssh-keygen -lf ~/.ssh/known_hosts` 人工确认；不要在未经核对时信任主机密钥。

## Ubuntu（本机配置）

在仓库根目录执行以下配置。Windows 登录名和 USB serial 可通过 Windows 用户名及 `adb devices` 查到；若 serial 暂时未知，可以填写空字符串，流水线仍会尝试固定的 Wi-Fi ADB 地址。`JEFF_RELAY_URL` 使用项目 `packages/core/src/remote/protocol.ts` 中配置的 relay 地址；此值不是认证凭据。

```bash
mkdir -p .tmp/deploy
cat > .tmp/deploy/ssh_config <<'EOF'
Host jeff-win11
  HostName 192.168.3.143
  User <Windows登录名>
  IdentityFile ~/.ssh/jeff-win11
  IdentitiesOnly yes
  StrictHostKeyChecking yes
EOF
chmod 600 .tmp/deploy/ssh_config
```

创建 `.tmp/deploy/config.json`（此文件被 `.tmp` 忽略）：

```json
{
  "host": "192.168.3.143",
  "ubuntuHost": "192.168.3.176",
  "phoneSerial": "<USB serial；未知时填空字符串>",
  "relayUrl": "<RELAY_URL>",
  "sshAlias": "jeff-win11",
  "sshConfig": ".tmp/deploy/ssh_config",
  "incomingPath": "~/.jeff-deploy/incoming/",
  "resultPath": "~/.jeff-deploy/results"
}
```

每次先在 Ubuntu `jeff` AVD 安装同一 release APK 并通过所选 instrumentation 测试，再查询 Windows ADB。Windows 连接优先级为 USB serial，其次执行 `adb connect 192.168.3.121:5555`，最后保留 AVD 通过结果并注明真机待验收。

先验证 `ssh -F .tmp/deploy/ssh_config jeff-win11` 和 Windows USB/网络 ADB 连通性，再执行：

```bash
npm run deploy:windows -- --target win11 --android auto --suite smoke
```

任何功能改动都必须新增具名 suite，提供桌面选择器和 Android instrumentation 断言；`smoke` 只验证安装启动，不能代替功能验收。真机缺席时 AVD 路径验证同一个 APK。Windows 真机 SSH 未配置前，部署命令会停止，不会只打包后冒充完成。
