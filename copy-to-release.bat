@echo off
echo 正在复制代码到新仓库（排除AI相关文件）...

REM 克隆新仓库
git clone https://github.com/doujie081231/Verse-Pc.git Verse-Pc-release

REM 复制文件，排除AI相关文件和目录
robocopy "%~dp0" "Verse-Pc-release" /E /XD .git node_modules dist xmcl-source /XF _check2.js _deep_compare.js _fix_p.js _fix_zombie.js _fix_zombie2.js _restore.js _test_launch.js _verify.js agent-engine.js agent-worker.js ai-config.js ai-enabled.json knowledge-graph.js mcp-client.js memory-manager.js parallel-agent.js plugin-manager.js sandbox.js self-evolution.js session-manager.js skill-manager.js snapshot-manager.js workflow-engine.js

echo 删除AI聊天文件...
del /Q "Verse-Pc-release\js\ai-chat.js"

echo 复制完成！
echo 请进入 Verse-Pc-release 目录，然后执行以下命令：
echo cd Verse-Pc-release
echo git add .
echo git commit -m "初始化正式版仓库"
echo git push origin main
pause
