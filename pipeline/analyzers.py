"""
四个分析器：OpenFace / DeepFace / Whisper / MediaPipe

设计原则：
- 每个分析器独立可选，装不上就跳过，不让整条管线崩掉
- 全部输出 Event（统一时间轴），各自的时间基准在这里就地换算
- 这里只做测量，不做推断
"""

from __future__ import annotations

import csv
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .timeline import Event, MediaClock, runs_above


@dataclass
class Result:
    name: str
    events: list[Event] = field(default_factory=list)
    status: str = "ok"          # ok | skipped | error
    detail: str = ""

    def __bool__(self) -> bool:
        return self.status == "ok"


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# 常用 AU 的中文名（FACS 标准编号，仅用于报告可读性）
AU_NAMES = {
    "AU01": "内眉上抬", "AU02": "外眉上抬", "AU04": "眉下降",
    "AU05": "上眼睑上抬", "AU06": "面颊上抬", "AU07": "眼睑收紧",
    "AU09": "鼻皱", "AU10": "上唇上抬", "AU12": "嘴角上扬",
    "AU14": "酒窝", "AU15": "嘴角下压", "AU17": "下巴上抬",
    "AU20": "唇拉伸", "AU23": "唇收紧", "AU25": "唇分开",
    "AU26": "下巴下降", "AU45": "眨眼",
}


# --------------------------------------------------------------------------
# OpenFace：AU / 头部姿态 / 视线
# --------------------------------------------------------------------------

class OpenFace:
    name = "openface"
    CHANNEL = "face"

    def __init__(self, au_threshold: float = 1.2, pose_rate_threshold: float = 60.0):
        self.au_threshold = au_threshold
        self.pose_rate_threshold = pose_rate_threshold

    @staticmethod
    def find_binary() -> str | None:
        for cand in (os.environ.get("OPENFACE_BIN"), "FeatureExtraction",
                     "FeatureExtraction.exe", "./OpenFace/FeatureExtraction"):
            if not cand:
                continue
            hit = shutil.which(cand)
            if hit:
                return hit
            if Path(cand).is_file():
                return str(Path(cand).resolve())
        return None

    def run(self, video: str, clock: MediaClock) -> Result:
        binary = self.find_binary()
        if not binary:
            return Result(self.name, status="skipped",
                          detail="未找到 FeatureExtraction，请设置 OPENFACE_BIN 或把 OpenFace 加入 PATH")

        with tempfile.TemporaryDirectory() as tmp:
            try:
                subprocess.run(
                    [binary, "-f", video, "-out_dir", tmp,
                     "-aus", "-pose", "-gaze", "-2Dfp", "-nomask"],
                    capture_output=True, text=True, timeout=1800, check=False,
                )
            except Exception as exc:
                return Result(self.name, status="error", detail=f"OpenFace 执行失败：{exc}")

            csvs = list(Path(tmp).glob("*.csv"))
            if not csvs:
                return Result(self.name, status="error", detail="OpenFace 没有产出 CSV")

            try:
                return self._parse(csvs[0], clock)
            except Exception as exc:
                return Result(self.name, status="error", detail=f"解析失败：{exc}")

    def _parse(self, csv_path: Path, clock: MediaClock) -> Result:
        rows = []
        with csv_path.open("r", encoding="utf-8", errors="replace") as fh:
            for row in csv.DictReader(fh):
                try:
                    if int(float(row.get("success", 1))) == 0:
                        continue
                    rows.append(row)
                except (ValueError, TypeError):
                    continue

        if not rows:
            return Result(self.name, status="error", detail="OpenFace 结果为空（可能没检测到人脸）")

        fps = clock.fps or 30.0
        events: list[Event] = []

        au_cols = [c for c in rows[0] if c.startswith("AU") and c.endswith("_r")]
        for col in au_cols:
            series = []
            for r in rows:
                try:
                    series.append(float(r.get(col) or 0))
                except ValueError:
                    series.append(0.0)
            au = col.replace("AU", "").replace("_r", "")
            key = f"AU{au}"
            # OpenFace 强度是 0~5，归一化到 0~1
            norm = [min(1.0, v / 5.0) for v in series]
            for i0, i1, peak in runs_above(norm, fps, self.au_threshold / 5.0, min_duration=0.06):
                t0 = rows[i0].get("timestamp")
                t1 = rows[i1].get("timestamp")
                try:
                    start = float(t0) if t0 else i0 / fps
                    end = float(t1) if t1 else i1 / fps
                except ValueError:
                    start, end = i0 / fps, i1 / fps
                dur = end - start
                events.append(Event(
                    t0=start, t1=max(end, start + 1 / fps),
                    channel=self.CHANNEL, name=key, value=round(peak, 3),
                    meta={
                        "label": AU_NAMES.get(key, key),
                        "source": "openface",
                        "duration_ms": int(round(dur * 1000)),
                        # 微表情的判据：持续时间 < 200ms
                        "micro": dur <= 0.2,
                    },
                ))

        # 头部姿态角速度：转头事件
        for axis in ("pose_Rx", "pose_Ry", "pose_Rz"):
            if axis not in rows[0]:
                continue
            vals = []
            for r in rows:
                try:
                    vals.append(float(r.get(axis) or 0))
                except ValueError:
                    vals.append(0.0)
            arr = np.array(vals)
            rate = np.abs(np.diff(arr, prepend=arr[0])) * fps  # 度/秒
            for i0, i1, peak in runs_above(rate, fps, self.pose_rate_threshold, min_duration=0.1):
                name = {"pose_Rx": "点头", "pose_Ry": "摇头", "pose_Rz": "歪头"}[axis]
                events.append(Event(
                    t0=i0 / fps, t1=(i1 + 1) / fps,
                    channel="head", name=name, value=float(min(1.0, peak / 180)),
                    unit="deg/s", meta={"source": "openface", "peak_rate": round(float(peak), 1)},
                ))

        return Result(self.name, events=events,
                      detail=f"{len(rows)} 帧 / {len(events)} 个事件")


# --------------------------------------------------------------------------
# DeepFace：7 类离散情绪（注意：这套分类本身有争议，仅作参考通道）
# --------------------------------------------------------------------------

class DeepFaceEmotion:
    name = "deepface"
    CHANNEL = "emotion"

    def __init__(self, step: int = 5, min_confidence: float = 0.45):
        self.step = step
        self.min_confidence = min_confidence

    def run(self, video: str, clock: MediaClock) -> Result:
        try:
            import cv2
            from deepface import DeepFace
        except Exception as exc:
            return Result(self.name, status="skipped", detail=f"缺少依赖：{exc}")

        cap = cv2.VideoCapture(video)
        if not cap.isOpened():
            return Result(self.name, status="error", detail="视频打不开")

        fps = clock.fps or 30.0
        labels: list[tuple[float, str, float]] = []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % self.step == 0:
                t = idx / fps
                try:
                    res = DeepFace.analyze(
                        frame, actions=["emotion"], enforce_detection=False,
                        detector_backend="opencv", silent=True,
                    )
                    if isinstance(res, list):
                        res = res[0]
                    dom = res.get("dominant_emotion", "")
                    conf = float(res.get("emotion", {}).get(dom, 0)) / 100.0
                    if dom and conf >= self.min_confidence:
                        labels.append((t, dom, conf))
                except Exception:
                    pass
            idx += 1
        cap.release()

        if not labels:
            return Result(self.name, status="ok", events=[], detail="未识别到有效情绪")

        # 把连续同标签合并成区间
        events: list[Event] = []
        start_t, cur, peak = labels[0][0], labels[0][1], labels[0][2]
        prev_t = start_t
        for t, lab, conf in labels[1:]:
            if lab == cur and t - prev_t <= self.step / fps + 0.2:
                peak = max(peak, conf)
                prev_t = t
                continue
            events.append(Event(start_t, prev_t + self.step / fps, self.CHANNEL,
                                cur, round(peak, 3), meta={"source": "deepface"}))
            start_t, cur, peak, prev_t = t, lab, conf, t
        events.append(Event(start_t, prev_t + self.step / fps, self.CHANNEL,
                            cur, round(peak, 3), meta={"source": "deepface"}))

        return Result(self.name, events=events, detail=f"{len(labels)} 个采样点 / {len(events)} 段")


# --------------------------------------------------------------------------
# Whisper：语音转写（只有文本与时间戳，不含韵律）
# --------------------------------------------------------------------------

class WhisperASR:
    name = "whisper"
    CHANNEL = "asr"

    def __init__(self, model_size: str = "small", language: str | None = "zh"):
        self.model_size = model_size
        self.language = language

    def run(self, video: str, clock: MediaClock) -> Result:
        if not clock.has_audio:
            return Result(self.name, status="skipped", detail="视频没有音频轨道")

        backend = None
        try:
            from faster_whisper import WhisperModel  # noqa: F401
            backend = "faster"
        except Exception:
            try:
                import whisper  # noqa: F401
                backend = "openai"
            except Exception as exc:
                return Result(self.name, status="skipped",
                              detail=f"缺少 faster-whisper / whisper：{exc}")

        try:
            raw: list[dict] = []
            if backend == "faster":
                from faster_whisper import WhisperModel
                model = WhisperModel(self.model_size, device="cpu", compute_type="int8")
                segments, _info = model.transcribe(
                    video, language=self.language, word_timestamps=True, vad_filter=True
                )
                for seg in segments:
                    raw.append({
                        "t0": seg.start, "t1": seg.end, "text": (seg.text or "").strip(),
                        "words": [{"t0": w.start, "t1": w.end, "w": w.word}
                                  for w in (seg.words or [])],
                    })
            else:
                import whisper as _w
                model = _w.load_model(self.model_size)
                out = model.transcribe(video, language=self.language, word_timestamps=True)
                for seg in out.get("segments", []):
                    raw.append({
                        "t0": seg["start"], "t1": seg["end"], "text": (seg["text"] or "").strip(),
                        "words": [{"t0": w["start"], "t1": w["end"], "w": w["word"]}
                                  for w in seg.get("words", [])],
                    })
        except Exception as exc:
            return Result(self.name, status="error", detail=f"转写失败：{exc}")

        events: list[Event] = []
        for seg in raw:
            # 关键：音频秒数 → 视频秒数
            t0 = clock.audio_to_video(seg["t0"])
            t1 = clock.audio_to_video(seg["t1"])
            events.append(Event(t0, t1, self.CHANNEL, "sentence", 1.0,
                                meta={"text": seg["text"], "source": "whisper"}))
            for w in seg["words"]:
                events.append(Event(
                    clock.audio_to_video(w["t0"]), clock.audio_to_video(w["t1"]),
                    "word", "word", 1.0,
                    meta={"text": w["w"].strip(), "source": "whisper"},
                ))

        # 从词时间戳推算语速（词/秒），作为副语言的替代指标之一
        words = [e for e in events if e.channel == "word"]
        for i in range(0, max(0, len(words) - 5)):
            chunk = words[i:i + 6]
            span = chunk[-1].t1 - chunk[0].t0
            if span > 0.2:
                rate = len(chunk) / span
                events.append(Event(chunk[0].t0, chunk[-1].t1, "prosody", "语速",
                                    float(min(1.0, rate / 6.0)),
                                    unit="词/秒", meta={"rate": round(rate, 2), "source": "whisper"}))

        return Result(self.name, events=events, detail=f"{len(raw)} 句 / {len(words)} 词")


# --------------------------------------------------------------------------
# MediaPipe：姿态与手势
# --------------------------------------------------------------------------

class MediaPipePose:
    name = "mediapipe"
    CHANNEL = "pose"

    def __init__(self, step: int = 2):
        self.step = step

    def run(self, video: str, clock: MediaClock) -> Result:
        try:
            import cv2
            import mediapipe as mp
        except Exception as exc:
            return Result(self.name, status="skipped", detail=f"缺少依赖：{exc}")

        cap = cv2.VideoCapture(video)
        if not cap.isOpened():
            return Result(self.name, status="error", detail="视频打不开")

        fps = clock.fps or 30.0
        samples: list[tuple[float, float, float]] = []   # (t, 肩线倾角, 头肩水平偏移)
        idx = 0
        with mp.solutions.pose.Pose(model_complexity=1, min_detection_confidence=0.5) as pose:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if idx % self.step == 0:
                    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                    res = pose.process(rgb)
                    if res.pose_landmarks:
                        lm = res.pose_landmarks.landmark
                        ls, rs, nose = lm[11], lm[12], lm[0]
                        tilt = np.degrees(np.arctan2(rs.y - ls.y, max(abs(rs.x - ls.x), 1e-6)))
                        mid_x = (ls.x + rs.x) / 2
                        offset = nose.x - mid_x
                        samples.append((idx / fps, float(tilt), float(offset)))
                idx += 1
        cap.release()

        if len(samples) < 5:
            return Result(self.name, status="ok", events=[], detail="未检测到稳定人体姿态")

        events: list[Event] = []
        ts = np.array([s[0] for s in samples])
        tilts = np.array([s[1] for s in samples])
        offs = np.array([s[2] for s in samples])

        # 肩线倾斜持续超过阈值
        for i0, i1, peak in runs_above(np.abs(tilts), len(samples) / max(ts[-1], 1e-3),
                                       threshold=12.0, min_duration=0.5):
            events.append(Event(ts[i0], ts[min(i1, len(ts) - 1)], self.CHANNEL,
                                "肩线倾斜", float(min(1.0, peak / 30.0)), unit="deg",
                                meta={"source": "mediapipe", "peak": round(float(peak), 1)}))

        # 头部相对肩线的水平偏移（转头/躲避）
        for i0, i1, peak in runs_above(np.abs(offs), len(samples) / max(ts[-1], 1e-3),
                                       threshold=0.06, min_duration=0.4):
            events.append(Event(ts[i0], ts[min(i1, len(ts) - 1)], self.CHANNEL,
                                "头肩偏移", float(min(1.0, peak / 0.15)),
                                meta={"source": "mediapipe", "peak": round(float(peak), 3)}))

        return Result(self.name, events=events,
                      detail=f"{len(samples)} 个有效姿态样本 / {len(events)} 个事件")


ANALYZERS = [OpenFace(), DeepFaceEmotion(), WhisperASR(), MediaPipePose()]
