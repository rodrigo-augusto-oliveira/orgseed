# SF Graph Copy

Ferramenta interna para copiar registros de uma org Salesforce para outra, levando junto os registros **pais** e **filhos** necessários, usando a **Composite Graph API**. Serve para popular sandboxes com a massa de dados vazia ou incompleta.

Tem interface (Windows, macOS e Linux) e linha de comando. A tela inicial oferece duas opções:

- **Copiar dados** — registros com pais e filhos (Composite Graph API).
- **Copiar metadados** — objetos completos, somente campos ou outros componentes (Metadata API, via Salesforce CLI).

---

## 1. Requisitos

- **Salesforce CLI (`sf`)** instalado em cada máquina. O login nas orgs é feito por ele.
  ```bash
  npm install -g @salesforce/cli
  sf --version
  ```
- O usuário Salesforce precisa de **API Enabled**, leitura na origem e criação no destino dos objetos copiados.

## 2. Instalar o app

Baixe o instalador do sistema na aba **Actions** (ou **Releases**) do repositório.

| Sistema | Arquivo | Primeira abertura |
|---|---|---|
| Windows | `SF-Graph-Copy-x.y.z-win-x64.exe` (instalador) ou `-portable.exe` | O SmartScreen avisa "aplicativo não reconhecido": clique em **Mais informações → Executar assim mesmo**. |
| macOS | `SF-Graph-Copy-x.y.z-mac-arm64.dmg` (Apple Silicon) ou `-x64.dmg` (Intel) | Arraste para Aplicativos. Na primeira vez o macOS bloqueia: abra **Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim**. Se aparecer "o app está danificado", rode `xattr -cr "/Applications/SF Graph Copy.app"` no Terminal. |
| Linux | `.deb` (Ubuntu/Debian, recomendado) ou `.AppImage` | `.deb`: `sudo apt install ./SF-Graph-Copy-*.deb`. `.AppImage`: `chmod +x` e execute. |

O app não é assinado com certificado pago, por isso os avisos acima. Para uso interno, é normal.

## 3. Usar a interface

1. **Orgs** — clique em **+ Conectar org**, dê um apelido e escolha Sandbox, Produção ou domínio próprio. O navegador abre para o login (é o `sf org login web`). As orgs já conectadas no `sf` aparecem automaticamente.
2. Escolha **Origem** e **Destino**. O app avisa se o destino não parece ser uma sandbox.
3. **Registros raiz** — informe o objeto (ex.: `Opportunity`) e:
   - **IDs**: cole um ou vários IDs; ou
   - **Filtro SOQL**: só a cláusula WHERE, ex.: `StageName = 'Closed Won' AND CloseDate = LAST_N_DAYS:30`, com LIMIT.
4. **Filhos a levar** — marque os relacionamentos (ex.: `OpportunityLineItems`, `OpportunityContactRoles`).
5. **Objetos que podem ser criados** — o que o app pode criar no destino. **✦ Sugerir** adiciona a raiz, os filhos e os pais obrigatórios (ex.: PricebookEntry, Product2, Pricebook2), e põe no início do `matchBy` os campos com valor único ou ID externo da origem (ex.: `CodigoSAP__c`).
6. Clique em **Simular**. Nada é gravado: você vê, para cada registro raiz, o que seria criado (raiz, pais, filhos) e o que seria ligado a registros que já existem no destino.
7. Clique em **Executar**. O app pede confirmação mostrando a org destino e grava.
8. Em **Graphs**, cada registro raiz mostra ✓ (criado) ou ✕ (falhou, com o erro do Salesforce). **Avisos** lista campos omitidos. **Abrir arquivo de log** mostra o JSON completo com payloads, respostas e o mapa de IDs origem → destino.

**Perfis**: salve a configuração (ex.: "Oportunidades com itens") e reutilize. Dá para importar/exportar o mesmo `config.json` usado na linha de comando.

## 3a. Reaproveitar, ligar e não duplicar

Estas opções ficam na tela de cópia de dados (algumas em **Avançado**).

- **Não duplicar o que já foi copiado** (ligado por padrão). O app lê os logs das execuções reais anteriores entre a mesma origem e o mesmo destino. Se o registro ainda existe no destino, ele é reaproveitado: não é criado de novo, e os filhos que ainda não foram ligados a ele (ex.: incluídos na configuração depois da cópia) são criados ligados a ele. Se nada faltar, o graph aparece como "Já copiado antes em dd/mm/aaaa" sem criar nada. Se o registro foi apagado no destino, ele é criado de novo. Simulações não entram nesse histórico.
- **Atualizar os registros que já existem** (ligado por padrão). Quando o app reconhece um registro no destino (pelo histórico, pelo ID externo, pelo `matchBy` ou pelo campo de ID de origem), ele atualiza esse registro com os dados da origem, em vez de só ligar. Só os campos que mudaram são enviados; se nada mudou, o registro não é tocado (não dispara trigger nem flow à toa). As atualizações vão antes da criação, separadas: se uma falhar, vira aviso e a oportunidade é criada assim mesmo. Nunca são atualizados: objetos só para ligar (ex.: User), RecordType e o Price Book padrão com as suas entradas de preço. Lookups que apontam para registros que ainda não existem no destino ficam fora da atualização, com aviso. Na simulação, o total aparece em "Seriam atualizados".
- **Reconhecer pelo ID externo** (Avançado, ligado por padrão). Todo campo marcado como ID externo no destino, e que exista na origem, vira a primeira regra de reconhecimento do objeto, mesmo sem `matchBy`. Isso evita `DUPLICATE_VALUE` em cadastros como zona de transporte, cultura e tabela de preço.
- **Rede de segurança para `DUPLICATE_VALUE`**. Se a criação ainda falhar por valor duplicado num campo único, o app pega o ID do registro existente na mensagem do Salesforce, liga e atualiza esse registro, e reenvia o graph uma única vez.
- **Campo de ID de origem** (Avançado, opcional), ex.: `{ "Opportunity": "IdOrigem__c" }`. Ao criar um registro, o app grava nesse campo o ID da origem. Nas próximas cópias ele acha o registro por esse campo, mesmo sem o log. O campo precisa existir e ser gravável no destino; se não existir, o app avisa e ignora.
- **Objetos só para ligar** (Avançado), ex.: `{ "User": ["Email"], "Regional__c": ["Name"] }`. São objetos que não são copiados, só ligados: o app procura o registro equivalente no destino e grava o lookup apontando para ele. Se não achar, o campo é omitido e aparece um aviso. Não pode estar também em "Objetos que podem ser criados". Por padrão, User é ligado por e-mail; no sandbox o Salesforce acrescenta `.invalid` ao e-mail, e o app ignora esse sufixo na comparação. Para User, se houver mais de um com o mesmo e-mail, vale o ativo.
- **matchBy: formato novo**. Cada objeto tem uma lista de regras, tentadas na ordem. Cada regra é uma lista de campos. A primeira que achar **exatamente um** registro no destino vence. Se uma regra achar mais de um, ela é ignorada (com aviso) e a próxima é tentada; o app nunca escolhe o primeiro. Campo com `?` é opcional: só entra na regra se existir nas duas orgs. Campo obrigatório que não existe numa das orgs faz a regra ser ignorada, com aviso. Valor vazio na origem não casa com nada. O formato antigo (`"Account": ["Name"]`) continua valendo: é uma regra só. Texto solto (`"Account": "Name"`) e listas mistas como `[["CodigoSAP__c"], "Name"]` também são aceitas, com cada item sendo uma regra.

Exemplo: procurar Account pelo código do SAP, depois pelo CNPJ e, por último, pelo nome.

```json
"matchBy": {
  "Account": [["CodigoSAP__c"], ["CNPJ__c"], ["Name"]],
  "PricebookEntry": ["Pricebook2Id", "Product2Id", "CurrencyIsoCode?"]
}
```

## 3b. Copiar metadados

1. Na tela inicial, escolha **Copiar metadados** e selecione origem e destino.
2. Em **O que levar**, escolha a aba:
   - **Objetos completos** — o objeto com tudo que pertence a ele (campos, regras de validação, tipos de registro, list views…). Por padrão só aparecem objetos personalizados; marque **Mostrar padrão** para Account, Contact etc.
   - **Somente campos** — escolha o objeto e marque os campos personalizados.
   - **Outros tipos** — escolha o tipo (ApexClass, Flow, Layout, FlexiPage…) e marque os componentes.
3. Nada é carregado antes da hora: cada lista só é buscada quando você abre a aba ou escolhe o objeto/tipo, com indicador de carregamento. **↻ Atualizar lista** busca de novo.
4. Cada item mostra **novo** (não existe no destino) ou **existe no destino** (será sobrescrito). Componentes de pacote gerenciado aparecem desabilitados.
5. O **Pacote** à direita junta tudo o que foi marcado. Se você levar campos de um objeto que não existe no destino, o app avisa.
6. **Validar** baixa da origem e faz um deploy de verificação no destino, sem gravar nada. **Implantar** grava de verdade, depois de uma confirmação.
7. A implantação é tudo ou nada: se um componente falhar, nada é alterado no destino. Os erros aparecem por componente, com a linha quando houver.

Observações:
- Campos novos chegam sem permissão de acesso (FLS). Libere por perfil ou permission set depois.
- Em produção, o Salesforce exige testes Apex quando o pacote tem código. Em sandbox, "Não rodar testes" acelera.
- Tipos guardados em pastas (Report, Dashboard, EmailTemplate, Document) ainda não são suportados.
- Os arquivos baixados e o resultado completo ficam salvos; use **Abrir pasta dos arquivos**.

## 4. Linha de comando

```bash
cp config.example.json config.json   # ajuste source, target e root
node cli.js --config config.json --dry-run
node cli.js --config config.json
node cli.js --config config.json --ids 006A,006B
node cli.js --config config.json --where "StageName = 'Closed Won'"
```

## 5. Como a cópia funciona

1. Busca os registros raiz por IDs ou WHERE.
2. Busca os filhos configurados em `children` (e filhos dos filhos, se configurados em "Filhos de outros níveis").
3. Sobe pelos lookups/master-detail até `maxParentDepth` níveis, trazendo pais cujo objeto está em `copyObjects`.
4. **Price Book padrão** nunca é criado: é ligado ao padrão do destino. Entradas de Price Book customizado levam junto a entrada padrão do mesmo produto.
5. **RecordType** é ligado pelo DeveloperName.
6. **matchBy** procura no destino registros que já existem (ex.: Produto pelo `ProductCode`) e os reaproveita em vez de duplicar. Regras de chave única e ambíguas: ver a seção 3a.
7. Cada registro raiz vira um graph atômico: se um item falha, nada daquele graph é gravado. Se a árvore passa de "Máx. registros por graph" (até 500), o graph é dividido: primeiro o registro com os pais que faltam, depois os filhos em lotes sequenciais. Um lote que falha não impede os outros; ao reexecutar, o que já foi gravado é reaproveitado.

Só são enviados campos graváveis que existem nas duas orgs. `OwnerId` é ignorado por padrão (o dono vira o usuário logado no destino).

**Diferenças de metadados entre as orgs** aparecem na aba **Avisos**, já na simulação:
- campo com valor na origem que não existe ou não é gravável no destino → omitido (aviso amarelo);
- valor que não existe numa picklist restrita do destino → **a gravação vai falhar** (aviso vermelho);
- campo obrigatório no destino que ficou sem valor → **a gravação vai falhar** (aviso vermelho).

Se a simulação mostrar avisos vermelhos, a tela abre direto na aba Avisos. Corrija o metadado no destino (ou use `skipFields`) antes de executar.

## 6. Problemas comuns

| Sintoma | O que fazer |
|---|---|
| "sf não encontrado" | Instale o CLI. Se estiver num caminho fora do padrão, informe em ⚙ Configurações. |
| Org "(não conectada)" | Refaça o login em **+ Conectar org** com o mesmo apelido. |
| `REQUIRED_FIELD_MISSING` | O lookup obrigatório aponta para um objeto que não está em "Objetos que podem ser criados". Adicione-o. |
| `FIELD_CUSTOM_VALIDATION_EXCEPTION` | Regra de validação, trigger ou flow do destino bloqueou. Ajuste os dados ou desative a regra temporariamente. |
| `STANDARD_PRICE_NOT_DEFINED` | O produto não tem preço no Price Book padrão da origem. |
| Registros duplicados | Ajuste o `matchBy` em Avançado. |
| `DUPLICATE_VALUE` | O registro já existe no destino com o mesmo valor num campo único. Deixe ligado "Reconhecer registros pelo ID externo" ou crie uma regra no `matchBy` com esse campo. O app tenta de novo sozinho uma vez; se ainda falhar, veja o erro no log. |
| Aviso "não atualizado — ..." | O registro existente foi ligado, mas o Salesforce recusou a atualização (validação, trigger ou permissão). A cópia segue; ajuste no destino se precisar. |
| Aviso "casou com mais de um registro no destino" | Há duplicados no destino para essa chave, então a regra foi ignorada. Use um campo único (ex.: código) como primeira regra. |
| Aviso "não existe na origem/destino (regra ignorada)" | Um campo do `matchBy` não existe numa das orgs. Corrija o nome ou marque o campo com `?` se for opcional. |
| Aviso "não encontrado no destino por ... (campo omitido)" | Um objeto de "Objetos só para ligar" não tem registro equivalente no destino. Crie-o lá ou ajuste a chave. |
| Linux: AppImage fecha ao abrir (Ubuntu 24.04) | Use o `.deb`, ou rode o AppImage com `--no-sandbox`. |

## 7. Desenvolvimento

```bash
npm install
npm start          # abre o app
npm test           # testa os motores de dados e metadados com orgs simuladas
```

### Gerar instaladores

**Pelo GitHub Actions (recomendado)** — o workflow `.github/workflows/build.yml` gera Windows, macOS e Linux de uma vez:
- manualmente: aba **Actions → Gerar instaladores → Run workflow**; os arquivos ficam nos artifacts da execução;
- por versão: `git tag v1.0.0 && git push --tags` cria uma Release com os instaladores.

**Localmente** — cada sistema gera o seu (o `.dmg` só pode ser gerado num Mac):
```bash
npm run dist:win     # no Windows
npm run dist:mac     # no macOS
npm run dist:linux   # no Linux
```

### Estrutura

```
engine/engine.js     motor (coleta, ordenação, matchBy, Composite Graph)
engine/metadata.js   cópia de metadados (listar, baixar e implantar)
engine/sf-cli.js     integração com o Salesforce CLI
cli.js               linha de comando
app/main.js          processo principal do Electron
app/preload.js       ponte segura entre a interface e o motor
app/renderer/        interface (HTML, CSS, JS)
test/                testes do motor com orgs simuladas
```
