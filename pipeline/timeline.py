"""
统一时间轴与事件模型

多模态分析最容易崩的地方不是模型，是时间。
OpenFace 给帧号、Whisper 给音频秒数、MediaPipe 给毫秒——三套时钟混在一起，
报告里就会出现"皱眉的同时语气变紧"这种错位 1~2 秒的假阳性。

这里做两件事：
1. 用 ffprobe 读出视频流与音频流的真实起点，算出 audio_offset
2. 把所有分析结果归一到「视频起点 = 0」的同一根时间轴上
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from typing import Iterable, Sequence

import numpy as np


# --------------------------------------------------------------------------
# 事件
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class Event:
    """时间轴上的一个可观察事件。只记录测量，不携带解释。"""

    t0: float                 # 起点（秒，相对视频起点）
    t1: float                 # 终点
    channel: str              # au | emotion | asr | prosody | pose | gaze
    name: str                 # 例如 AU04、sad、word
    value: float = 1.0        # 归一化强度 0~1
    unit: str = ''
    meta: dict = field(default_factory=dict, compare=False)

    @property
    def duration(self) -> float:
        return max(0.0, self.t1 - self.t0)

    @property
    def mid(self) -> float:
        return (self.t0 + self.t1) / 2

    def to_dict(self) -> dict:
        return {
            "t0": round(self.t0, 3),
            "t1": round(self.t1, 3),
            "channel": self.channel,
            "name": self.name,
            "value": round(self.value, 4),
            "unit": self.unit,
            "meta": self.meta,
        }

    def __str__(self) -> str:
        return f"[{fmt_t(self.t0)}] {self.channel}/{self.name} {self.value:.2f}"


def fmt_t(seconds: float) -> str:
    """秒 → mm:ss.mmm"""
    m, s = divmod(max(0.0, seconds), 60)
    return f"{int(m):02d}:{s:06.3f}"


# --------------------------------------------------------------------------
# 媒体时钟：解决音视频起点不一致
# --------------------------------------------------------------------------

@dataclass
class MediaClock:
    video_start: float = 0.0
    audio_start: float = 0.0
    fps: float = 30.0
    duration: float = 0.0
    has_audio: bool = False

    @property
    def audio_offset(self) -> float:
        """音频时间轴相对视频时间轴的偏移（秒）"""
        return self.audio_start - self.video_start

    def frame_to_video(self, frame: int) -> float:
        return frame / self.fps if self.fps > 0 else 0.0

    def audio_to_video(self, t: float) -> float:
        return t + self.audio_offset

    def to_dict(self) -> dict:
        return {
            "video_start": round(self.video_start, 4),
            "audio_start": round(self.audio_start, 4),
            "audio_offset": round(self.audio_offset, 4),
            "fps": round(self.fps, 3),
            "duration": round(self.duration, 3),
            "has_audio": self.has_audio,
        }


def probe_media(path: str) -> MediaClock:
    """用 ffprobe 读流信息。失败时返回默认时钟，不让管线崩掉。"""
    clock = MediaClock()
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_streams", "-show_format", path],
            capture_output=True, text=True, timeout=30, check=True,
        ).stdout
        info = json.loads(out)
    except Exception:
        return clock

    for s in info.get("streams", []):
        if s.get("codec_type") == "video" and clock.fps == 30.0:
            rate = s.get("r_frame_rate", "30/1")
            try:
                num, _, den = rate.partition("/")
                clock.fps = float(num) / float(den or 1)
            except Exception:
                clock.fps = 30.0
            clock.video_start = float(s.get("start_time", 0) or 0)
            clock.duration = float(s.get("duration", 0) or 0)
        elif s.get("codec_type") == "audio":
            clock.audio_start = float(s.get("start_time", 0) or 0)
            clock.has_audio = True

    if not clock.duration:
        try:
            clock.duration = float(info.get("format", {}).get("duration", 0) or 0)
        except Exception:
            pass
    return clock


# --------------------------------------------------------------------------
# 时间轴
# --------------------------------------------------------------------------

class Timeline:
    """事件集合，支持按时间窗查询与重采样。"""

    def __init__(self, clock: MediaClock | None = None):
        self.clock = clock or MediaClock()
        self._events: list[Event] = []

    def add(self, events: Iterable[Event]) -> None:
        self._events.extend(events)
        self._events.sort(key=lambda e: (e.t0, e.name))

    def extend(self, other: "Timeline") -> None:
        self.add(other._events)

    def __len__(self) -> int:
        return len(self._events)

    def __iter__(self):
        return iter(self._events)

    @property
    def events(self) -> list[Event]:
        return self._events

    def channels(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for e in self._events:
            out[e.channel] = out.get(e.channel, 0) + 1
        return out

    def at(self, t: float, window: float = 0.0) -> list[Event]:
        """取 [t-window, t+window] 内的事件（按时间重叠判断）"""
        lo, hi = t - window, t + window
        return [e for e in self._events if e.t1 >= lo and e.t0 <= hi]

    def between(self, t0: float, t1: float) -> list[Event]:
        return [e for e in self._events if e.t1 >= t0 and e.t0 <= t1]

    def of(self, channel: str) -> list[Event]:
        return [e for e in self._events if e.channel == channel]

    def resample(self, channel: str, name: str, hz: float = 10.0) -> tuple[np.ndarray, np.ndarray]:
        """把某个通道的离散事件重采样成等间隔序列（取区间内最大值）"""
        dur = max(self.clock.duration, 1.0)
        n = max(1, int(dur * hz))
        grid = np.arange(n) / hz
        vals = np.zeros(n, dtype=np.float32)
        for e in self._events:
            if e.channel != channel or e.name != name:
                continue
            i0 = max(0, int(e.t0 * hz))
            i1 = min(n, int(np.ceil(e.t1 * hz)))
            if i1 > i0:
                np.maximum(vals[i0:i1], e.value, out=vals[i0:i1])
        return grid, vals


# --------------------------------------------------------------------------
# 工具：从序列里提取"事件区间"
# --------------------------------------------------------------------------

def runs_above(
    values: Sequence[float],
    fps: float,
    threshold: float,
    min_duration: float = 0.08,
    max_gap: int = 2,
) -> list[tuple[int, int, float]]:
    """
    在一维序列里找出超过阈值的连续区间，返回 [(i0, i1, peak_value)]。

    这是微表情事件检测的核心：微表情持续 1/25~1/5 秒，
    按帧率换算大约 2~6 帧，所以 min_duration 要压到 0.08 秒量级。
    """
    hits = np.asarray(values) >= threshold
    if not hits.any():
        return []

    # 先补上短暂的空洞，避免一个事件被拆成几段
    idx = np.flatnonzero(hits)
    if max_gap > 0 and len(idx) > 1:
        for a, b in zip(idx[:-1], idx[1:]):
            if 1 < b - a <= max_gap + 1:
                hits[a:b] = True
        idx = np.flatnonzero(hits)

    out: list[tuple[int, int, float]] = []
    start = idx[0]
    prev = idx[0]
    for i in idx[1:]:
        if i == prev + 1:
            prev = i
            continue
        out.append((start, prev))
        start = prev = i
    out.append((start, prev))

    result = []
    for i0, i1 in out:
        if (i1 - i0 + 1) / fps < min_duration:
            continue
        peak = float(np.max(np.asarray(values)[i0:i1 + 1]))
        result.append((int(i0), int(i1), peak))
    return result
