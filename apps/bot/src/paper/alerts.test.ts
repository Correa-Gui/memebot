import { describe, expect, it } from 'vitest';
import { HourlyScheduler, StreamWatch, nextHourBoundaryMs, parseRunMarker, restartAlertLines } from './alerts.ts';

const at = (h: number, m: number, s = 0): number => Date.UTC(2026, 9, 2, h, m, s);

describe('agendamento do resumo por hora (virada de hora BRT = UTC)', () => {
  it('próxima virada é a hora cheia seguinte; numa hora cheia exata, a próxima', () => {
    expect(nextHourBoundaryMs(at(3, 27, 19))).toBe(at(4, 0)); // 00:27 BRT → 01:00 BRT
    expect(nextHourBoundaryMs(at(4, 0))).toBe(at(5, 0));
  });

  it('dispara uma vez por virada e, depois de dormir horas, uma vez só e realinha', () => {
    const h = new HourlyScheduler(at(3, 27));
    expect(h.due(at(3, 59, 59))).toBe(false);
    expect(h.due(at(4, 0, 0))).toBe(true);
    expect(h.due(at(4, 0, 1))).toBe(false);
    expect(h.nextMs).toBe(at(5, 0));
    expect(h.due(at(7, 30))).toBe(true); // processo parado 3 h: um resumo, não três
    expect(h.nextMs).toBe(at(8, 0));
  });
});

describe('StreamWatch (> 60 s sem eventos)', () => {
  it('não alerta antes do primeiro evento nem abaixo do limite', () => {
    const w = new StreamWatch(60_000);
    expect(w.check(at(4, 0), null)).toBeNull();
    expect(w.check(at(4, 1), at(4, 0, 30))).toBeNull();
  });

  it('down uma vez; up quando volta, com o tempo total sem eventos', () => {
    const w = new StreamWatch(60_000);
    expect(w.check(at(4, 1, 1), at(4, 0, 0))).toEqual({ kind: 'down', silentMs: 61_000 });
    expect(w.check(at(4, 1, 30), at(4, 0, 0))).toBeNull();
    expect(w.check(at(4, 2, 0), at(4, 1, 55))).toEqual({ kind: 'up', silentMs: 115_000 });
    expect(w.check(at(4, 2, 1), at(4, 2, 0))).toBeNull();
  });
});

describe('detecção de queda/reinício', () => {
  it('alerta só se o run anterior não terminou limpo', () => {
    expect(restartAlertLines(null, 0)).toBeNull();
    expect(restartAlertLines({ runId: 'a', startedAtMs: 0, cleanExit: true }, 0)).toBeNull();
    const lines = restartAlertLines({ runId: 'paper-a', startedAtMs: at(3, 0), cleanExit: false }, at(3, 30));
    expect(lines?.[0]).toBe('run anterior: paper-a');
    expect(lines?.[1]).toContain('há 30 min');
  });

  it('marcador inválido é ignorado', () => {
    expect(parseRunMarker('lixo')).toBeNull();
    expect(parseRunMarker('{"runId":"x","startedAtMs":1,"cleanExit":false}')).toEqual({ runId: 'x', startedAtMs: 1, cleanExit: false });
  });
});
