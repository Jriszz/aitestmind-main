@echo off
REM ============================================================
REM  一键启动开发环境（Windows）
REM  - 在两个独立窗口分别启动 Python 执行器(8001) 和 Next.js 前端(3009)
REM  - 双击本文件即可运行
REM ============================================================

cd /d "%~dp0"

echo =========================================
echo   启动 AI 测试平台开发环境
echo =========================================
echo.

REM 1. 检查 Python 虚拟环境
if not exist "executor\venv\Scripts\python.exe" (
    echo [错误] 未找到 Python 虚拟环境: executor\venv
    echo        请先在 executor 目录创建虚拟环境并安装依赖:
    echo          cd executor ^&^& python -m venv venv ^&^& venv\Scripts\pip install -r requirements.txt
    echo.
    pause
    exit /b 1
)

REM 2. 启动 Python 执行器（新窗口，端口 8001）
echo [1/2] 启动 Python 执行器 (http://localhost:8001) ...
start "执行器 :8001" cmd /k "cd /d "%~dp0executor" && venv\Scripts\python.exe main.py"

REM 3. 启动 Next.js 前端（新窗口，端口 3009）
echo [2/2] 启动 Next.js 前端 (http://localhost:3009) ...
start "前端 :3009" cmd /k "cd /d "%~dp0" && npm run dev"

echo.
echo =========================================
echo   两个服务已在独立窗口启动:
echo     - 执行器: http://localhost:8001/docs
echo     - 前端:   http://localhost:3009
echo   关闭对应窗口即可停止服务。
echo =========================================
echo.
