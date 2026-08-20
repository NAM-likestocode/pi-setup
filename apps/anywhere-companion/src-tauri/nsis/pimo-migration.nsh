; One-time visible-brand migration. Technical identifiers and user data stay unchanged.
!macro NSIS_HOOK_PREINSTALL
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Pi Anywhere Companion" "UninstallString"
  StrCmp $R8 "" pimo_legacy_migration_done
  ReadRegStr $R7 HKCU "Software\namlikestocode\Pi Anywhere Companion" ""
  StrCmp $R7 "" 0 +2
  StrCpy $R7 "$LOCALAPPDATA\Pi Anywhere Companion"
  StrCpy $R8 "$R8 /S _?=$R7"
  ExecWait $R8 $R9
  IntCmp $R9 0 pimo_legacy_migration_done pimo_legacy_migration_failed pimo_legacy_migration_failed

  pimo_legacy_migration_failed:
    MessageBox MB_OK|MB_ICONSTOP "Pimo could not replace the previous Pi Anywhere Companion installation."
    Abort

  pimo_legacy_migration_done:
!macroend
