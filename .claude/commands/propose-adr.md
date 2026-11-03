---
description: Cria draft de ADR seguindo o template do repositório invocando o agent adr-author. Pede título + contexto.
---

# /propose-adr

Cria draft de ADR novo em `docs/adr/MA-<NNN>-<slug>.md`, status `Proposta`. Use quando aparecer decisão estrutural não coberta por ADR existente (§13 do CLAUDE.md).

## Argumentos

Dois inputs obrigatórios:

1. **Título**: frase curta em português, sem prefixo `MA-`. Ex.: `KMS provider AWS para produção`, `Particionamento mensal de audit_logs`, `OpenAPI gerado a partir de Zod`.
2. **Contexto resumido**: 3-6 linhas explicando o problema, alternativas consideradas, e por que a decisão precisa ser carimbada agora (não pode ficar implícita no código).

Uso típico:

```
/propose-adr
título: KMS provider AWS para produção
contexto: V1 usa KMS local (stub). Pré go-live (MA-012 + infra prod) exige decisão entre AWS KMS, GCP KMS ou HashiCorp Vault. Custo, latência, e ergonomia de rotação diferem. Decisão precisa ser carimbada antes de provisionar.
```

## O que faz

1. Valida os dois inputs.
2. Identifica o próximo número MA- disponível lendo `docs/adr/` (último é MA-012; próximo é MA-013).
3. Lê o template/formato dos ADRs existentes (MA-001, MA-008 são bons modelos) e o índice `docs/adr/README.md`.
4. Invoca o agent **`adr-author`** passando título + contexto + número + ADRs adjacentes relevantes (que podem ser referenciados ou superseded).
5. Agent produz arquivo `docs/adr/MA-<NNN>-<slug>.md` com seções padrão: Status, Contexto, Decisão, Consequências, Alternativas consideradas, Referências.
6. Atualiza `docs/adr/README.md` adicionando linha no índice com status `Proposta`.
7. Reporta o arquivo criado e lembra: ADR `Proposta` não é decisão final — exige discussão e mudança para `Aceita` ou `Rejeitada` em PR separado.

## Não-faz

- Não muda código nem schema. ADR é decisão, não implementação.
- Não marca como `Aceita` automaticamente. Isso exige revisão humana.
- Não supersede outro ADR sem o usuário confirmar qual e por quê.
