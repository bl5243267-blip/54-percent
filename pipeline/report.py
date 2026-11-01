"""
HTML 报告渲染

版面顺序刻意设计成"先给结论，再自己拆掉"：
  大分数 → 四套方案并排（结论跨度） → 特征贡献 → 逐句上下文与替代解释 → 无法判断
"""

from __future__ import annotations

import html
from datetime import datetime

from .fusion import ALTERNATIVES, GENERIC_ALTERNATIVES
from .timeline import MediaClock, Timeline, fmt_t

CSS = """
:root{--bg:#0a0c10;--panel:#11141b;--panel2:#161a23;--line:#232936;
--ink:#d9dee8;--dim:#8a93a6;--faint:#5b6376;--green:#4ade80;--amber:#fbbf24;--red:#f87171;--blue:#60a5fa}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.7 ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"PingFang SC","Microsoft YaHei",monospace}
.wrap{max-width:1080px;margin:0 auto;padding:48px 28px 96px}
h1{font-size:19px;font-weight:600;letter-spacing:.04em;margin:0 0 6px}
.sub{color:var(--faint);font-size:12px;letter-spacing:.08em;margin:0 0 36px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:22px 24px;margin-bottom:18px}
.lbl{font-size:11px;letter-spacing:.18em;color:var(--faint);text-transform:uppercase;margin:0 0 14px}
.big{font-size:64px;font-weight:600;line-height:1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.big small{font-size:20px;color:var(--dim);margin-left:4px}
.verdict{margin-top:10px;font-size:13px;color:var(--amber)}
.bar{position:relative;height:34px;background:var(--panel2);border-radius:6px;overflow:hidden;margin:9px 0}
.bar i{position:absolute;inset:0 auto 0 0;display:block;border-radius:6px}
.bar span{position:absolute;right:12px;top:50%;transform:translateY(-50%);
font-size:12px;font-variant-numeric:tabular-nums;color:#0a0c10;font-weight:700;mix-blend-mode:normal}
.scheme{margin-bottom:16px}
.scheme .nm{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:2px}
.scheme .nm b{font-weight:600}
.scheme .pm{font-size:11.5px;color:var(--faint);margin:0}
.spread{font-size:12.5px;color:var(--amber);margin:16px 0 0;padding-top:14px;border-top:1px dashed var(--line)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th{text-align:left;color:var(--faint);font-weight:400;font-size:11px;letter-spacing:.12em;
padding:0 10px 8px 0;border-bottom:1px solid var(--line)}
td{padding:8px 10px 8px 0;border-bottom:1px solid rgba(35,41,54,.5);vertical-align:top}
td.n{text-align:right;font-variant-numeric:tabular-nums;color:var(--dim)}
.ctx{border-left:2px solid var(--line);padding:0 0 0 18px;margin-bottom:22px}
.ctx .q{font-size:13.5px;color:var(--ink);margin-bottom:4px}
.ctx .t{font-size:11px;color:var(--faint);letter-spacing:.06em}
.tag{display:inline-block;font-size:10.5px;padding:1px 7px;border-radius:4px;margin:5px 5px 0 0;
background:rgba(96,165,250,.12);color:#93c5fd;border:1px solid rgba(96,165,250,.25)}
.alt{font-size:11.5px;color:var(--faint);margin:7px 0 0}
.alt b{color:var(--dim);font-weight:400}
.warn{border-color:rgba(248,113,113,.3);background:rgba(248,113,113,.05)}
.warn h2{color:var(--red)}
h2{font-size:14px;font-weight:600;margin:0 0 12px;letter-spacing:.03em}
ul{margin:0;padding-left:18px}li{margin-bottom:6px;font-size:12.5px;color:var(--dim)}
code{background:var(--panel2);padding:1px 6px;border-radius:4px;font-size:12px;color:var(--blue)}
.foot{color:var(--faint);font-size:11.5px;line-height:1.9;margin-top:28px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:720px){.grid2{grid-template-columns:1fr}.big{font-size:48px}}
"""


def _color(score: float) -> str:
    if score >= 66:
        return "#f87171"
    if score >= 55:
        return "#fbbf24"
    if score >= 45:
        return "#8a93a6"
    return "#4ade80"


def render_html(payload: dict, timeline: Timeline, clock: MediaClock,
                statuses: list[dict], source_name: str) -> str:
    res = payload.get("analysis", payload)
    feats = res["features"]
    labels = res["feature_labels"]

    # ---- 大分数（方案 A） ----
    primary = res["schemes"][0]
    spread = res["spread"]

    scheme_html = []
    for s in res["schemes"]:
        c = _color(s["score"])
        scheme_html.append(f"""
        <div class="scheme">
          <div class="nm"><b>{html.escape(s['scheme']['name'])}</b>
            <span style="color:{c};font-variant-numeric:tabular-nums;font-weight:600">
              {s['score']}% · {html.escape(s['verdict'])}</span></div>
          <div class="bar"><i style="width:{max(2, s['score'])}%;background:{c}"></i></div>
          <p class="pm">{html.escape(s['scheme']['premise'])}</p>
        </div>""")

    # ---- 特征表 ----
    feat_rows = []
    for k, v in sorted(feats.items(), key=lambda x: -x[1]):
        if v <= 0.001:
            continue
        feat_rows.append(
            f"<tr><td>{html.escape(labels.get(k, k))}</td>"
            f"<td class='n'>{v:.0%}</td>"
            f"<td class='n'>{'-' if not ALTERNATIVES.get(k) else len(ALTERNATIVES.get(k, []))}</td></tr>"
        )
    if not feat_rows:
        feat_rows.append("<tr><td colspan='3' style='color:#5b6376'>本段未检测到超过阈值的动作事件</td></tr>")

    # ---- 逐句上下文 ----
    ctx_html = []
    for ctx in res["contexts"][:12]:
        tags = "".join(
            f"<span class='tag'>{html.escape(e['label'])} · {e['value']:.0%}</span>"
            for e in ctx["events"]
        )
        alts = []
        for e in ctx["events"]:
            for a in ALTERNATIVES.get(e["name"], [])[:2]:
                if a not in alts:
                    alts.append(a)
        alt_line = (f"<p class='alt'><b>还可能是：</b>{html.escape('、'.join(alts[:5]))}</p>"
                    if alts else "")
        ctx_html.append(f"""
        <div class="ctx">
          <div class="t">{fmt_t(ctx['t0'])} – {fmt_t(ctx['t1'])}</div>
          <div class="q">{html.escape(ctx['text']) or '（无转写）'}</div>
          <div>{tags or "<span class='tag' style='opacity:.5'>无显著动作</span>"}</div>
          {alt_line}
        </div>""")

    if not ctx_html:
        ctx_html.append("<p style='color:#5b6376;font-size:12.5px'>没有语音转写，无法按句子切分上下文。"
                        "安装了 Whisper 后重新运行即可看到逐句对照。</p>")

    # ---- 分析器状态 ----
    status_rows = []
    for st in statuses:
        color = {"ok": "#4ade80", "skipped": "#fbbf24", "error": "#f87171"}.get(st["status"], "#8a93a6")
        status_rows.append(
            f"<tr><td>{html.escape(st['name'])}</td>"
            f"<td style='color:{color}'>{st['status']}</td>"
            f"<td style='color:#8a93a6'>{html.escape(st['detail'])}</td></tr>"
        )

    clock_json = (f"视频起点 {clock.video_start:.3f}s ｜ 音频起点 {clock.audio_start:.3f}s ｜ "
                  f"音频偏移 {clock.audio_offset:+.3f}s ｜ {clock.fps:.2f} fps ｜ "
                  f"时长 {clock.duration:.1f}s")

    alt_half = (len(GENERIC_ALTERNATIVES) + 1) // 2
    alt_left = "".join(f"<li>{html.escape(a)}</li>" for a in GENERIC_ALTERNATIVES[:alt_half])
    alt_right = "".join(f"<li>{html.escape(a)}</li>" for a in GENERIC_ALTERNATIVES[alt_half:])

    return f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>行为测量报告 · {html.escape(source_name)}</title>
<style>{CSS}</style></head>
<body><div class="wrap">

<h1>行为测量报告</h1>
<p class="sub">{html.escape(source_name)} ｜ 生成于 {datetime.now():%Y-%m-%d %H:%M}</p>

<div class="card">
  <p class="lbl">观测结论 · {html.escape(primary['scheme']['name'])}</p>
  <div class="big" style="color:{_color(primary['score'])}">{primary['score']:.0f}<small>%</small></div>
  <p class="verdict">{html.escape(primary['verdict'])}</p>
</div>

<div class="card">
  <p class="lbl">同一份测量 · 四套方案</p>
  {''.join(scheme_html)}
  <p class="spread">跨度 {spread['min']}% – {spread['max']}%（相差 {spread['range']} 个百分点）：
  没有人规定该用哪些特征、该怎么加权。这个数字不描述「他有没有说谎」，
  只描述「论文作者选了哪套参数」。</p>
</div>

<div class="card">
  <p class="lbl">测量到的动作（仅测量，不含解释）</p>
  <table>
    <tr><th>动作单元 / 指标</th><th style="text-align:right">时间占比</th>
        <th style="text-align:right">可替代解释</th></tr>
    {''.join(feat_rows)}
  </table>
</div>

<div class="card">
  <p class="lbl">逐句对照 · 每条线索都挂着替代解释</p>
  {''.join(ctx_html)}
</div>

<div class="card warn">
  <h2>本报告不能得出「是否说谎」的结论</h2>
  <ul>
    <li>「面部动作 → 欺骗意图」之间的映射未被任何研究证实。荟萃分析显示，
        人类判断谎言的准确率约 <b>54%</b>，与随机猜测（50%）无实质差异。</li>
    <li>上面每条线索都至少有 4–5 种同样合理的解释，报告无法在它们之间做选择。</li>
    <li>当事人若知道自己正被分析，表现会系统性改变，整份测量随之失效。</li>
    <li>可核实的只有事实：文件、记录、第三方证词、时间线。行为测量不是证据。</li>
  </ul>
</div>

<div class="card">
  <p class="lbl">必须并列的替代解释</p>
  <div class="grid2"><ul>{alt_left}</ul><ul>{alt_right}</ul></div>
  <p style="font-size:11.5px;color:#5b6376;margin:10px 0 0">
  以上任何一条单独成立，都足以让上表的全部线索失去意义。</p>
</div>

<div class="card">
  <p class="lbl">技术附录</p>
  <p style="font-size:12px;color:#8a93a6;margin:0 0 12px">{html.escape(clock_json)}</p>
  <table><tr><th>分析器</th><th>状态</th><th>说明</th></tr>{''.join(status_rows)}</table>
</div>

<p class="foot">
方法参考：DePaulo et al. (2003) 荟萃分析，158 项研究；Bond &amp; DePaulo (2006)；
美国国家科学院 (2003)《Polygraph and Lie Detection》。
本报告为测量与可视化练习，不构成对任何个人的判断。
</p>
</div></body></html>"""
