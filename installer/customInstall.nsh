!macro customInit
    SetAutoClose false
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
    nsExec::ExecToStack 'taskkill /F /IM VersePC.exe /T'
    Sleep 500
    nsExec::ExecToStack 'taskkill /F /IM VersePC.exe /T'
    Sleep 300

    ; --- VC++ 运行库自动检测与安装 ---
    IfFileExists "$SYSDIR\vcruntime140.dll" _vcpp_found _vcpp_missing
    _vcpp_missing:
        MessageBox MB_YESNO|MB_ICONQUESTION "检测到系统缺少 VC++ 运行库（Microsoft Visual C++ Redistributable）。$\n$\n这是运行 VersePC 的必要组件，是否现在自动安装？" IDYES _vcpp_install IDNO _vcpp_found
    _vcpp_install:
        DetailPrint "正在下载 VC++ 运行库..."
        inetc::get /QUESTION "N" /RESUME "正在下载 VC++ 运行库..." "https://aka.ms/vs/17/release/vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
        Pop $0
        StrCmp $0 "OK" _vcpp_download_ok _vcpp_download_fail
    _vcpp_download_fail:
        MessageBox MB_OK|MB_ICONEXCLAMATION "VC++ 运行库下载失败。$\n$\n请手动安装：https://aka.ms/vs/17/release/vc_redist.x64.exe$\n$\n安装将继续，但启动器可能无法正常运行。"
        Goto _vcpp_found
    _vcpp_download_ok:
        DetailPrint "正在安装 VC++ 运行库（静默安装，请稍候）..."
        nsExec::ExecToLog '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart'
        Pop $1
        ${If} $1 != "0"
            MessageBox MB_OK|MB_ICONEXCLAMATION "VC++ 运行库安装未成功（代码 $1）。$\n$\n请手动安装：https://aka.ms/vs/17/release/vc_redist.x64.exe"
        ${Else}
            DetailPrint "VC++ 运行库安装成功"
        ${EndIf}
        Delete "$TEMP\vc_redist.x64.exe"
    _vcpp_found:

    ; --- 数据目录配置 ---
    ; 新用户：数据自动放安装目录；老用户：弹窗选择是否迁移到安装目录
    ; 如果安装目录已有 data-config.json（覆盖安装），跳过
    IfFileExists "$INSTDIR\data-config.json" _data_dir_done 0
    IfFileExists "$PROFILE\.versepc\*.*" 0 _setup_new_data_dir
        ; 老用户，C盘有数据
        MessageBox MB_YESNO|MB_ICONQUESTION "检测到 C 盘已有 VersePC 数据。$\n$\n是否将数据迁移到安装目录？$\n$\n选「是」：迁移数据到安装目录（推荐，数据跟软件走）$\n选「否」：继续使用 C 盘数据（保持现状）" IDYES _migrate_data IDNO _data_dir_done
    _migrate_data:
        DetailPrint "正在迁移数据到安装目录，请耐心等待..."
        CreateDirectory "$INSTDIR\data"
        nsExec::ExecToLog `xcopy "$PROFILE\.versepc\*" "$INSTDIR\data\" /E /I /Y /Q /C`
        Pop $0
        ${If} $0 == "0"
            DetailPrint "数据迁移成功，正在清理 C 盘旧数据..."
            RMDir /r "$PROFILE\.versepc"
            ; 用 PowerShell 写 JSON（自动转义反斜杠）
            nsExec::ExecToLog `powershell -NoProfile -Command "@{dataDir='$INSTDIR\data'} | ConvertTo-Json -Compress | Out-File -FilePath '$INSTDIR\data-config.json' -Encoding utf8"`
            DetailPrint "数据目录已设置为 $INSTDIR\data"
        ${Else}
            MessageBox MB_OK|MB_ICONEXCLAMATION "数据迁移失败（代码 $0），将继续使用 C 盘数据。$\n$\n你可以稍后在软件设置中手动修改数据目录。"
            RMDir /r "$INSTDIR\data"
        ${EndIf}
        Goto _data_dir_done
    _setup_new_data_dir:
        ; 新用户，数据放安装目录
        CreateDirectory "$INSTDIR\data"
        nsExec::ExecToLog `powershell -NoProfile -Command "@{dataDir='$INSTDIR\data'} | ConvertTo-Json -Compress | Out-File -FilePath '$INSTDIR\data-config.json' -Encoding utf8"`
        DetailPrint "数据目录设置为 $INSTDIR\data"
    _data_dir_done:
!macroend

!macro customUnInit
    SetAutoClose false
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
    nsExec::ExecToStack 'taskkill /F /IM VersePC.exe /T'
    Sleep 500

    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "是否保留游戏版本和存档数据？$\n$\n版本文件夹包含已安装的游戏版本和存档，保留后可重新安装 VersePC 继续使用。" IDYES _keep_versions IDNO _remove_versions
    _keep_versions:
        DetailPrint "保留版本文件夹"
        Goto _versions_done
    _remove_versions:
        DetailPrint "删除版本文件夹"
        ; 删除 C 盘旧数据目录
        IfFileExists "$PROFILE\.versepc\versions\*.*" 0 +2
        RMDir /r "$PROFILE\.versepc\versions"
        ; 删除安装目录下的数据目录
        IfFileExists "$INSTDIR\data\versions\*.*" 0 +2
        RMDir /r "$INSTDIR\data\versions"
    _versions_done:
!macroend

!macro customInstallMode
    StrCpy $isForceInstall "1"
!macroend
