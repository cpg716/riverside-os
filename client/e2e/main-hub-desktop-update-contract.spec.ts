import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("Main Hub update closes the running app and relaunches it after replacement", () => {
  const registerInstaller = repoFile("deployment/windows/install-register.ps1");
  const serverUpdater = repoFile("client/src-tauri/src/server_updater.rs");
  const appInstallPath = registerInstaller
    .split("if (-not $SkipAppInstall) {")[1]
    ?.split("$app = Find-InstalledApp")[0];

  expect(appInstallPath).toContain("Stop-RiversideDesktopApp");
  expect(appInstallPath).toContain("Install-RegisterApp $installer");
  expect(appInstallPath?.indexOf("Stop-RiversideDesktopApp")).toBeLessThan(
    appInstallPath?.indexOf("Install-RegisterApp $installer") ?? -1,
  );
  expect(serverUpdater).toContain(
    "./install-register.ps1 -ConfigPath $configPath -StationMode mainhub -Launch",
  );
  expect(registerInstaller).toContain('"riverside-pos-tauri"');
  expect(registerInstaller).toContain(
    '"$env:LOCALAPPDATA\\Riverside POS\\riverside-pos-tauri.exe"',
  );
  expect(serverUpdater).toContain("Riverside OS Main Hub Update");
  expect(serverUpdater).toContain("Register-ScheduledTask");
  expect(serverUpdater).toContain("Start-ScheduledTask");
});
