@echo off
chcp 65001 >nul
title WeChatAgent 语音音色增强包 · 一键安装
echo ==================================================
echo  WeChatAgent 语音音色增强包 · 一键安装
echo ==================================================
echo.

rem 检查 PowerShell 7 (pwsh)
where pwsh >nul 2>nul
if %errorlevel%==0 (
    echo 正在运行安装脚本，请稍候...
    echo.
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
    set "code=%errorlevel%"
) else (
    echo [提示] 未找到 pwsh (PowerShell 7)。
    echo 本增强包需要 PowerShell 7 来运行安装脚本。
    echo.
    echo 请到以下地址下载安装 PowerShell 7：
    echo   https://github.com/PowerShell/PowerShell/releases
    echo.
    echo 安装后重新双击本文件即可。
    echo.
    pause
    exit /b 1
)

echo.
if "%code%"=="0" (
    echo ==================================================
    echo  安装完成！请按上方提示操作：填 API Key、重开微信、重启 DSH。
    echo ==================================================
) else (
    echo ==================================================
    echo  安装未完成，请查看上方日志。
    echo ==================================================
)
echo.
pause