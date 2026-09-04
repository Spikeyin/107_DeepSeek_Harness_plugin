# setup-git-global.ps1 - 一次性引导脚本：让 MinGit 在本机全局可用
# 请在【非 IDE 沙箱】的 PowerShell 窗口中执行（如 Win+R 输入 powershell 打开）
# 执行方式：右键此文件 -> 使用 PowerShell 运行；或在普通 PowerShell 中:
#   powershell -ExecutionPolicy Bypass -File D:\deepseek_harness\setup-git-global.ps1

$ErrorActionPreference = "Stop"

$gitRoot = "$env:LOCALAPPDATA\Programs\Git"
$gitCmd  = Join-Path $gitRoot "cmd"

if (-not (Test-Path (Join-Path $gitCmd "git.exe"))) {
    Write-Host "[错误] 未找到 $gitCmd\git.exe ，请确认已解压 MinGit 到 $gitRoot" -ForegroundColor Red
    exit 1
}

# 1) 将 git 加入用户级 PATH（全局生效，无需管理员）
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$gitCmd*") {
    [System.Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(';') + ";" + $gitCmd), "User")
    Write-Host "[OK] 已将 $gitCmd 加入用户 PATH" -ForegroundColor Green
} else {
    Write-Host "[跳过] PATH 已包含 git" -ForegroundColor Yellow
}

# 2) 写入全局身份与默认配置
$git = Join-Path $gitCmd "git.exe"
& $git config --global user.name "Spikeyin"
& $git config --global user.email "spikeyin@users.noreply.github.com"
& $git config --global http.sslBackend schannel
& $git config --global core.autocrlf false
& $git config --global init.defaultBranch main
Write-Host "[OK] 全局 git 身份已配置 (Spikeyin / spikeyin@users.noreply.github.com)" -ForegroundColor Green


pause
