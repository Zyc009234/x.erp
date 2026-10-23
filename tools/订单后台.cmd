@echo off
chcp 65001 >nul
title x.erp 订单后台
cd /d "%~dp0"
node orders.js
echo.
pause
