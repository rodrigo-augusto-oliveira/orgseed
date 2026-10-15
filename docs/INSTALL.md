# Installing OrgSeed

## 1. Before you install: Salesforce CLI

OrgSeed uses the Salesforce CLI (`sf`) to log in to your orgs. Install it once on each machine:

```bash
npm install -g @salesforce/cli
sf --version
```

Native installers for `sf` are also available at https://developer.salesforce.com/tools/salesforcecli.

Your Salesforce user needs the **API Enabled** permission, read access in the source org, and create access in the target org for the objects you copy.

## 2. Which file to download

From the **Assets** section of the release, download the file for your system:

| System | File | Notes |
|---|---|---|
| Windows | `OrgSeed-x.y.z-win-x64.exe` | Installer (recommended). |
| Windows | `OrgSeed-x.y.z-portable.exe` | Nothing to install: just run it. Useful on machines without admin rights. |
| macOS on Apple Silicon (M1, M2, M3, M4…) | `OrgSeed-x.y.z-mac-arm64.dmg` | Apple menu → About This Mac shows "Chip: Apple M…". |
| macOS on Intel | `OrgSeed-x.y.z-mac-x64.dmg` | Apple menu → About This Mac shows "Processor: … Intel …". |
| Ubuntu / Debian | `OrgSeed-x.y.z-linux-amd64.deb` | Recommended on Linux. |
| Other Linux distributions | `OrgSeed-x.y.z-linux-x86_64.AppImage` | Single file, no installation. |

## 3. Install

The app is not signed with a paid code-signing certificate, so your system shows a warning the first time you open it. This is expected for an internal tool.

### Windows

1. Run `OrgSeed-x.y.z-win-x64.exe`.
2. If SmartScreen says "Windows protected your PC", click **More info → Run anyway**.
3. Choose the install folder and finish. OrgSeed appears in the Start menu.

To uninstall: **Settings → Apps → OrgSeed → Uninstall**.

### macOS

1. Open the `.dmg` and drag **OrgSeed** into **Applications**.
2. Open OrgSeed from Applications. macOS blocks it the first time.
3. Go to **System Settings → Privacy & Security**, scroll to the message about OrgSeed and click **Open Anyway**.
4. If you see "OrgSeed is damaged and can't be opened", run this in Terminal and open it again:
   ```bash
   xattr -cr /Applications/OrgSeed.app
   ```

To uninstall: drag OrgSeed from Applications to the Trash.

### Linux

`.deb` (Ubuntu/Debian):
```bash
sudo apt install ./OrgSeed-*.deb
```
Then open it from the applications menu. To uninstall: `sudo apt remove orgseed`.

`.AppImage`:
```bash
chmod +x OrgSeed-*.AppImage
./OrgSeed-*.AppImage
```
On Ubuntu 24.04, if the AppImage closes right after opening, use the `.deb` or run it with `--no-sandbox`.

## 4. First run

The app's interface is in Portuguese; labels below are shown as they appear on screen.

1. Open OrgSeed. The badge at the top shows whether `sf` was found. If not, set its path in **⚙ Configurações**.
2. Click **+ Conectar org** and log in to the source and target orgs. Orgs already connected in `sf` show up automatically.
3. Choose **Copiar dados** (copy data) or **Copiar metadados** (copy metadata). Always run **Simular** (dry run) or **Validar** (validate) before writing anything.

## Upgrading from SF Graph Copy

OrgSeed is the new name of SF Graph Copy. On first launch it automatically copies your SF Graph Copy profiles, logs, downloaded metadata and settings. The "don't duplicate" history keeps working. Once you've checked everything is there, you can uninstall SF Graph Copy.
