import type { TelemetrySample } from '../state';
import { esc, formatRate } from '../utils';

export type NetChartMode = 'both' | 'tx' | 'rx';

function fmtSlotTime(ts: number, seeded?: boolean): string {
  if (seeded) return '历史占位';
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function chartShell(label: string, bars: string): string {
  return `<div class="chart-wrap"><svg class="collie-chart" viewBox="0 0 400 96" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><line x1="0" y1="50" x2="400" y2="50" stroke="var(--cds-border)" stroke-dasharray="3 3" stroke-width=".8" opacity=".7"/>${bars}</svg><div class="chart-tip hidden"></div></div>`;
}

function barRect(x: number, valRatio: number, width: number, rx: number, fill: string, op: string, bg = true): string {
  const usable = 84;
  const h = valRatio > 0 ? Math.max(3, Math.min(1, valRatio) * usable) : 2;
  const y = (92 - h).toFixed(1);
  return `${bg ? `<rect x="${x}" y="8" width="${width}" height="${usable}" rx="${rx}" fill="var(--bg-circle)" opacity=".45"/>` : ''}<rect x="${x}" y="${y}" width="${width}" height="${h.toFixed(1)}" rx="${rx}" fill="${fill}" opacity="${op}"/>`;
}

export function singleBarChartHtml(opts: {
  samples: TelemetrySample[];
  pick: (s: TelemetrySample) => number;
  label: string;
  tone?: 'accent' | 'mint';
}): string {
  const bars = opts.samples
    .map((s, i) => {
      const v = Math.max(0, Math.min(100, opts.pick(s)));
      const fill = v >= 90 ? 'var(--err)' : v >= 75 ? 'var(--warn)' : opts.tone === 'mint' ? 'var(--ok)' : 'var(--cds-fill-accent)';
      const tip = `${fmtSlotTime(s.ts, s.seeded)} · ${opts.label} ${v.toFixed(1)}%`;
      return `<g class="cbar-slot" data-tip="${esc(tip)}">${barRect(i * 10 + 1.5, v / 100, 7, 2.5, fill, s.seeded ? '.32' : '.95')}</g>`;
    })
    .join('');
  return chartShell(opts.label, bars);
}

export function networkBarChartHtml(samples: TelemetrySample[], mode: NetChartMode): string {
  let maxRate = 10;
  for (const s of samples) {
    if (mode !== 'rx') maxRate = Math.max(maxRate, s.netOut);
    if (mode !== 'tx') maxRate = Math.max(maxRate, s.netIn);
  }
  const bars = samples
    .map((s, i) => {
      const x = i * 10 + 1;
      const op = s.seeded ? '.32' : '.95';
      const tip = `${fmtSlotTime(s.ts, s.seeded)} · ↑ ${formatRate(s.netOut)} / ↓ ${formatRate(s.netIn)}`;
      const body =
        mode === 'tx'
          ? barRect(x + 0.5, s.netOut / maxRate, 7, 2.5, 'var(--cds-fill-accent)', op)
          : mode === 'rx'
            ? barRect(x + 0.5, s.netIn / maxRate, 7, 2.5, 'var(--ok)', op)
            : `${barRect(x, s.netOut / maxRate, 3.5, 1.5, 'var(--cds-fill-accent)', op, false)}${barRect(x + 4.5, s.netIn / maxRate, 3.5, 1.5, 'var(--ok)', op, false)}`;
      return `<g class="cbar-slot" data-tip="${esc(tip)}">${body}</g>`;
    })
    .join('');
  return chartShell('网络吞吐', bars);
}

export function bindChartTooltips(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('.chart-wrap').forEach((wrap) => {
    const tipEl = wrap.querySelector('.chart-tip') as HTMLElement | null;
    if (!tipEl) return;
    wrap.addEventListener('mousemove', (ev) => {
      const text = (ev.target as Element | null)?.closest('.cbar-slot')?.getAttribute('data-tip');
      if (!text) return tipEl.classList.add('hidden');
      const rect = wrap.getBoundingClientRect();
      tipEl.textContent = text;
      tipEl.style.left = `${Math.max(54, Math.min(rect.width - 54, ev.clientX - rect.left))}px`;
      tipEl.classList.remove('hidden');
    });
    wrap.addEventListener('mouseleave', () => tipEl.classList.add('hidden'));
  });
}
