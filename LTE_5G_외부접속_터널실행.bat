@echo off
title THE LAST TWO - Mobile External Tunnel
cls
echo ==============================================================================
echo       THE LAST TWO - Mobile External Access Tunnel (LTE / 5G)
echo ==============================================================================
echo.
echo Connecting tunnel... Please wait a few seconds.
echo Once connected, look for the HTTPS URL below (e.g. https://xxxxxx.app.lhr.life).
echo Keep this window OPEN while playing the game.
echo.
echo ==============================================================================
echo.

ssh -o ServerAliveInterval=15 -o ServerAliveCountMax=240 -o StrictHostKeyChecking=no -o TCPKeepAlive=yes -R 80:localhost:5000 nokey@localhost.run

echo.
echo Tunnel connection closed.
pause
