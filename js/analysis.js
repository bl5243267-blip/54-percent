/**
 * 信号提取 · 三套打分方案 · 事件检测
 *
 * 这里刻意保留一个不适感：三套方案读同一份数据，结论却不一样。
 * 页面初始只显示 A 的结果，点开按钮才看到全部——先让人相信，再拆掉。
 */

/* ------------------------------------------------------------------ */
/*  可测信号                                                            */
/* ------------------------------------------------------------------ */

export const SIGNALS = [
  { id: 'browDown', label: '眉下降', keys: ['browDownLeft', 'browDownRight'],
    alts: ['专注聆听', '光线刺眼', '疲劳', '近视未戴眼镜'] },
  { id: 'browUp', label: '眉上抬', keys: ['browInnerUp', 'browOuterUpLeft', 'browOuterUpRight'],
    alts: ['惊讶', '提问语气', '示意对方继续', '习惯性挑眉'] },
  { id: 'lipPress', label: '唇收紧', keys: ['mouthPressLeft', 'mouthPressRight'],
    alts: ['思考时的小动作', '口腔干燥', '习惯性抿嘴', '正在组织语言'] },
  { id: 'lipDown', label: '嘴角下压', keys: ['mouthFrownLeft', 'mouthFrownRight'],
    alts: ['基线表情本就下垂', '疲劳', '情绪低落（与真伪无关）'] },
  { id: 'lipUp', label: '嘴角上扬', keys: ['mouthSmileLeft', 'mouthSmileRight'],
    alts: ['礼貌性微笑', '社交习惯', '真的觉得好笑'] },
  { id: 'squint', label: '眼睑收紧', keys: ['eyeSquintLeft', 'eyeSquintRight'],
    alts: ['屏幕眩光', '近视眯眼', '专注', '阳光直射'] },
  { id: 'blink', label: '眨眼', keys: ['eyeBlinkLeft', 'eyeBlinkRight'],
    alts: ['干眼症', '隐形眼镜', '屏幕疲劳', '正常生理波动'] },
  { id: 'jaw', label: '张口', keys: ['jawOpen'],
    alts: ['正在说话', '呼吸', '打哈欠'] },
];

export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));

/** blendshape 名称 → 分数 的字典 → 各信号的归一化强度 */
export function readSignals(shapeMap) {
  const out = {};
  if (!shapeMap) {
    for (const s of SIGNALS) out[s.id] = 0;
    return out;
  }
  for (const s of SIGNALS) {
    let sum = 0;
    for (const k of s.keys) sum += shapeMap[k] || 0;
    out[s.id] = Math.min(1, sum / s.keys.length);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  三套方案                                                            */
/* ------------------------------------------------------------------ */

/**
 * 静息基线：把「刚坐下、什么也没发生」的状态定为 50%。
 * 三套方案都相对同一条基线偏移，差异只来自「偏离了什么」，
 * 否则不同权重尺度会让某些方案天生就落在 10% 或 90%。
 */
export const BASELINE = {
  browDown: 0.18, browUp: 0.15, lipPress: 0.16, lipDown: 0.14,
  lipUp: 0.20, squint: 0.18, blink: 0.12, jaw: 0.10,
};

export const SCHEMES = [
  {
    id: 'folk',
    name: '方案 A · 常见说法',
    premise: '压抑情绪会在脸上泄漏：皱眉、抿嘴、嘴角下压 = 在隐瞒。这是绝大多数「读脸」产品默认的假设。',
    weights: { browDown: 1.00, lipPress: 0.85, lipDown: 0.55, squint: 0.35, lipUp: -0.30, browUp: -0.10 },
    gain: 3.5,
  },
  {
    id: 'inverse',
    name: '方案 B · 同样合理',
    premise: '紧张的人会刻意控制表情：反而更用力维持微笑、更多挑眉示意，小动作更少。这条假设在文献里同样常见。',
    weights: { browDown: -0.55, lipPress: -0.40, lipDown: -0.45, squint: -0.30, lipUp: 0.90, browUp: 0.60 },
    gain: 3.5,
  },
  {
    id: 'blink',
    name: '方案 C · 只看眨眼',
    premise: '另一派认为面部肌肉可控，只有眨眼这种自主神经相关的动作才「可靠」。于是它用完全不同的输入。',
    weights: { blink: 1.20, squint: 0.30 },
    gain: 4.2,
  },
];

function weighted(scheme, values) {
  let raw = 0;
  for (const [k, w] of Object.entries(scheme.weights)) raw += (values[k] || 0) * w;
  return raw;
}

/** 单套方案打分，返回 0~100。基线状态恒为 50。 */
export function scoreScheme(signals, scheme) {
  const raw = weighted(scheme, signals);
  const base = weighted(scheme, BASELINE);
  const z = (raw - base) * scheme.gain;
  return 100 / (1 + Math.exp(-z));
}

export function scoreAll(signals) {
  const out = {};
  for (const s of SCHEMES) out[s.id] = scoreScheme(signals, s);
  return out;
}

export function verdictOf(score) {
  if (score >= 66) return '高度提示存在隐瞒';
  if (score >= 55) return '轻微提示存在隐瞒';
  if (score >= 45) return '无法判断';
  return '倾向于未隐瞒';
}

export function colorOf(score) {
  if (score >= 66) return '#f87171';
  if (score >= 55) return '#fbbf24';
  if (score >= 45) return '#8a93a6';
  return '#4ade80';
}

/* ------------------------------------------------------------------ */
/*  事件检测：把连续超阈值合并成一段                                     */
/* ------------------------------------------------------------------ */

const THRESHOLDS = {
  browDown: 0.42, browUp: 0.40, lipPress: 0.34, lipDown: 0.30,
  lipUp: 0.45, squint: 0.38, blink: 0.55, jaw: 0.45,
};

export class EventTracker {
  constructor(now = 0) {
    this.active = {};       // id → { since, peak }
    this.events = [];       // 已结束的事件
    this.minDur = 0.09;     // 短于此视为噪声
    this.now = now;
  }

  /** 每帧喂入信号，返回本次新结束的事件 */
  update(signals, t) {
    this.now = t;
    const finished = [];

    for (const s of SIGNALS) {
      const v = signals[s.id] || 0;
      const th = THRESHOLDS[s.id] || 0.4;
      const cur = this.active[s.id];

      if (v >= th) {
        if (!cur) {
          this.active[s.id] = { since: t, peak: v };
        } else {
          cur.peak = Math.max(cur.peak, v);
        }
      } else if (cur) {
        const dur = t - cur.since;
        delete this.active[s.id];
        if (dur >= this.minDur) {
          const ev = {
            id: s.id, label: s.label, t0: cur.since, t1: t,
            dur, peak: cur.peak, alts: s.alts,
            micro: dur <= 0.22,
          };
          this.events.push(ev);
          if (this.events.length > 400) this.events.shift();
          finished.push(ev);
        }
      }
    }
    return finished;
  }

  /** 最近 n 条（含进行中的） */
  recent(n = 8) {
    const out = this.events.slice(-n);
    for (const [id, cur] of Object.entries(this.active)) {
      out.push({
        id, label: SIGNAL_MAP[id].label, t0: cur.since, t1: this.now,
        dur: this.now - cur.since, peak: cur.peak, alts: SIGNAL_MAP[id].alts,
        micro: this.now - cur.since <= 0.22, live: true,
      });
    }
    return out.sort((a, b) => a.t0 - b.t0).slice(-n);
  }

  score0to1(id, value) {
    return Math.min(1, value / (THRESHOLDS[id] || 0.4));
  }
}

export function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
