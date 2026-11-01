#!/usr/bin/env python3
"""
行为测量管线 · 命令行入口

用法：

    python run.py --demo                     # 用合成数据跑通全流程，验证版面
    python run.py interview.mp4 -o out.html  # 分析真实视频
    python run.py interview.mp4 --json       # 只输出 JSON
    python run.py interview.mp4 --only openface,whisper   # 只跑指定分析器

依赖按需安装，装不上的分析器会自动跳过，不会中断整条管线。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pipeline.analyzers import ANALYZERS
from pipeline.demo import demo_statuses, make_demo_timeline
from pipeline.fusion import analyze
from pipeline.report import render_html
from pipeline.timeline import Timeline, probe_media


def main() -> int:
    ap = argparse.ArgumentParser(description="多模态行为测量管线")
    ap.add_argument("video", nargs="?", help="输入视频路径")
    ap.add_argument("--demo", action="store_true", help="用合成数据跑通全流程")
    ap.add_argument("-o", "--out", default="report.html", help="HTML 输出路径")
    ap.add_argument("--json", action="store_true", help="同时输出 .json")
    ap.add_argument("--only", default="", help="只运行指定分析器，逗号分隔")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    if not args.demo and not args.video:
        ap.print_help()
        return 2

    # ---------------- 收集事件 ----------------
    if args.demo:
        tl, clock = make_demo_timeline()
        statuses = demo_statuses()
        source = "演示数据（合成）"
        if not args.quiet:
            print("· 演示模式：使用合成数据", file=sys.stderr)
    else:
        path = Path(args.video)
        if not path.exists():
            print(f"找不到文件：{path}", file=sys.stderr)
            return 2

        clock = probe_media(str(path))
        tl = Timeline(clock)
        statuses = []
        source = path.name

        if not args.quiet:
            print(f"· 视频 {clock.duration:.1f}s @ {clock.fps:.2f}fps", file=sys.stderr)
            print(f"· 音频偏移 {clock.audio_offset:+.3f}s"
                  f"{'' if clock.has_audio else '（无音频轨）'}", file=sys.stderr)

        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        for an in ANALYZERS:
            if wanted and an.name not in wanted:
                continue
            if not args.quiet:
                print(f"· 运行 {an.name} …", file=sys.stderr, end="", flush=True)
            res = an.run(str(path), clock)
            statuses.append({"name": an.name, "status": res.status, "detail": res.detail})
            if res.events:
                tl.add(res.events)
            if not args.quiet:
                mark = {"ok": "✓", "skipped": "-", "error": "✗"}.get(res.status, "?")
                print(f" {mark} {res.detail}", file=sys.stderr)

    if len(tl) == 0:
        print("没有任何测量数据，无法生成报告。", file=sys.stderr)
        for s in statuses:
            print(f"  {s['name']}: {s['status']} — {s['detail']}", file=sys.stderr)
        return 1

    # ---------------- 分析 ----------------
    payload = analyze(tl)
    result = {
        "source": source,
        "clock": clock.to_dict(),
        "analyzers": statuses,
        "analysis": payload,
        "generated_at": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
    }

    out_html = Path(args.out)
    out_html.write_text(render_html(payload, tl, clock, statuses, source), encoding="utf-8")
    print(f"报告已生成：{out_html.resolve()}")

    if args.json:
        out_json = out_html.with_suffix(".json")
        out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"数据已生成：{out_json.resolve()}")

    if not args.quiet:
        print(f"\n测量事件 {len(tl)} 条 ｜ 通道 {payload['counts']}")
        print("四套方案：", end="")
        print("  ".join(f"{s['scheme']['name'].split('·')[-1].strip()}="
                        f"{s['score']}%" for s in payload["schemes"]))
        print(f"跨度 {payload['spread']['min']}% – {payload['spread']['max']}%")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
