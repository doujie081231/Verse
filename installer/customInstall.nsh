!macro customInit
    SetAutoClose false
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 500
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 500
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 300
!macroend

!macro customUnInit
    SetAutoClose false
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 500
    ${nsProcess::KillProcess} "VersePC.exe" $R0
    Sleep 500
!macroend

!macro customInstallMode
    StrCpy $isForceInstall "1"
!macroend
