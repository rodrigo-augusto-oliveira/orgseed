# OrgSeed

Internal tool for seeding Salesforce sandboxes. It copies records from one org to another, bringing along the **parent** and **child** records they need (Composite Graph API), and it also copies metadata. Use it for sandboxes whose data is empty or incomplete.

It has a desktop app (Windows, macOS and Linux) and a command line. The home screen offers two options:

- **Copiar dados** (copy data) — records with their parents and children (Composite Graph API).
- **Copiar metadados** (copy metadata) — whole objects, fields only, or other components (Metadata API, via Salesforce CLI).

> Formerly **SF Graph Copy**. On first launch, OrgSeed copies the old app's profiles, logs and settings automatically.

The app's interface is in Portuguese. In this guide, UI labels are written exactly as they appear on screen, with a translation where helpful.

---

## 1. Requirements

- **Salesforce CLI (`sf`)** installed on each machine. Logging in to the orgs is done through it.
  ```bash
  npm install -g @salesforce/cli
  sf --version
  ```
- The Salesforce user needs **API Enabled**, read access in the source org and create access in the target org for the copied objects.

## 2. Install the app

Download the installer for your system from the repository's **Releases** page. Step-by-step instructions for Windows, macOS and Linux, including the first-run security warnings, are in **[docs/INSTALL.md](docs/INSTALL.md)**.

| System | File |
|---|---|
| Windows | `OrgSeed-x.y.z-win-x64.exe` (installer) or `OrgSeed-x.y.z-portable.exe` |
| macOS | `OrgSeed-x.y.z-mac-arm64.dmg` (Apple Silicon) or `OrgSeed-x.y.z-mac-x64.dmg` (Intel) |
| Linux | `OrgSeed-x.y.z-linux-amd64.deb` (Ubuntu/Debian, recommended) or `OrgSeed-x.y.z-linux-x86_64.AppImage` |

## 3. Using the app

1. **Orgs** — click **+ Conectar org**, give it an alias and choose Sandbox, Production or a custom domain. The browser opens for login (this is `sf org login web`). Orgs already connected in `sf` appear automatically.
2. Choose **Origem** (source) and **Destino** (target). The app warns you if the target doesn't look like a sandbox.
3. **Registros raiz** (root records) — enter the object (e.g. `Opportunity`) and either:
   - **IDs**: paste one or more IDs; or
   - **Filtro SOQL**: just the WHERE clause, e.g. `StageName = 'Closed Won' AND CloseDate = LAST_N_DAYS:30`, with a LIMIT.
4. **Filhos a levar** (children to bring) — select the relationships (e.g. `OpportunityLineItems`, `OpportunityContactRoles`).
5. **Objetos que podem ser criados** (objects that may be created) — what the app is allowed to create in the target. **✦ Sugerir** (suggest) adds the root, the children and the required parents (e.g. PricebookEntry, Product2, Pricebook2), and puts fields with unique values or external IDs in the source (e.g. `CodigoSAP__c`) at the start of `matchBy`.
6. Click **Simular** (dry run). Nothing is written: for each root record you see what would be created (root, parents, children) and what would be linked to records that already exist in the target.
7. Click **Executar** (run). The app asks for confirmation, showing the target org, and then writes.
8. In **Graphs**, each root record shows ✓ (created) or ✕ (failed, with the Salesforce error). **Avisos** (warnings) lists skipped fields. **Abrir arquivo de log** (open log file) shows the full JSON with payloads, responses and the source → target ID map.

**Perfil** (profile): save a configuration (e.g. "Opportunities with line items") and reuse it. You can import/export the same `config.json` used by the command line.

## 3a. Reusing, linking and avoiding duplicates

These options are on the data copy screen (some under **Avançado**, advanced).

- **Não duplicar o que já foi copiado** (don't duplicate what was already copied; on by default). The app reads the logs of previous real runs between the same source and target. If the record still exists in the target, it is reused: it isn't created again, and any children not yet linked to it (e.g. added to the configuration after the copy) are created linked to it. If nothing is missing, the graph shows "Já copiado antes em dd/mm/aaaa" (already copied on …) and nothing is created. If the record was deleted in the target, it is created again. Dry runs are not part of this history.
- **Atualizar com os dados da origem os registros que já existem** (update existing records with source data; on by default). When the app recognizes a record in the target (through the history, the external ID, `matchBy` or the source ID field), it updates that record with the source data instead of only linking it. Only changed fields are sent; if nothing changed, the record isn't touched (so no triggers or flows fire needlessly). Updates run before creation, separately: if one fails it becomes a warning and the opportunity is still created. Never updated: link-only objects (e.g. User), RecordType, and the standard Price Book with its price entries. Lookups pointing to records that don't exist in the target yet are left out of the update, with a warning. In the dry run, the total appears under "Seriam atualizados" (would be updated).
- **Reconhecer registros pelo ID externo automaticamente** (match by external ID; Advanced, on by default). Every field marked as an external ID in the target that also exists in the source becomes the object's first matching rule, even without `matchBy`. This avoids `DUPLICATE_VALUE` on records such as transport zones, crops and price books.
- **`DUPLICATE_VALUE` safety net**. If creation still fails because of a duplicate value in a unique field, the app takes the existing record's ID from the Salesforce error message, links and updates that record, and resends the graph once.
- **Campo de ID de origem** (source ID field; Advanced, optional), e.g. `{ "Opportunity": "IdOrigem__c" }`. When creating a record, the app writes the source ID into this field. In later copies it finds the record by this field, even without the log. The field must exist and be writable in the target; if it doesn't exist, the app warns and ignores it.
- **Objetos só para ligar** (link-only objects; Advanced), e.g. `{ "User": ["Email"], "Regional__c": ["Name"] }`. These objects are not copied, only linked: the app looks for the matching record in the target and points the lookup at it. If none is found, the field is omitted with a warning. An object can't be in both this list and "Objetos que podem ser criados". By default, User is linked by email; in sandboxes Salesforce appends `.invalid` to emails, and the app ignores that suffix when comparing. For User, if more than one has the same email, the active one wins.
- **matchBy: new format**. Each object has a list of rules, tried in order. Each rule is a list of fields. The first rule that finds **exactly one** record in the target wins. If a rule finds more than one, it is skipped (with a warning) and the next one is tried; the app never just picks the first match. A field ending in `?` is optional: it's only used if it exists in both orgs. A required field missing in either org causes the rule to be skipped, with a warning. An empty value in the source matches nothing. The old format (`"Account": ["Name"]`) still works as a single rule. A plain string (`"Account": "Name"`) and mixed lists such as `[["CodigoSAP__c"], "Name"]` are also accepted, with each item being a rule.

Example: find Account by SAP code, then by CNPJ (Brazilian company tax ID), and finally by name.

```json
"matchBy": {
  "Account": [["CodigoSAP__c"], ["CNPJ__c"], ["Name"]],
  "PricebookEntry": ["Pricebook2Id", "Product2Id", "CurrencyIsoCode?"]
}
```

## 3b. Copying metadata

1. On the home screen, choose **Copiar metadados** and select the source and target.
2. Under **O que levar** (what to bring), pick a tab:
   - **Objetos completos** (whole objects) — the object with everything that belongs to it (fields, validation rules, record types, list views…). By default only custom objects are listed; check **Mostrar padrão** (show standard) for Account, Contact, etc.
   - **Somente campos** (fields only) — choose the object and select its custom fields.
   - **Outros tipos** (other types) — choose the type (ApexClass, Flow, Layout, FlexiPage…) and select the components.
3. Nothing loads ahead of time: each list is fetched only when you open the tab or choose the object/type, with a loading indicator. **↻ Atualizar lista** (refresh list) fetches it again.
4. Each item shows **novo** (new — doesn't exist in the target) or **existe no destino** (exists in the target — will be overwritten). Managed package components are shown disabled.
5. The **Pacote** (package) panel on the right collects everything you selected. If you bring fields of an object that doesn't exist in the target, the app warns you.
6. **Validar** (validate) retrieves from the source and runs a check-only deploy in the target, without saving anything. **Implantar** (deploy) writes for real, after a confirmation.
7. The deploy is all or nothing: if one component fails, nothing changes in the target. Errors are shown per component, with the line number when available.

Notes:
- New fields arrive without field-level security (FLS). Grant access through profiles or permission sets afterwards.
- In production, Salesforce requires Apex tests when the package contains code. In sandboxes, "Não rodar testes" (don't run tests) is faster.
- Folder-based types (Report, Dashboard, EmailTemplate, Document) are not supported yet.
- The retrieved files and the full result are saved; use **Abrir pasta dos arquivos** (open files folder).

## 4. Command line

```bash
cp config.example.json config.json   # set source, target and root
node cli.js --config config.json --dry-run
node cli.js --config config.json
node cli.js --config config.json --ids 006A,006B
node cli.js --config config.json --where "StageName = 'Closed Won'"
```

## 5. How the copy works

1. Fetches the root records by IDs or WHERE clause.
2. Fetches the children configured in `children` (and grandchildren, if configured under "Filhos de outros níveis", children of other levels).
3. Walks up lookups/master-detail relationships up to `maxParentDepth` levels, bringing parents whose object is in `copyObjects`.
4. The **standard Price Book** is never created: it is linked to the target's standard one. Custom Price Book entries bring along the standard entry for the same product.
5. **RecordType** is linked by DeveloperName.
6. **matchBy** looks for records that already exist in the target (e.g. Product by `ProductCode`) and reuses them instead of duplicating. Unique-key and ambiguous rules: see section 3a.
7. Each root record becomes an atomic graph: if one item fails, nothing in that graph is written. If the tree exceeds "Máx. registros por graph" (max records per graph, up to 500), the graph is split: first the record with its missing parents, then the children in sequential batches. A failed batch doesn't stop the others; on a rerun, whatever was already written is reused.

Only writable fields that exist in both orgs are sent. `OwnerId` is skipped by default (the owner becomes the logged-in user in the target).

**Metadata differences between the orgs** show up in the **Avisos** tab, already during the dry run:
- a field with a value in the source that doesn't exist or isn't writable in the target → omitted (yellow warning);
- a value that doesn't exist in a restricted picklist in the target → **the write will fail** (red warning);
- a required field in the target left without a value → **the write will fail** (red warning).

If the dry run shows red warnings, the screen opens directly on the Avisos tab. Fix the metadata in the target (or use `skipFields`) before running.

## 6. Troubleshooting

| Symptom | What to do |
|---|---|
| "sf não encontrado" (sf not found) | Install the CLI. If it's in a non-standard location, set it in ⚙ Configurações. |
| Org "(não conectada)" (not connected) | Log in again with **+ Conectar org** using the same alias. |
| `REQUIRED_FIELD_MISSING` | The required lookup points to an object that isn't in "Objetos que podem ser criados". Add it. |
| `FIELD_CUSTOM_VALIDATION_EXCEPTION` | A validation rule, trigger or flow in the target blocked it. Adjust the data or temporarily disable the rule. |
| `STANDARD_PRICE_NOT_DEFINED` | The product has no price in the source's standard Price Book. |
| Duplicate records | Adjust `matchBy` under Avançado. |
| `DUPLICATE_VALUE` | The record already exists in the target with the same value in a unique field. Keep "Reconhecer registros pelo ID externo automaticamente" on, or create a `matchBy` rule with that field. The app retries once on its own; if it still fails, check the error in the log. |
| Warning "não atualizado — ..." (not updated) | The existing record was linked, but Salesforce rejected the update (validation, trigger or permission). The copy continues; fix it in the target if needed. |
| Warning "casou com mais de um registro no destino" (matched more than one record in the target) | There are duplicates in the target for that key, so the rule was skipped. Use a unique field (e.g. a code) as the first rule. |
| Warning "não existe na origem/destino (regra ignorada)" (doesn't exist in source/target, rule skipped) | A `matchBy` field doesn't exist in one of the orgs. Fix the name, or mark the field with `?` if it's optional. |
| Warning "não encontrado no destino por ... (campo omitido)" (not found in target, field omitted) | A link-only object has no matching record in the target. Create it there or adjust the key. |
| Linux: AppImage closes on launch (Ubuntu 24.04) | Use the `.deb`, or run the AppImage with `--no-sandbox`. |

## 7. Development

```bash
npm install
npm start          # opens the app
npm test           # tests the data and metadata engines against mocked orgs
```

### Building the installers

**With GitHub Actions (recommended)** — the `.github/workflows/build.yml` workflow builds Windows, macOS and Linux at once:
- manually: **Actions → Build installers → Run workflow**; the files are attached to the run as artifacts;
- per version: bump `version` in `package.json`, then `git tag v1.1.0 && git push --tags`. This creates a Release with the installers and `docs/INSTALL.md` as its description.

**Locally** — each system builds its own (the `.dmg` can only be built on a Mac):
```bash
npm run dist:win     # on Windows
npm run dist:mac     # on macOS
npm run dist:linux   # on Linux
```

### Project layout

```
engine/engine.js     engine (collection, ordering, matchBy, Composite Graph)
engine/metadata.js   metadata copy (list, retrieve and deploy)
engine/sf-cli.js     Salesforce CLI integration
cli.js               command line
app/main.js          Electron main process
app/preload.js       secure bridge between the UI and the engine
app/renderer/        UI (HTML, CSS, JS)
test/                engine tests with mocked orgs
docs/INSTALL.md      installation guide (also used as the release description)
```
