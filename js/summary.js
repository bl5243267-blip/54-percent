/**
 * 会话总结：统计、时间轴、可导出的 HTML 报告
 *
 * 这一层只做两件事：把整段采集压成一份可核对的统计，并把「多种口径读同一份数据」
 * 摆在同一张图上。它不给结论，因为给不出——六种口径的跨度就是论据本身。
 */

import { SIGNALS, SIGNAL_MAP, SCHEMES, BASELINE, scoreScheme, verdictOf, colorOf, fmtClock } from './analysis.js';

export const SIG_COLORS = {
  browDown: '#f85149', browUp: '#58a6ff', lipPress: '#d29922', lipDown: '#db6d28',
  lipUp: '#3fb950', squint: '#39c5cf', blink: '#bc8cff', jaw: '#8b949e',
};

/* ------------------------------------------------------------------ */
/*  统计                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param {object} input
 * @param {Array}  input.events      事件数组
 * @param {number} input.duration    采集时长（秒）
 * @param {number} input.totalFrames 处理帧数
 * @param {number} input.faceFrames  检出人脸的帧数
 * @param {object} input.avgSignals  全程平均信号（每帧均值）
 * @param {string} input.source      数据来源描述
 */
export function computeSummary({
  events = [], duration = 0, totalFrames = 0, faceFrames = 0, avgSignals = {}, source = '',
}) {
  const dur = Math.max(duration, 0.1);
  const total = events.length;
  const microCount = events.filter((e) => e.micro).length;

  const perSignal = SIGNALS.map((s) => {
    const list = events.filter((e) => e.id === s.id);
    const avgPeak = list.length ? list.reduce((a, e) => a + e.peak, 0) / list.length : 0;
    const avgDur = list.length ? list.reduce((a, e) => a + e.dur, 0) / list.length : 0;
    return {
      id: s.id, label: s.label, alts: s.alts,
      count: list.length,
      rate: list.length / (dur / 60),        // 次 / 分钟
      avgPeak, avgDur,
      micro: list.filter((e) => e.micro).length,
      share: total ? list.length / total : 0,
      coverage: list.reduce((a, e) => a + e.dur, 0) / dur, // 累计占比
    };
  });

  // 峰值口径：基线打底，取每类动作的最高强度
  const peakSignals = { ...BASELINE };
  for (const k of Object.keys(SIGNAL_MAP)) peakSignals[k] = BASELINE[k] ?? 0.1;
  for (const e of events) peakSignals[e.id] = Math.max(peakSignals[e.id] || 0, e.peak);

  // 平均口径：全程每帧均值，缺项用基线
  const meanSignals = { ...BASELINE };
  for (const k of Object.keys(SIGNAL_MAP)) {
    meanSignals[k] = Number.isFinite(avgSignals[k]) ? avgSignals[k] : (BASELINE[k] ?? 0.1);
  }

  const cells = [];
  for (const s of SCHEMES) {
    cells.push({
      schemeId: s.id, schemeName: s.name.replace(/^方案\s*[A-C]\s*·\s*/, ''),
      lens: '全程平均', score: scoreScheme(meanSignals, s),
    });
    cells.push({
      schemeId: s.id, schemeName: s.name.replace(/^方案\s*[A-C]\s*·\s*/, ''),
      lens: '动作峰值', score: scoreScheme(peakSignals, s),
    });
  }
  for (const c of cells) {
    c.verdict = verdictOf(c.score);
    c.color = colorOf(c.score);
  }

  const sorted = [...cells].sort((a, b) => a.score - b.score);
  const lo = sorted[0];
  const hi = sorted[sorted.length - 1];
  const spread = {
    min: lo.score, max: hi.score, delta: hi.score - lo.score,
    minLabel: `${lo.schemeName} · ${lo.lens}`,
    maxLabel: `${hi.schemeName} · ${hi.lens}`,
    verdicts: [...new Set(sorted.map((c) => c.verdict))],
  };

  const dominant = [...perSignal].sort((a, b) => b.count - a.count).filter((p) => p.count > 0).slice(0, 3);

  return {
    source,
    duration: dur,
    totalFrames, faceFrames,
    faceRate: totalFrames ? faceFrames / totalFrames : 0,
    total, microCount,
    microShare: total ? microCount / total : 0,
    perSignal, dominant, cells, spread,
    meanSignals, peakSignals,
    events,
  };
}

/* ------------------------------------------------------------------ */
/*  时间轴（SVG，报告里也复用同一份）                                    */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function niceTicks(dur) {
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = candidates.find((c) => dur / c <= 8) || 900;
  const out = [];
  for (let t = 0; t <= dur + 1e-6; t += step) out.push(t);
  return out;
}

/**
 * @param {object} s   computeSummary 的返回值
 * @param {object} opt {w, h, padLeft}
 */
export function timelineSvg(s, opt = {}) {
  const w = opt.w || 760;
  const padL = opt.padLeft || 82;
  const padR = 14;
  const padT = 22;
  const rows = s.perSignal.filter((p) => p.count > 0);
  const list = rows.length ? rows : [];
  const rowH = 20;
  const padB = 26;
  const h = opt.h || (padT + Math.max(1, list.length) * rowH + padB);
  const gw = w - padL - padR;

  const dur = Math.max(s.duration, 0.1);
  const xOf = (t) => padL + (Math.min(t, dur) / dur) * gw;

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="none"/>`);

  // 纵向网格 + 时间刻度
  for (const t of niceTicks(dur)) {
    const x = xOf(t).toFixed(1);
    parts.push(`<line x1="${x}" y1="${padT - 6}" x2="${x}" y2="${h - padB + 4}" stroke="#30363d" stroke-width="0.6" stroke-dasharray="2 3"/>`);
    parts.push(`<text x="${x}" y="${h - padB + 18}" fill="#6e7681" font-size="9.5" text-anchor="middle" font-family="ui-monospace,monospace">${fmtClock(t)}</text>`);
  }

  if (!list.length) {
    parts.push(`<text x="${w / 2}" y="${padT + 22}" fill="#6e7681" font-size="12" text-anchor="middle">没有采集到超过阈值的事件</text>`);
  }

  list.forEach((p, i) => {
    const y = padT + i * rowH + rowH / 2;
    const col = SIG_COLORS[p.id] || '#8b949e';
    parts.push(`<text x="${padL - 8}" y="${y + 3.5}" fill="#8b949e" font-size="10.5" text-anchor="end">${esc(p.label)}</text>`);
    parts.push(`<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="#21262d" stroke-width="0.6"/>`);

    for (const e of s.events) {
      if (e.id !== p.id) continue;
      const x0 = xOf(e.t0);
      const x1 = xOf(e.t1 ?? e.t0 + e.dur);
      const bw = Math.max(2, x1 - x0);
      const op = e.micro ? 0.95 : 0.55;
      const bh = e.micro ? 9 : 7;
      parts.push(`<rect x="${x0.toFixed(1)}" y="${(y - bh / 2).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh}" rx="1" fill="${col}" fill-opacity="${op}"/>`);
    }
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="事件时间轴">${parts.join('')}</svg>`;
}

/* ------------------------------------------------------------------ */
/*  HTML 报告（自包含，双击即可打开）                                    */
/* ------------------------------------------------------------------ */

export function reportHtml(s) {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const kpi = (label, value, note = '') => `
    <div class="kpi"><div class="k-l">${esc(label)}</div>
      <div class="k-v">${esc(value)}</div>
      ${note ? `<div class="k-n">${esc(note)}</div>` : ''}</div>`;

  const statRows = s.perSignal.filter((p) => p.count > 0).map((p) => `
    <tr>
      <td><span class="sw" style="background:${SIG_COLORS[p.id] || '#8b949e'}"></span>${esc(p.label)}</td>
      <td class="n">${p.count}</td>
      <td class="n">${(Math.round(p.rate * 10) / 10).toFixed(1)}</td>
      <td class="n">${p.avgPeak.toFixed(2)}</td>
      <td class="n">${Math.round(p.avgDur * 1000)}</td>
      <td class="n">${p.micro}</td>
      <td class="bar"><i style="width:${(p.share * 100).toFixed(1)}%;background:${SIG_COLORS[p.id] || '#8b949e'}"></i></td>
    </tr>`).join('') || '<tr><td colspan="7" class="none">没有超过阈值的事件</td></tr>';

  const loScore = Math.min(...s.cells.map((c) => c.score));
  const hiScore = Math.max(...s.cells.map((c) => c.score));
  const cells = s.cells.map((c) => {
    const isMax = c.score === hiScore;
    const isMin = c.score === loScore;
    return `
    <div class="cell${isMax ? ' is-max' : ''}${isMin ? ' is-min' : ''}">
      <div class="c-h">${esc(c.schemeName)}<span>${esc(c.lens)}</span></div>
      <div class="c-s" style="color:${c.color}">${c.score.toFixed(1)}%</div>
      <div class="c-v">${esc(c.verdict)}</div>
      <div class="c-b"><i style="width:${c.score.toFixed(1)}%;background:${c.color}"></i></div>
      ${isMax ? '<span class="tag" style="color:' + c.color + '">最高</span>' : ''}
      ${isMin && !isMax ? '<span class="tag" style="color:' + c.color + '">最低</span>' : ''}
    </div>`;
  }).join('');

  const alts = s.dominant.map((p) => `
    <li><b>${esc(p.label)}</b>（${p.count} 次）—— 还可能是：${esc(p.alts.join('、'))}</li>`).join('')
    || '<li>没有足够的事件可用于列举替代解释。</li>';

  // 没有事件时不能摆出六格 50.0%：那是「没有输入」，不是「无法判断」的测量结论。
  const schemeSection = s.total === 0
    ? `<div class="notice">
        <b>数据不足，无法给出任何读数。</b><br>
        这段材料里没有检测到超过阈值的行为事件${s.faceRate === 0 ? '，且全程未检出人脸' : ''}。
        六种口径在这种情况下都只能落在基线 50%，那是「没有输入」的结果，
        不能读作「测量结论是无法判断」。<br>
        建议：换一段有人脸、时长 ≥ 10 秒的视频，或确认预览画面里能画面部网格。
      </div>`
    : `<div class="cells">${cells}</div>
      <div class="spread">
        最低 <b>${s.spread.min.toFixed(1)}%</b>（${esc(s.spread.minLabel)}）　
        最高 <b>${s.spread.max.toFixed(1)}%</b>（${esc(s.spread.maxLabel)}）　
        跨度 <b>${s.spread.delta.toFixed(1)}</b> 点，出现
        ${s.spread.verdicts.length} 种互斥判定：${esc(s.spread.verdicts.join(' / '))}。<br>
        六者读的是<b>完全相同</b>的事件序列，差别只在于「用哪套假设加权、用平均还是峰值」。
      </div>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>面部行为测量报告 · ${esc(stamp)}</title>
<style>
  :root{--ink:#1f2328;--dim:#57606a;--faint:#8c959f;--line:#d0d7de;--bg:#fff;--wash:#f6f8fa;}
  *{box-sizing:border-box}
  body{margin:0;background:#eaeef2;font:14px/1.7 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink)}
  .page{max-width:920px;margin:24px auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:34px 40px 30px}
  h1{margin:0 0 4px;font-size:21px;font-weight:600;letter-spacing:-0.01em}
  .sub{margin:0 0 20px;color:var(--faint);font-size:12px}
  h2{margin:28px 0 12px;font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--dim);
     text-transform:uppercase;border-bottom:1px solid var(--line);padding-bottom:7px}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .kpi{background:var(--bg);padding:12px 12px 13px}
  .k-l{font-size:10.5px;color:var(--faint);letter-spacing:.04em}
  .k-v{font:600 19px/1.3 ui-monospace,Menlo,Consolas,monospace;margin-top:3px}
  .k-n{font-size:10px;color:var(--faint)}
  .tl{border:1px solid var(--line);border-radius:6px;padding:10px 6px 4px;background:var(--wash)}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;font-weight:500;color:var(--faint);font-size:11px;letter-spacing:.03em;
     border-bottom:1px solid var(--line);padding:6px 8px}
  td{padding:6px 8px;border-bottom:1px solid #eaeef2}
  td.n{text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
  td.bar{width:110px}
  td.bar i{display:block;height:5px;border-radius:3px}
  .sw{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;vertical-align:1px}
  .none{color:var(--faint);text-align:center;padding:16px}
  .cells{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:7px}
  .cell{border:1px solid var(--line);border-radius:6px;padding:10px 10px 11px;position:relative}
  .cell.is-max{border-color:rgba(248,81,73,.55)}
  .cell.is-min{border-color:rgba(63,185,80,.55)}
  .c-h{font-size:10.5px;color:var(--dim);display:flex;flex-direction:column;gap:1px;line-height:1.3}
  .c-h span{color:var(--faint);font-size:9.5px}
  .c-s{font:600 17px/1.3 ui-monospace,Menlo,Consolas,monospace;margin:4px 0 1px}
  .c-v{font-size:10.5px;color:var(--dim)}
  .tag{position:absolute;top:6px;right:7px;font-size:8.5px;border:1px solid currentColor;
       border-radius:2px;padding:0 3px;opacity:.9}
  .c-b{margin-top:9px;height:4px;background:#eaeef2;border-radius:2px;overflow:hidden}
  .c-b i{display:block;height:100%}
  .spread{margin-top:12px;border:1px solid var(--line);border-left:3px solid #bf8700;background:#fff8c5;
          border-radius:0 6px 6px 0;padding:12px 15px;font-size:12.5px}
  .spread b{font-family:ui-monospace,Menlo,Consolas,monospace}
  .notice{border:1px solid var(--line);border-left:3px solid #8c959f;background:var(--wash);
          border-radius:0 6px 6px 0;padding:14px 16px;font-size:12.5px;line-height:1.85;color:var(--dim)}
  .notice b{color:var(--ink)}
  ul{margin:6px 0 0;padding-left:20px;font-size:12.5px;color:var(--dim)}
  li{margin:5px 0}
  .note{margin-top:22px;border-top:1px solid var(--line);padding-top:14px;font-size:11.5px;color:var(--faint);line-height:1.8}
  .note strong{color:var(--ink)}
  @media print{body{background:#fff}.page{border:0;margin:0;max-width:none}}
</style></head><body>
<div class="page">
  <h1>面部行为测量报告</h1>
  <p class="sub">${esc(s.source || '未标注来源')} ｜ 生成于 ${esc(stamp)} ｜ 本报告不给出真伪判断</p>

  <div class="kpis">
    ${kpi('采集时长', fmtClock(s.duration))}
    ${kpi('人脸检出率', (s.faceRate * 100).toFixed(1) + '%', `${s.faceFrames} / ${s.totalFrames} 帧`)}
    ${kpi('事件总数', String(s.total))}
    ${kpi('微表情事件', String(s.microCount), `占 ${(s.microShare * 100).toFixed(0)}%`)}
    ${kpi('事件频率', (s.total / Math.max(s.duration / 60, 0.01)).toFixed(1), '次 / 分钟')}
    ${kpi('口径跨度', s.total === 0 ? '—' : s.spread.delta.toFixed(1) + ' 点',
      s.total === 0 ? '无有效数据' : `${s.spread.min.toFixed(1)} → ${s.spread.max.toFixed(1)}`)}
  </div>

  <h2>事件时间轴</h2>
  <div class="tl">${timelineSvg(s, { w: 820, padLeft: 88 })}</div>

  <h2>动作分布</h2>
  <table>
    <thead><tr><th>动作</th><th class="n">次数</th><th class="n">次/分</th>
      <th class="n">均强度</th><th class="n">均时长 ms</th><th class="n">微表情</th><th>占比</th></tr></thead>
    <tbody>${statRows}</tbody>
  </table>

  <h2>同一段数据 · 六种口径</h2>
  ${schemeSection}

  <h2>主要动作的替代解释</h2>
  <ul>${alts}</ul>

  <div class="note">
    <strong>本报告的性质：</strong>它是一份行为测量记录，不是真伪判定。<br>
    「面部动作 → 欺骗意图」之间的映射从未被实证确立。DePaulo 等（2003）对 158 项研究的荟萃分析给出人类判断谎言的准确率约
    54%，与随机猜测无实质差异；美国国家科学院（2003）同样否定了基于行为观察的测谎技术。<br>
    每一条事件都至少有 4–5 种同样合理的解释（紧张、疲劳、文化差异、性格、被注视的自我意识、
    语言不熟练）。本报告无力在它们之间做选择，因此<strong>任何单项或组合分数都不构成判断依据</strong>。<br>
    若要核实事实，路径只有一条：可外部验证的证据与记录。
  </div>
</div>
</body></html>`;
}

/* 下载工具 */
export function download(name, text, mime = 'text/html;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
