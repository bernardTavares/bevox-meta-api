/**
 * UUIDv7 — invariante §5.1 do CLAUDE.md.
 *
 * UUIDv7 carrega timestamp Unix em ms nos primeiros 48 bits, o que dá:
 *   - ordenação temporal natural (índices b-tree eficientes)
 *   - debugging mais simples (timestamp visível no ID)
 *   - compatibilidade com qualquer storage que aceite UUID
 *
 * Uso obrigatório em IDs primários. Nada de serial/bigserial/UUIDv4.
 */

import { v7 as uuidV7 } from "uuid";

/**
 * Gera um UUIDv7 como string (formato hifenado lowercase: 36 chars).
 */
export function uuidv7(): string {
  return uuidV7();
}

/**
 * Extrai o timestamp em ms de um UUIDv7.
 * Útil para debug e auditoria. Não validar correctness do v7 aqui — assumimos
 * que IDs vieram de `uuidv7()`.
 */
export function uuidv7Timestamp(id: string): number {
  // Bits 0-47 (12 hex chars) = unix_ts_ms big-endian.
  const hex = id.replace(/-/g, "").slice(0, 12);
  return Number.parseInt(hex, 16);
}
