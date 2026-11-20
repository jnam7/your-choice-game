@echo off
title THE LAST TWO - Mobile External Tunnel
cls
echo Connecting tunnel... Please wait...
echo Keep this window open during game!
echo.
ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=240 -o StrictHostKeyChecking=no -o TCPKeepAlive=yes -R 80:localhost:5000 nokey@localhost.run
pause
