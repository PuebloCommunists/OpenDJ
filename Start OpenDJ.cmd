@echo off
rem Double-click to run OpenDJ. Adds Node's default install path in case PATH is stale.
cd /d "%~dp0"
set "PATH=C:\Program Files\nodejs;%PATH%"
call npm start
