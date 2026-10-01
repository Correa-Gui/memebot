import { existsSync } from 'node:fs';

/**
 * Adaptador de borda (único I/O de `packages/risk`): o arquivo `data/STOP` é a parada manual rápida
 * do kill switch (RISK_AND_SECURITY §3). A lógica pura (`evaluateKillSwitch`) recebe só o boolean.
 */
export function isStopFilePresent(path: string): boolean {
  return existsSync(path);
}

export const DEFAULT_STOP_FILE_PATH = 'data/STOP';
