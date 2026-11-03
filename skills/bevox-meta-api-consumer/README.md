# bevox-meta-api-consumer skill

Skill do Claude Code para projetos consumidores da `bevox-meta-api`. Dá ao Claude conhecimento operacional sobre como integrar com a API (Embedded Signup, JWT, webhooks) sem precisar importar o repo `bevox-meta-api` inteiro no workspace.

## Como instalar em um projeto consumidor

Três opções, em ordem de simplicidade.

### Opção A — Symlink (dev local rápido)

```bash
# Na raiz do projeto consumidor:
mkdir -p .claude/skills
ln -s /caminho/para/bevox-meta-api/skills/bevox-meta-api-consumer .claude/skills/bevox-meta-api-consumer
```

Bom para desenvolvimento. Atualiza automaticamente quando você dá `git pull` no repo da meta-api.

### Opção B — Git submodule (recomendado para projetos versionados)

```bash
# Na raiz do projeto consumidor:
git submodule add -b main \
  https://github.com/bevox/bevox-meta-api.git \
  vendor/bevox-meta-api

mkdir -p .claude/skills
ln -s ../../vendor/bevox-meta-api/skills/bevox-meta-api-consumer \
  .claude/skills/bevox-meta-api-consumer
```

Atualizar a skill: `git submodule update --remote vendor/bevox-meta-api`.

### Opção C — Copiar (último recurso)

```bash
cp -r /caminho/para/bevox-meta-api/skills/bevox-meta-api-consumer \
  .claude/skills/
```

Você fica responsável por re-copiar quando a meta-api lançar versão nova. Use só se submodule/symlink não for viável.

### Instalação global (todos os projetos)

```bash
# Linux / Mac
ln -s /caminho/para/bevox-meta-api/skills/bevox-meta-api-consumer \
  ~/.claude/skills/bevox-meta-api-consumer

# Windows (PowerShell admin)
New-Item -ItemType SymbolicLink `
  -Path "$env:USERPROFILE\.claude\skills\bevox-meta-api-consumer" `
  -Target "C:\caminho\para\bevox-meta-api\skills\bevox-meta-api-consumer"
```

## Verificar se ativou

No Claude Code, pergunte: *"como conecto WhatsApp via embedded signup?"* — ele deve invocar `bevox-meta-api-consumer` automaticamente. Se não invocar, confirme que o frontmatter `name` e `description` em `SKILL.md` estão visíveis.

## Atualizar quando a meta-api evoluir

A skill é gerada a partir de:

- `docs/architecture/consumer-integration-guide-v1.md`
- `docs/architecture/openapi.yaml`
- ADRs MA-002, MA-004, MA-005, MA-006, MA-008

Toda alteração nessas fontes que afete contrato externo deve ser refletida aqui no mesmo PR. Bumps maiores (v2) viram diretório irmão `bevox-meta-api-consumer-v2/`.

## Estrutura

```
SKILL.md                           ← entry point (frontmatter + roteiro)
README.md                          ← este arquivo
references/
  01-mental-model.md
  02-jwt-signing.md
  03-endpoints.md
  04-oauth-embedded-signup.md
  05-webhooks-hmac.md
  06-events-sse-polling.md
  07-error-codes.md
  08-idempotency.md
  09-checklist.md
snippets/
  jwt-signer.ts
  meta-api-client.ts
  webhook-handler-fastify.ts
  webhook-handler-nextjs.ts
```

## Decisões de design desta skill

- **Modelo progressive disclosure.** SKILL.md carrega só o essencial. Cada reference fica em arquivo separado para o Claude carregar sob demanda — o contexto do consumidor não é poluído com detalhes de OAuth quando ele só quer enviar mensagem.
- **Snippets executáveis, não pseudocódigo.** Cada snippet é TS válido com tipos e tratamento de erro. O Claude pode copiar literalmente.
- **Fontes canônicas referenciadas, não duplicadas.** Quando há conflito entre skill e PRD/OpenAPI/ADR, fonte canônica ganha.
- **Sem MCP por enquanto.** Skill cobre 95% dos casos (conhecimento estável). MCP entra quando dor real de "executar ação contra meta-api viva" aparecer.
