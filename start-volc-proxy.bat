@echo off
chcp 65001 >nul
title 火山引擎语音代理 · 本地服务
echo ==================================================
echo  火山引擎语音代理（fish.audio 兼容）
echo ==================================================
echo.
rem 优先使用 WeChatAgent 自带的 node
set "NODE="
if exist "%LOCALAPPDATA%\Programs\WeChatAgent\app\resources\runtime\node.exe" set "NODE=%LOCALAPPDATA%\Programs\WeChatAgent\app\resources\runtime\node.exe"
if "%NODE%"=="" if exist "D:\yu\runtimes\0.4.0-db3bce768f85\node.exe" set "NODE=D:\yu\runtimes\0.4.0-db3bce768f85\node.exe"
if "%NODE%"=="" set "NODE=node"
echo  使用 node: %NODE%
echo.
echo  如果这是第一次运行，请先编辑：
echo    vendor\volc-proxy\volc-config.json
echo  填入火山引擎的 appid 和 token，以及音色映射。
echo.
pause
"%NODE%" "%~dp0vendor\volc-proxy\proxy.mjs"
echo.
echo  代理已退出。
pause