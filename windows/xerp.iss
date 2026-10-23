; x.erp Windows 安装包（Inno Setup 6）。由 windows\build-windows.ps1 调用，传入 AppVersion / StageDir / OutDir
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6A7E2C51-3B9D-4F0A-9E21-58C4D7B0A3F2}
AppName=x.erp
AppVersion={#AppVersion}
AppVerName=x.erp {#AppVersion}
AppPublisher=x.erp
AppPublisherURL=http://101.201.141.121/xerp/
AppSupportURL=https://github.com/Zyc009234/x.erp/issues
DefaultDirName={autopf}\x.erp
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=xerp-{#AppVersion}-windows-x64-setup
SetupIconFile={#StageDir}\xerp.ico
UninstallDisplayIcon={app}\xerp.ico
UninstallDisplayName=x.erp
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
ShowLanguageDialog=no

[Languages]
Name: "zh"; MessagesFile: "{#StageDir}\ChineseSimplified.isl"

[Files]
Source: "{#StageDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\xerp.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
Name: "{commonappdata}\XERP"

[Icons]
Name: "{autoprograms}\x.erp\打开 x.erp"; Filename: "http://127.0.0.1:{code:GetPort}/"; IconFilename: "{app}\xerp.ico"
Name: "{autoprograms}\x.erp\数据目录"; Filename: "{commonappdata}\XERP"
Name: "{autoprograms}\x.erp\使用说明"; Filename: "{app}\使用说明.txt"
Name: "{autoprograms}\x.erp\卸载 x.erp"; Filename: "{uninstallexe}"
Name: "{autodesktop}\x.erp"; Filename: "http://127.0.0.1:{code:GetPort}/"; IconFilename: "{app}\xerp.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; GroupDescription: "快捷方式："

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\xerp-service.ps1"" -Action install -AppDir ""{app}"" -DataDir ""{commonappdata}\XERP"" -Port {code:GetPort}"; StatusMsg: "正在启动 x.erp 服务…"; Flags: runhidden waituntilterminated
Filename: "http://127.0.0.1:{code:GetPort}/"; Description: "打开 x.erp"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\xerp-service.ps1"" -Action uninstall -AppDir ""{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopXerp"

[Code]
var
  CfgPage: TInputQueryWizardPage;
  Upgrading: Boolean;

function DataDir(): String;
begin
  Result := ExpandConstant('{commonappdata}\XERP');
end;

function GetPort(Param: String): String;
begin
  Result := Trim(CfgPage.Values[0]);
end;

procedure InitializeWizard();
begin
  Upgrading := FileExists(DataDir() + '\erp.db');
  CfgPage := CreateInputQueryPage(wpSelectDir, '服务设置',
    'x.erp 会作为后台服务运行，开机自动启动，不用登录 Windows 也能使用。',
    '局域网里的其他电脑用浏览器访问「http://本机IP:端口」即可使用。' + #13#10 +
    '数据保存在 ' + DataDir() + '，卸载或升级都不会删除。');
  CfgPage.Add('服务端口：', False);
  CfgPage.Add('管理员密码（账号 admin，至少 6 位）：', True);
  CfgPage.Add('再次输入密码：', True);
  CfgPage.Values[0] := GetPreviousData('Port', '8686');
  if Upgrading then
  begin
    CfgPage.Edits[1].Enabled := False; CfgPage.Edits[2].Enabled := False;
    CfgPage.PromptLabels[1].Caption := '管理员密码：检测到已有数据，沿用原来的账号密码';
    CfgPage.PromptLabels[2].Caption := '';
    CfgPage.Edits[2].Visible := False;
  end;
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Port', GetPort(''));
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  P: Integer;
begin
  Result := True;
  if CurPageID = CfgPage.ID then
  begin
    P := StrToIntDef(Trim(CfgPage.Values[0]), 0);
    if (P < 1024) or (P > 65535) then
    begin
      MsgBox('端口需在 1024 ~ 65535 之间，一般用默认的 8686 即可。', mbError, MB_OK);
      Result := False; Exit;
    end;
    if not Upgrading then
    begin
      if Length(CfgPage.Values[1]) < 6 then
      begin
        MsgBox('管理员密码至少 6 位。', mbError, MB_OK);
        Result := False; Exit;
      end;
      if CfgPage.Values[1] <> CfgPage.Values[2] then
      begin
        MsgBox('两次输入的密码不一致。', mbError, MB_OK);
        Result := False; Exit;
      end;
    end;
  end;
end;

// 升级前先停掉正在运行的服务，否则 node.exe 被占用无法覆盖
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Old: String;
begin
  Result := '';
  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6A7E2C51-3B9D-4F0A-9E21-58C4D7B0A3F2}_is1', 'InstallLocation', Old) then
    if FileExists(AddBackslash(Old) + 'xerp-service.ps1') then
      Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + AddBackslash(Old) + 'xerp-service.ps1" -Action stop -AppDir "' + RemoveBackslash(Old) + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Lines: TArrayOfString;
begin
  // 首次安装：把管理员密码交给服务端（[Run] 里启动服务前写好），首次启动读取后立即删除
  if (CurStep = ssInstall) and (not Upgrading) then
  begin
    ForceDirectories(DataDir());
    SetArrayLength(Lines, 1); Lines[0] := CfgPage.Values[1];
    SaveStringsToUTF8File(DataDir() + '\admin-password.txt', Lines, False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    MsgBox('x.erp 已卸载。业务数据仍保留在 ' + ExpandConstant('{commonappdata}\XERP') + '，重新安装即可继续使用；确定不要了可以手动删除该文件夹。', mbInformation, MB_OK);
end;
