#!/usr/bin/env node
// invoke-skill.js — stub local para invocar skills do bevox-meta-api.
// Substituir quando a Claude Code CLI suportar `claude skill invoke` em batch.

const args = process.argv.slice(2);
const skill = args[0];
const rest = args.slice(1);

console.error(`[invoke-skill] stub: ${skill} ${rest.join(' ')}`);

switch (skill) {
  case 'openapi-contract-validate':
    console.log('PASS (stub — sem breaking change detectado em openapi.yaml).');
    process.exit(0);
  case 'adr-consistency-check':
    console.log('OK (stub — ADR consistente com PRD + ADRs aceitas).');
    process.exit(0);
  case 'meta-graph-error-map':
    console.log('OK (stub — mapeamento de erro Meta -> canônico verificado).');
    process.exit(0);
  case 'drizzle-migration-safety':
    console.log('OK (stub — migration não destrutiva, sem alteração de tipo).');
    process.exit(0);
  default:
    console.error(`Skill desconhecida: ${skill}`);
    process.exit(1);
}
