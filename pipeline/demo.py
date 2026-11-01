"""
演示数据：不依赖任何重型库，用来验证管线与报告版面。

生成的是一段典型的「访谈压力场景」：被问及具体时间地点时出现含糊其辞、
短暂皱眉、抿嘴。注意——这份数据本身就说明不了任何事，
它只是让四种方案有东西可算。
"""

from __future__ import annotations

from .timeline import Event, MediaClock, Timeline

SENTENCES = [
    (0.6, 4.2, "这个……让我想想。"),
    (5.1, 9.6, "那天下午我好像是在公司。"),
    (11.2, 16.0, "具体几点我记不太清了。"),
    (18.1, 23.4, "应该是三点多吧，我在开会。"),
    (25.0, 30.2, "跟谁开会……嗯，记不得了。"),
    (32.4, 37.8, "就是很普通的一个下午。"),
    (39.5, 45.0, "你为什么问这个？"),
    (47.2, 53.0, "我说的都是实话。"),
    (55.0, 60.5, "你们要是不信可以去问他们。"),
]

MICRO_AU = [
    ("AU04", 5.22, 5.58, 0.42), ("AU23", 5.05, 5.34, 0.35),
    ("AU04", 11.24, 11.62, 0.30), ("AU15", 11.90, 12.30, 0.28),
    ("AU01", 18.24, 18.66, 0.36), ("AU04", 18.40, 18.88, 0.38),
    ("AU15", 25.08, 25.52, 0.33), ("AU23", 25.30, 25.70, 0.41),
    ("AU45", 25.66, 25.90, 0.55), ("AU04", 32.50, 32.92, 0.34),
    ("AU01", 39.55, 39.98, 0.48), ("AU04", 39.70, 40.20, 0.36),
    ("AU12", 47.30, 48.10, 0.30), ("AU15", 55.20, 55.70, 0.26),
]


def make_demo_timeline() -> tuple[Timeline, MediaClock]:
    clock = MediaClock(video_start=0.0, audio_start=0.0, fps=30.0,
                       duration=62.0, has_audio=True)
    tl = Timeline(clock)

    for t0, t1, text in SENTENCES:
        tl.add([Event(t0, t1, "asr", "sentence", 1.0, meta={"text": text, "source": "demo"})])

    for name, t0, t1, val in MICRO_AU:
        dur = t1 - t0
        tl.add([Event(
            t0, t1, "face", name, val,
            meta={
                "label": {"AU04": "眉下降", "AU01": "内眉上抬", "AU23": "唇收紧",
                          "AU15": "嘴角下压", "AU12": "嘴角上扬", "AU45": "眨眼"}.get(name, name),
                "source": "demo",
                "duration_ms": int(round(dur * 1000)),
                "micro": dur <= 0.2,
            },
        )])

    # 头部动作
    tl.add([
        Event(12.0, 12.6, "head", "摇头", 0.45, meta={"source": "demo"}),
        Event(25.6, 26.2, "head", "歪头", 0.38, meta={"source": "demo"}),
        Event(40.0, 40.7, "head", "摇头", 0.52, meta={"source": "demo"}),
    ])

    # 情绪片段
    tl.add([
        Event(11.0, 16.2, "emotion", "neutral", 0.62, meta={"source": "demo"}),
        Event(25.0, 30.3, "emotion", "sad", 0.48, meta={"source": "demo"}),
        Event(32.4, 37.9, "emotion", "neutral", 0.58, meta={"source": "demo"}),
        Event(39.5, 45.1, "emotion", "angry", 0.52, meta={"source": "demo"}),
    ])

    # 语速与停顿
    tl.add([
        Event(10.6, 11.2, "prosody", "停顿", 0.72, unit="s", meta={"source": "demo", "ms": 600}),
        Event(24.4, 25.0, "prosody", "停顿", 0.81, unit="s", meta={"source": "demo", "ms": 600}),
        Event(38.9, 39.5, "prosody", "停顿", 0.66, unit="s", meta={"source": "demo", "ms": 600}),
        Event(5.0, 16.0, "prosody", "语速", 0.28, unit="词/秒", meta={"source": "demo", "rate": 2.4}),
        Event(47.0, 60.0, "prosody", "语速", 0.52, unit="词/秒", meta={"source": "demo", "rate": 3.6}),
    ])

    return tl, clock


def demo_statuses() -> list[dict]:
    return [
        {"name": "openface", "status": "skipped", "detail": "演示模式：使用合成数据"},
        {"name": "deepface", "status": "skipped", "detail": "演示模式：使用合成数据"},
        {"name": "whisper", "status": "skipped", "detail": "演示模式：使用合成数据"},
        {"name": "mediapipe", "status": "skipped", "detail": "演示模式：使用合成数据"},
    ]
