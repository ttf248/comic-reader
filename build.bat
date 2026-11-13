@echo off
call "%~dp0scripts\build.bat" --local %*
exit /b %errorlevel%
