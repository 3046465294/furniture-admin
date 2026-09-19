@echo off
rem AURUM 网关启动脚本（8085）—— 灰度发布 + 应用层高可用入口
chcp 65001 >nul
set GW_TOKEN=aurum-gw-2026
cd /d C:\Users\winner\Desktop\furniture-admin
"C:\Users\winner\Desktop\studio-site\tools\node\node.exe" src\gateway\server.js >> logs\gateway.log 2>&1
