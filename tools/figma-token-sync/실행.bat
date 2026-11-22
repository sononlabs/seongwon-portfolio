@echo off
chcp 65001 >nul
title Figma Token Sync (7788)
node "%~dp0server.mjs"
pause
