@echo off
rem Opens OpenDJ behind your current window, without taking focus.
cd /d "%~dp0"
start "" "%~dp0node_modules\electron\dist\electron.exe" . --background
