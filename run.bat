@echo off
rem Zhizun Furniture Admin (v2.0 rebuild) - local only, published via Cloudflare tunnel
rem Idempotent: exits if port 8090 is already served.
netstat -ano | findstr /C:"LISTENING" | findstr /C:":8090 " >nul 2>&1
if %errorlevel%==0 exit /b 0
cd /d "%~dp0"
if not exist "%~dp0logs" mkdir "%~dp0logs"
"C:\Users\winner\Desktop\studio-site\tools\node\node.exe" src\server.js >> "%~dp0logs\app.log" 2>&1
