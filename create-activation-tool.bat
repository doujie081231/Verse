@echo off
echo 正在创建密钥激活工具...

REM 创建文件夹
if not exist "C:\Users\huang\Desktop\密钥激活工具" mkdir "C:\Users\huang\Desktop\密钥激活工具"

REM 复制文件
copy /Y "%~dp0activate-tool.js" "C:\Users\huang\Desktop\密钥激活工具\activate.js"
copy /Y "%~dp0activate-tool.html" "C:\Users\huang\Desktop\密钥激活工具\index.html"

REM 打包成 exe
echo 正在打包 exe...
cd "C:\Users\huang\Desktop\密钥激活工具"
npm init -y 2>nul
npm install pkg 2>nul
npx pkg activate.js --targets node18-win-x64 --output VersePC激活工具.exe 2>nul

echo.
echo ========================================
echo 密钥激活工具已创建完成！
echo 文件位置: C:\Users\huang\Desktop\密钥激活工具
echo ========================================
echo.
pause
