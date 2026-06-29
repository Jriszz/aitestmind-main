#!/usr/bin/env bash
# ============================================================
#  一键启动开发环境（Windows / Git Bash）
#  - 后台启动 Python 执行器(8001) 和 Next.js 前端(3009)
#  - 日志写入 logs/executor.log 和 logs/dev.log
#  - Ctrl+C 停止两个服务
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

PY="executor/venv/Scripts/python.exe"

if [ ! -f "$PY" ]; then
  echo "[错误] 未找到 Python 虚拟环境: $PY"
  echo "       请先创建: cd executor && python -m venv venv && venv/Scripts/pip install -r requirements.txt"
  exit 1
fi

mkdir -p logs

echo "========================================="
echo "  启动 AI 测试平台开发环境"
echo "========================================="

echo "[1/2] 启动 Python 执行器 (http://localhost:8001) ..."
( cd executor && "venv/Scripts/python.exe" main.py ) > logs/executor.log 2>&1 &
EXECUTOR_PID=$!

echo "[2/2] 启动 Next.js 前端 (http://localhost:3009) ..."
npm run dev > logs/dev.log 2>&1 &
NEXT_PID=$!

echo
echo "  执行器 PID: $EXECUTOR_PID  (日志: logs/executor.log)"
echo "  前端   PID: $NEXT_PID  (日志: logs/dev.log)"
echo
echo "  执行器: http://localhost:8001/docs"
echo "  前端:   http://localhost:3009"
echo
echo "  按 Ctrl+C 停止两个服务，日志实时输出如下:"
echo "========================================="

# Ctrl+C 时一并终止两个子进程
trap 'echo; echo "停止服务..."; kill "$EXECUTOR_PID" "$NEXT_PID" 2>/dev/null || true; exit 0' INT TERM

# 跟随两个日志输出，前台阻塞
tail -f logs/executor.log logs/dev.log
