"""
特征聚合 · 多方案打分 · 自我拆解

这一层是整个作品的核心论点：
同一份面部/语音测量，换一套同样"合理"的权重，结论可以完全翻转。

所以这里同时产出两个东西：
1. 一个看起来煞有介事的判定分数（演示用）
2. 拆解它自己的材料（同一份数据的另外三种算法、以及为什么它们都不成立）
"""

from __future__ import annotations

import math
import random

import numpy as np
from dataclasses import dataclass

from .timeline import Event, Timeline

NEG_EMOTIONS = {"sad", "angry", "fear", "disgust", "contempt"}

# 这些是持续状态而非瞬时动作，归一化方式不同
LONG_STATE = {"neg_emotion", "shoulder"}

# 特征定义：名称 → (中文标签, 匹配的事件名, 通道)
FEATURE_SPEC: dict[str, tuple[str, tuple[str, ...]]] = {
    "brow_down":       ("眉下降 AU04", ("AU04",)),
    "brow_raise":      ("眉上抬 AU01/AU02", ("AU01", "AU02")),
    "lip_press":       ("唇收紧 AU23", ("AU23",)),
    "lip_corner_down": ("嘴角下压 AU15", ("AU15",)),
    "lip_corner_up":   ("嘴角上扬 AU12", ("AU12",)),
    "blink":           ("眨眼 AU45", ("AU45",)),
    "head_shake":      ("摇头 / 歪头", ("摇头", "歪头")),
    "shoulder":        ("肩线倾斜", ("肩线倾斜",)),
    "neg_emotion":     ("负面情绪", tuple(NEG_EMOTIONS)),
    "micro":           ("微表情频次", ("__micro__",)),
    "pause":           ("语音停顿", ("停顿",)),
    "slow_speech":     ("语速偏慢", ("语速",)),
}


@dataclass
class Scheme:
    """一套判定方案。名字、权重、以及它自认为在测什么。"""
    sid: str
    name: str
    premise: str          # 这套方案背后的假设
    weights: dict[str, float]
    bias: float = 0.0


# 三套"看起来都很有道理"的方案
SCHEMES: list[Scheme] = [
    Scheme(
        sid="folk",
        name="方案 A · 常见说法",
        premise="压抑情绪会在脸上泄漏：皱眉、唇收紧、视线躲闪 = 在隐瞒",
        weights={
            "brow_down": 1.00, "lip_press": 0.80, "lip_corner_down": 0.60,
            "head_shake": 0.55, "micro": 0.70, "neg_emotion": 0.45,
            "blink": 0.30, "brow_raise": -0.10, "lip_corner_up": -0.20,
        },
    ),
    Scheme(
        sid="inverse",
        name="方案 B · 同样合理",
        premise="紧张的人会刻意控制表情：反而更少小动作、更用力维持微笑",
        weights={
            "brow_down": -0.60, "lip_press": -0.30, "lip_corner_down": -0.45,
            "head_shake": -0.55, "micro": -0.70, "neg_emotion": -0.20,
            "blink": -0.30, "brow_raise": 0.75, "lip_corner_up": 0.85,
        },
    ),
    Scheme(
        sid="prosody",
        name="方案 C · 只看声音",
        premise="面部可以控制，声音难控制：停顿与语速才是真信号",
        weights={"pause": 1.00, "slow_speech": 0.90, "micro": 0.20},
    ),
]


def _dur_by_feature(timeline: Timeline, duration: float) -> dict[str, float]:
    """把事件聚合成每个特征的"时间占比"，范围 0~1"""
    per: dict[str, float] = {k: 0.0 for k in FEATURE_SPEC}
    micro_total = 0.0

    for e in timeline:
        if e.channel in ("asr", "word"):
            continue
        for key, (_label, names) in FEATURE_SPEC.items():
            if key == "micro":
                continue
            hit = False
            if e.name in names:
                hit = True
            elif key == "neg_emotion" and e.channel == "emotion" and e.name in NEG_EMOTIONS:
                hit = True
            if hit:
                per[key] += e.duration
        if e.meta.get("micro"):
            micro_total += 1

    # 语速是标量（词/秒），不是持续时长——单独取均值，否则会被时长累加顶到 100%
    speeds = [e.value for e in timeline if e.name == "语速"]
    per["slow_speech"] = float(np.mean(speeds)) if speeds else 0.0

    denom = max(duration, 1.0)
    out: dict[str, float] = {}
    for key, val in per.items():
        if key == "micro":
            # 微表情用频次：每分钟次数 / 12 次封顶
            out[key] = min(1.0, (micro_total / denom * 60.0) / 12.0)
        elif key == "slow_speech":
            out[key] = min(1.0, val)
        elif key in LONG_STATE:
            # 长时间持续状态（情绪、坐姿）不能放大，否则 20% 的时长会被顶成 80%
            out[key] = min(1.0, val / denom)
        else:
            # 短事件（AU、眨眼、停顿）本身占比很低，放大 4 倍才可比
            out[key] = min(1.0, val / denom * 4.0)
    return out


def _score(features: dict[str, float], scheme: Scheme) -> tuple[float, list[dict]]:
    """返回 (0~100 的分数, 每个特征的贡献明细)"""
    contributions = []
    raw = scheme.bias
    for key, w in scheme.weights.items():
        f = features.get(key, 0.0)
        c = w * f
        raw += c
        label = FEATURE_SPEC.get(key, (key, ()))[0]
        contributions.append({
            "feature": key, "label": label,
            "value": round(f, 3), "weight": w, "contribution": round(c, 3),
        })
    contributions.sort(key=lambda x: -abs(x["contribution"]))

    score = 100.0 / (1.0 + math.exp(-raw * 1.6))
    return round(score, 1), contributions


def analyze(timeline: Timeline) -> dict:
    """跑完三套方案，返回可直接渲染的完整结果"""
    duration = max(timeline.clock.duration, 1.0)
    features = _dur_by_feature(timeline, duration)

    results = []
    for sch in SCHEMES:
        score, contrib = _score(features, sch)
        results.append({
            "scheme": {"sid": sch.sid, "name": sch.name, "premise": sch.premise},
            "score": score,
            "verdict": _verdict(score),
            "contributions": contrib[:6],
        })

    # 第四套：随机权重（固定种子，可复现），用来演示"调参自由"
    rng = random.Random(20260301)
    rnd_weights = {k: round(rng.uniform(-1, 1), 2) for k in FEATURE_SPEC}
    rnd_scheme = Scheme("random", "方案 D · 随机权重",
                        "没人规定该用哪些特征、该怎么加权", rnd_weights)
    rnd_score, rnd_contrib = _score(features, rnd_scheme)
    results.append({
        "scheme": {"sid": "random", "name": rnd_scheme.name, "premise": rnd_scheme.premise},
        "score": rnd_score,
        "verdict": _verdict(rnd_score),
        "contributions": rnd_contrib[:6],
    })

    scores = [r["score"] for r in results]
    return {
        "duration": round(duration, 2),
        "features": {k: round(v, 3) for k, v in features.items()},
        "feature_labels": {k: v[0] for k, v in FEATURE_SPEC.items()},
        "schemes": results,
        "spread": {
            "min": round(min(scores), 1),
            "max": round(max(scores), 1),
            "range": round(max(scores) - min(scores), 1),
        },
        "contexts": _contexts(timeline),
        "counts": timeline.channels(),
    }


def _verdict(score: float) -> str:
    if score >= 66:
        return "高度提示存在隐瞒"
    if score >= 55:
        return "轻微提示存在隐瞒"
    if score >= 45:
        return "无法判断"
    return "倾向于未隐瞒"


def _contexts(timeline: Timeline, window: float = 2.5) -> list[dict]:
    """按转写句子切分，取每句话前后的所有测量事件"""
    sents = [e for e in timeline if e.channel == "asr"]
    if not sents:
        return []

    out = []
    for s in sents[:40]:
        near = [e for e in timeline
                if e.channel not in ("asr", "word")
                and e.t1 >= s.t0 - window and e.t0 <= s.t1 + window]
        near.sort(key=lambda e: -e.value)
        out.append({
            "t0": round(s.t0, 2),
            "t1": round(s.t1, 2),
            "text": s.meta.get("text", ""),
            "events": [
                {
                    "name": e.name,
                    "label": e.meta.get("label") or e.name,
                    "t": round(e.t0, 2),
                    "value": round(e.value, 2),
                    "channel": e.channel,
                }
                for e in near[:6]
            ],
        })
    return out


# --------------------------------------------------------------------------
# 替代解释：每条线索都必须挂上这些，不允许只给一个答案
# --------------------------------------------------------------------------

ALTERNATIVES: dict[str, list[str]] = {
    "brow_down": ["专注聆听", "光线刺眼", "头痛或疲劳", "近视未戴眼镜", "文化习惯性皱眉"],
    "lip_press": ["思考时的小动作", "口腔干燥", "习惯性抿嘴", "正在组织语言"],
    "lip_corner_down": ["基线表情本身就下垂", "疲劳", "情绪低落（与真伪无关）"],
    "head_shake": ["强调语气", "否认对方的用词而非事实", "颈部不适", "习惯性动作"],
    "micro": ["情绪波动（愤怒/尴尬/惊讶都可能）", "被镜头注视的自我意识",
              "环境刺激", "肌肉抽动（抽动症）", "眨眼与眼球运动被误判"],
    "neg_emotion": ["话题本身令人不适", "对被怀疑这件事感到愤怒", "回忆带来痛苦"],
    "pause": ["在回忆细节", "语言组织（非母语者更明显）", "网络或录音延迟", "被打断"],
    "slow_speech": ["疲劳", "谨慎措辞", "方言/口音切换", "思考用词"],
    "shoulder": ["坐姿不舒适", "椅子高低不平", "长期体态习惯"],
    "blink": ["干眼症", "隐形眼镜", "屏幕眩光", "正常生理波动"],
    "gaze": ["思考时自然移开视线", "镜头位置不自然", "有人经过", "社交焦虑"],
}

GENERIC_ALTERNATIVES = [
    "紧张（被观察本身就会引发）",
    "文化差异（眼神接触、表情抑制的规范不同）",
    "疲劳、睡眠不足、咖啡因",
    "性格基线（本就不爱做表情）",
    "语言障碍或非母语表达",
    "第三方在场带来的压力",
    "知道自己正被行为分析——这会系统性改变表现",
]
