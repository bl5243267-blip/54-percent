import { FaceTracker } from './face.js';
import {
  SIGNALS, SIGNAL_MAP, SCHEMES, readSignals, scoreScheme, verdictOf, colorOf,
  EventTracker, fmtClock,
} from './analysis.js';
import { computeSummary, timelineSvg, reportHtml, download, SIG_COLORS } from './summary.js';

const $ = (id) => document.getElementById(id);
const DPR = () => Math.min(window.devicePixelRatio || 1, 2);

const video = $('cam');
const scan = $('scan');
const chart = $('chart');
const sctx = scan.getContext('2d');
const cctx = chart.getContext('2d');

const connEl = $('conn');
const connText = $('connText');
const phint = $('phint');
const valTable = $('valTable');
const evTable = $('evTable');
const evBody = evTable.querySelector('tbody');
const evEmpty = $('evEmpty');
const legendEl = $('legend');
const modal = $('modal');

const btnStart = $('btnStart');
const btnDemo = $('btnDemo');
const btnFile = $('btnFile');
const btnStop = $('btnStop');
const btnSummary = $('btnSummary');
const btnReset = $('btnReset');
const btnWhy = $('btnWhy');
const btnClose = $('btnClose');
const toastEl = $('toast');

const fileInput = $('fileInput');
const progressEl = $('progress');
const pbarFill = $('pbarFill');
const pbarText = $('pbarText');

const summaryEl = $('summary');
const sumClose = $('sumClose');
const sumReport = $('sumReport');
const sumPng = $('sumPng');
const sumCsv = $('sumCsv');

const WINDOW_SEC = 20;
const TRACE_SIGNALS = ['browDown', 'browUp', 'lipPress', 'lipUp', 'blink'];
const TRACE_COLORS = {
  browDown: '#f85149', browUp: '#58a6ff', lipPress: '#d29922',
  lipUp: '#3fb950', blink: '#bc8cff',
};

const state = {
  mode: 'idle',
  running: false,
  startAt: 0,
  hasFace: false,
  lastFaceFlag: null,
  smooth: 0,
  jitter: 0,
  fps: 0,
  frameCount: 0,
  fpsAt: 0,
  lo: Object.fromEntries(TRACE_SIGNALS.map((k) => [k, []])),
  times: [],
  // 总结用的累计量
  duration: 0,
  totalFrames: 0,
  faceFrames: 0,
  sumSig: {},
  samples: 0,
  source: '',
  fileName: '',
  lastSummary: null,
};

// 预览面板会把页面代理到 /static-html/<hash>/，那条代理不转发模型文件，
// 且浏览器发起的读取会被拦。这里提前告知，别让用户对着报错猜。
const inFrame = window.self !== window.top;

const tracker = new FaceTracker(video);
const events = new EventTracker();

/* ------------------------------------------------------------------ */
/*  骨架                                                                */
/* ------------------------------------------------------------------ */

valTable.innerHTML = SIGNALS.map((s) => `
  <tr data-id="${s.id}">
    <td><span class="dot" style="background:#30363d"></span>${s.label}</td>
    <td class="num" data-v>0.000</td>
    <td class="bar-cell"><div class="mini"><i style="width:0%"></i></div></td>
  </tr>`).join('');

$('schemes').innerHTML = SCHEMES.map((s) => `
  <div class="scheme" data-id="${s.id}">
    <div class="sn">${s.name.replace(/^方案\s*[A-C]\s*·\s*/, '')}</div>
    <div class="sv" data-v>--.-</div>
    <div class="sr"><i style="width:0%"></i></div>
  </div>`).join('');

legendEl.innerHTML = TRACE_SIGNALS.map((k) =>
  `<span><i style="background:${TRACE_COLORS[k]}"></i>${SIGNAL_MAP[k].label}</span>`).join('');

function setConn(kind, text) {
  connEl.className = 'conn' + (kind ? ' ' + kind : '');
  connText.textContent = text;
}

let toastTimer = 0;
function toast(msg, ms = 3600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ------------------------------------------------------------------ */
/*  采集控制                                                            */
/* ------------------------------------------------------------------ */

async function startCamera() {
  btnStart.disabled = true;
  btnDemo.disabled = true;
  btnFile.disabled = true;
  setConn('', '初始化…');

  try {
    await tracker.start((stage) => setConn('', stage));
    state.mode = 'camera';
    state.source = '摄像头实时采集';
    begin();
    const backend = (tracker.backend || '').split('· ')[1] || 'GPU';
    setConn('live', `${tracker.pointCount || 478} 点 · ${backend}`);
    toast('采集已开始 · 请让面部进入画面');
  } catch (err) {
    console.warn(err);
    btnStart.disabled = false;
    btnDemo.disabled = false;
    btnFile.disabled = false;
    setConn('err', '摄像头不可用');
    const hint = inFrame
      ? '　—　预览面板无法加载模型，请用浏览器打开 127.0.0.1:5174'
      : '　—　可点「演示数据」查看界面';
    toast((err?.message || '启动失败') + hint, 6000);
  }
}

function startDemo() {
  state.mode = 'demo';
  state.source = '演示数据 · 合成信号（非真实测量）';
  btnStart.disabled = true;
  btnDemo.disabled = true;
  btnFile.disabled = true;
  phint.textContent = '演示数据 · 无摄像头画面';
  phint.classList.remove('hide');
  seed();
  begin();
  setConn('demo', '演示数据 · 非真实测量');
}

/* ------------------------------------------------------------------ */
/*  分析视频文件                                                        */
/* ------------------------------------------------------------------ */

btnFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) startVideoFile(f);
});

function setProgress(ratio, text) {
  progressEl.hidden = false;
  pbarFill.style.width = Math.round(Math.min(1, Math.max(0, ratio)) * 100) + '%';
  pbarText.textContent = text;
}

/** 等视频元数据就绪：事件 + 轮询双保险，事件被漏掉时也能返回 */
function waitForMetadata(videoEl, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timer);
      videoEl.removeEventListener('loadedmetadata', onReady);
      videoEl.removeEventListener('durationchange', onReady);
      videoEl.removeEventListener('error', onError);
    };
    const onReady = () => {
      if (done) return;
      if (!(Number.isFinite(videoEl.duration) && videoEl.duration > 0)) return;
      done = true;
      cleanup();
      resolve(videoEl.duration);
    };
    const onError = () => {
      if (done) return;
      done = true;
      cleanup();
      const code = videoEl.error?.code;
      reject(new Error(`视频无法解码${code ? `（错误码 ${code}）` : ''}　换 mp4 / webm 试试`));
    };
    const poll = setInterval(() => {
      if (videoEl.readyState >= 1) onReady();
    }, 120);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error('视频加载超时，可能是编码不受支持'));
    }, timeoutMs);

    videoEl.addEventListener('loadedmetadata', onReady);
    videoEl.addEventListener('durationchange', onReady);
    videoEl.addEventListener('error', onError);
  });
}

async function startVideoFile(file) {
  const url = URL.createObjectURL(file);
  await runVideoSource(url, file.name);
}

/** 实际播放并逐帧测量的部分，与来源无关（本地文件 / 调试地址） */
async function runVideoSource(url, label) {
  clearData();
  state.mode = 'file';
  state.fileName = label;
  state.source = `视频文件 · ${label}`;

  btnStart.disabled = true;
  btnDemo.disabled = true;
  btnFile.disabled = true;
  btnStop.disabled = false;
  setConn('', '加载模型…');
  setProgress(0, '准备中');

  try {
    await tracker.loadModel((s) => setConn('', s));
    setConn('', '读取视频…');

    video.srcObject = null;
    video.loop = false;
    video.muted = true;
    video.playbackRate = 2;

    // 监听必须在赋 src 之前挂上，否则极快的本地文件可能直接漏掉事件
    const ready = waitForMetadata(video, 30000);
    video.src = url;
    await ready;

    if (!Number.isFinite(video.duration) || video.duration <= 0) {
      throw new Error('无法读取视频时长，可能是不支持的格式');
    }

    phint.classList.add('hide');
    state.fileUrl = url;
    setConn('', '分析中…');
    await video.play().catch(() => {});
    begin();
    toast(`正在分析 ${label} · ${video.duration.toFixed(1)} 秒 · 2 倍速`, 5000);
  } catch (err) {
    console.warn(err);
    progressEl.hidden = true;
    btnStart.disabled = false;
    btnDemo.disabled = false;
    btnFile.disabled = false;
    btnStop.disabled = true;
    setConn('err', '视频分析失败');
    toast(err?.message || '视频分析失败', 6000);
  }
}

function finishVideoFile() {
  state.running = false;
  cancelAnimationFrame(raf);
  video.pause();
  state.duration = video.duration || 0;
  progressEl.hidden = true;
  setConn('', '分析完成');
  btnStop.disabled = true;
  btnStart.disabled = false;
  btnDemo.disabled = false;
  btnFile.disabled = false;
  btnSummary.disabled = events.events.length === 0;
  toast(`分析完成 · ${events.events.length} 条事件`, 4500);
  openSummary();
}

function begin() {
  state.running = true;
  state.startAt = performance.now() / 1000;
  btnStop.disabled = false;
  btnReset.disabled = false;
  btnSummary.disabled = true;
  loop();
}

function stop() {
  state.running = false;
  cancelAnimationFrame(raf);
  if (state.mode === 'file') video.pause();

  // 采集时长：文件模式用视频时长，实时模式用真实经过时间
  state.duration = state.mode === 'file'
    ? (video.duration || 0)
    : performance.now() / 1000 - state.startAt;

  progressEl.hidden = true;
  btnStop.disabled = true;
  btnStart.disabled = false;
  btnDemo.disabled = false;
  btnFile.disabled = false;
  setConn('', '已停止');

  const enough = state.duration >= 3 && events.events.length >= 1;
  btnSummary.disabled = !enough;
  if (enough) toast('已停止 · 点「生成总结」查看完整统计', 4500);
  else if (events.events.length === 0) toast('没有采集到超过阈值的事件', 3600);
}

/** 只清数据，不改界面按钮状态 */
function clearData() {
  events.events.length = 0;
  events.active = {};
  evBody.innerHTML = '';
  evEmpty.classList.add('show');
  $('evMeta').textContent = '0 条';
  state.times.length = 0;
  for (const k of TRACE_SIGNALS) state.lo[k].length = 0;
  state.sumSig = {};
  state.samples = 0;
  state.totalFrames = 0;
  state.faceFrames = 0;
  state.duration = 0;
  state.smooth = 0;
  state.lastSummary = null;
  $('idxValue').textContent = '--.-';
  $('idxValue').style.color = 'var(--dim)';
  $('idxVerdict').textContent = '未采集';
  $('sumTimeline').innerHTML = '';
  for (const s of SIGNALS) {
    const row = valTable.querySelector(`tr[data-id="${s.id}"]`);
    if (!row) continue;
    row.querySelector('[data-v]').textContent = '0.000';
    row.querySelector('.mini i').style.width = '0%';
  }
}

function reset() {
  clearData();
  if (state.mode === 'file') {
    video.pause();
    video.removeAttribute('src');
    video.load();
    state.mode = 'idle';
    phint.textContent = '摄像头未开启';
    phint.classList.remove('hide');
    setConn('', '未连接');
  }
  btnSummary.disabled = true;
  toast('已清空采集数据');
}

btnStart.addEventListener('click', startCamera);
btnDemo.addEventListener('click', startDemo);
btnStop.addEventListener('click', stop);
btnReset.addEventListener('click', reset);
btnSummary.addEventListener('click', openSummary);

/* 演示数据预置几条历史 */
function seed() {
  const seeds = [['browDown', 0.4, 0.62, 0.18], ['lipPress', 1.7, 0.41, 0.12],
    ['blink', 3.2, 0.78, 0.10], ['browUp', 5.1, 0.44, 0.15]];
  for (const [id, t0, peak, dur] of seeds) {
    events.events.push({
      id, label: SIGNAL_MAP[id].label, t0, t1: t0 + dur, dur, peak,
      alts: SIGNAL_MAP[id].alts, micro: dur <= 0.22,
    });
  }
  for (const ev of events.events) pushEventRow(ev);
}

/* 开发用：伪造一段长会话，便于在无头浏览器里检查总结面板（?fake=60） */
function demoFakeSession(dur) {
  clearData();
  state.mode = 'demo';
  state.source = '演示数据 · 合成信号（非真实测量）';
  state.duration = dur;
  state.totalFrames = Math.round(dur * 30);
  state.faceFrames = Math.round(state.totalFrames * 0.94);
  state.samples = state.totalFrames;

  const kinds = ['browDown', 'lipPress', 'blink', 'browUp', 'lipUp', 'squint', 'lipDown', 'jaw'];
  let t = 0.6;
  let guard = 0;
  while (t < dur - 1 && guard++ < 400) {
    const id = kinds[Math.floor(Math.random() * kinds.length)];
    const d = 0.08 + Math.random() * 0.34;
    const peak = 0.36 + Math.random() * 0.42;
    events.events.push({
      id, label: SIGNAL_MAP[id].label, t0: t, t1: t + d, dur: d, peak,
      alts: SIGNAL_MAP[id].alts, micro: d <= 0.22,
    });
    t += 0.5 + Math.random() * 2.4;
  }

  // 每帧均值的近似：基线 + 一小段累积
  for (const k of Object.keys(SIGNAL_MAP)) {
    state.sumSig[k] = (0.14 + Math.random() * 0.06) * state.samples;
  }
  for (const ev of events.events) state.sumSig[ev.id] += ev.peak * ev.dur * 30 * 0.25;

  openSummary();
}

/* ------------------------------------------------------------------ */
/*  演示信号                                                            */
/* ------------------------------------------------------------------ */

function demoShapes(t) {
  const pulse = (period, phase, width) => {
    const x = ((t / period + phase) % 1 + 1) % 1;
    return x < width ? Math.sin((Math.PI * x) / width) : 0;
  };
  const w = (amp, f, p) => amp * (0.5 + 0.5 * Math.sin(t * f + p));
  return {
    browDownLeft: 0.10 + w(0.10, 0.71, 0) + 0.52 * pulse(3.7, 0, 0.10),
    browDownRight: 0.09 + w(0.10, 0.67, 1.1) + 0.48 * pulse(3.7, 0, 0.10),
    browInnerUp: 0.08 + w(0.08, 1.31, 2) + 0.40 * pulse(5.3, 0.42, 0.07),
    browOuterUpLeft: 0.06 + w(0.08, 1.11, 0.4) + 0.34 * pulse(5.3, 0.42, 0.07),
    browOuterUpRight: 0.06 + w(0.08, 1.05, 0.9) + 0.32 * pulse(5.3, 0.42, 0.07),
    mouthPressLeft: 0.12 + w(0.08, 0.67, 1.7) + 0.46 * pulse(4.9, 0.30, 0.09),
    mouthPressRight: 0.11 + w(0.08, 0.71, 0.3) + 0.44 * pulse(4.9, 0.30, 0.09),
    mouthFrownLeft: 0.07 + w(0.06, 0.53, 2.4) + 0.32 * pulse(6.1, 0.66, 0.08),
    mouthFrownRight: 0.07 + w(0.06, 0.49, 1.2) + 0.30 * pulse(6.1, 0.66, 0.08),
    mouthSmileLeft: 0.14 + w(0.10, 0.61, 3.1) + 0.46 * pulse(4.1, 0.78, 0.12),
    mouthSmileRight: 0.13 + w(0.10, 0.58, 2.2) + 0.44 * pulse(4.1, 0.78, 0.12),
    eyeSquintLeft: 0.12 + w(0.08, 0.91, 0.9) + 0.34 * pulse(5.7, 0.18, 0.09),
    eyeSquintRight: 0.11 + w(0.08, 0.87, 1.8) + 0.32 * pulse(5.7, 0.18, 0.09),
    eyeBlinkLeft: 0.06 + w(0.05, 2.1, 0.4) + 0.78 * pulse(3.3, 0.55, 0.035),
    eyeBlinkRight: 0.06 + w(0.05, 2.05, 1.5) + 0.76 * pulse(3.3, 0.55, 0.035),
    jawOpen: 0.05 + w(0.06, 0.37, 0.2) + 0.22 * pulse(2.9, 0.10, 0.22),
  };
}

/* ------------------------------------------------------------------ */
/*  主循环                                                              */
/* ------------------------------------------------------------------ */

let raf = 0;
let last = 0;
let frameCount = 0;
let fpsAt = 0;

function loop() {
  if (!state.running) return;
  raf = requestAnimationFrame(loop);

  const now = performance.now() / 1000;
  // 文件模式必须用视频时间轴：2 倍速播放时墙钟和视频时间对不上，
  // 事件时长、时间轴刻度会整体错位一半。
  const t = state.mode === 'file' ? video.currentTime : now - state.startAt;
  const dt = Math.min(0.1, now - (last || now));
  last = now;

  state.totalFrames++;
  frameCount++;
  if (now - fpsAt > 0.5) {
    state.fps = Math.round(frameCount / (now - fpsAt));
    frameCount = 0;
    fpsAt = now;
    $('previewMeta').textContent = `${state.hasFace ? '已锁定' : '未检测'} · ${state.fps} fps`;
  }

  if (state.mode === 'camera') {
    const ok = tracker.detect(performance.now());
    state.hasFace = ok;
    if (ok) state.faceFrames++;
    if (ok !== state.lastFaceFlag) {
      state.lastFaceFlag = ok;
      phint.textContent = ok ? '' : '未检测到面部';
      phint.classList.toggle('hide', ok);
    }
  } else if (state.mode === 'file') {
    const ok = tracker.detect(performance.now());
    state.hasFace = ok;
    if (ok) state.faceFrames++;

    const total = video.duration || 1;
    setProgress(t / total, `分析中 ${Math.round((t / total) * 100)}% · ${fmtClock(t)} / ${fmtClock(total)}`);

    if (video.ended || t >= total - 0.05) {
      finishVideoFile();
      return;
    }
  } else {
    // 演示模式：保留「演示数据」提示，不要清掉
    state.hasFace = true;
    state.faceFrames++;   // 合成信号视为全程「检出」
  }

  const shapes = state.mode === 'demo' ? demoShapes(t) : (state.hasFace ? tracker.shapeMap() : null);
  const signals = shapes ? readSignals(shapes) : null;

  if (signals) {
    state.samples++;
    for (const k of Object.keys(signals)) {
      state.sumSig[k] = (state.sumSig[k] || 0) + signals[k];
    }

    for (const ev of events.update(signals, t)) pushEventRow(ev);
    pushHistory(t, signals);

    state.jitter += dt * 6.1;
    const scores = {};
    for (const s of SCHEMES) scores[s.id] = scoreScheme(signals, s);
    const target = scores.folk + Math.sin(state.jitter) * 0.3;
    state.smooth = state.smooth ? state.smooth + (target - state.smooth) * 0.2 : target;

    updateIndex(state.smooth);
    updateValues(signals);
    updateSchemes(scores);
  } else {
    state.smooth = 0;
    $('idxValue').textContent = '--.-';
    $('idxValue').style.color = 'var(--dim)';
    $('idxVerdict').textContent = '未检测到面部';
  }

  drawScan();
  drawChart();
}

/* ------------------------------------------------------------------ */
/*  历史与绘制                                                          */
/* ------------------------------------------------------------------ */

function pushHistory(t, sig) {
  state.times.push(t);
  for (const k of TRACE_SIGNALS) state.lo[k].push(sig[k] || 0);
  const cut = t - WINDOW_SEC - 1;
  while (state.times.length && state.times[0] < cut) {
    state.times.shift();
    for (const k of TRACE_SIGNALS) state.lo[k].shift();
  }
}

function fitCanvas(el, ctx) {
  const r = el.getBoundingClientRect();
  const d = DPR();
  if (el.width !== Math.round(r.width * d) || el.height !== Math.round(r.height * d)) {
    el.width = Math.round(r.width * d);
    el.height = Math.round(r.height * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
  }
  return { w: r.width, h: r.height };
}

function drawChart() {
  const { w, h } = fitCanvas(chart, cctx);
  cctx.clearRect(0, 0, w, h);

  const padL = 34, padR = 12, padT = 28, padB = 20;
  const gw = w - padL - padR;
  const gh = h - padT - padB;
  if (gw <= 0 || gh <= 0) return;

  cctx.font = '10px ui-monospace, monospace';
  cctx.strokeStyle = 'rgba(48,54,61,0.6)';
  cctx.lineWidth = 1;
  cctx.fillStyle = '#6e7681';

  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (gh * i) / 4) + 0.5;
    cctx.beginPath(); cctx.moveTo(padL, y); cctx.lineTo(padL + gw, y); cctx.stroke();
    cctx.fillText((1 - i / 4).toFixed(2), 5, y + 3);
  }
  for (let i = 0; i <= 4; i++) {
    const x = Math.round(padL + (gw * i) / 4) + 0.5;
    cctx.beginPath(); cctx.moveTo(x, padT); cctx.lineTo(x, padT + gh); cctx.stroke();
    if (i > 0 && i < 4) cctx.fillText(`-${(WINDOW_SEC * (1 - i / 4)).toFixed(0)}s`, x - 12, padT + gh + 13);
  }
  cctx.fillText('0s', padL + gw - 12, padT + gh + 13);

  if (state.times.length < 2) return;

  const now = state.times[state.times.length - 1];
  const t0 = now - WINDOW_SEC;
  const xOf = (t) => padL + ((t - t0) / WINDOW_SEC) * gw;
  const yOf = (v) => padT + gh - Math.min(1, Math.max(0, v)) * gh;

  for (const k of TRACE_SIGNALS) {
    const arr = state.lo[k];
    if (!arr.length) continue;
    cctx.beginPath();
    let started = false;
    for (let i = 0; i < arr.length; i++) {
      if (state.times[i] < t0) continue;
      const x = xOf(state.times[i]);
      const y = yOf(arr[i]);
      if (!started) { cctx.moveTo(x, y); started = true; } else cctx.lineTo(x, y);
    }
    cctx.strokeStyle = TRACE_COLORS[k];
    cctx.lineWidth = 1.4;
    cctx.lineJoin = 'round';
    cctx.stroke();
  }
}

function drawScan() {
  const { w, h } = fitCanvas(scan, sctx);
  sctx.clearRect(0, 0, w, h);

  if (!(state.mode === 'camera' || state.mode === 'file') || !state.hasFace || !tracker.landmarks) return;

  const lm = tracker.landmarks;
  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;

  const scale = Math.max(w / vw, h / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (w - dw) / 2, oy = (h - dh) / 2;
  const px = (p) => [ox + (1 - p.x) * dw, oy + p.y * dh];

  const tess = tracker.tesselation;
  if (tess && tess.length) {
    sctx.strokeStyle = 'rgba(88,166,255,0.14)';
    sctx.lineWidth = 0.5;
    sctx.beginPath();
    for (const c of tess) {
      const a = lm[c.start], b = lm[c.end];
      if (!a || !b) continue;
      const [ax, ay] = px(a), [bx, by] = px(b);
      sctx.moveTo(ax, ay); sctx.lineTo(bx, by);
    }
    sctx.stroke();
  }

  const links = tracker.connections;
  if (links) {
    sctx.strokeStyle = 'rgba(88,166,255,0.42)';
    sctx.lineWidth = 0.9;
    sctx.beginPath();
    for (const group of Object.values(links)) {
      for (const c of group) {
        const a = lm[c.start], b = lm[c.end];
        if (!a || !b) continue;
        const [ax, ay] = px(a), [bx, by] = px(b);
        sctx.moveTo(ax, ay); sctx.lineTo(bx, by);
      }
    }
    sctx.stroke();
  }

  sctx.fillStyle = 'rgba(88,166,255,0.85)';
  for (let i = 0; i < lm.length; i++) {
    const [x, y] = px(lm[i]);
    sctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }
}

/* ------------------------------------------------------------------ */
/*  面板更新                                                            */
/* ------------------------------------------------------------------ */

function updateIndex(v) {
  const el = $('idxValue');
  el.textContent = v.toFixed(1);
  el.style.color = colorOf(v);
  $('idxVerdict').textContent = verdictOf(v);
}

function updateValues(sig) {
  let active = 0;
  for (const s of SIGNALS) {
    const row = valTable.querySelector(`tr[data-id="${s.id}"]`);
    if (!row) continue;
    const v = sig[s.id] || 0;
    const on = v > 0.35;
    if (on) active++;
    row.querySelector('[data-v]').textContent = v.toFixed(3);
    const bar = row.querySelector('.mini i');
    bar.style.width = Math.min(100, v * 100) + '%';
    bar.style.background = on ? '#58a6ff' : '#3d4a5c';
    row.querySelector('.dot').style.background = on ? '#58a6ff' : '#30363d';
  }
  $('valMeta').textContent = `${active} / ${SIGNALS.length} 活跃`;
}

function updateSchemes(scores) {
  for (const s of SCHEMES) {
    const card = document.querySelector(`.scheme[data-id="${s.id}"]`);
    if (!card) continue;
    const v = scores[s.id];
    const c = colorOf(v);
    const val = card.querySelector('[data-v]');
    val.textContent = v.toFixed(1);
    val.style.color = c;
    const bar = card.querySelector('.sr i');
    bar.style.width = v + '%';
    bar.style.background = c;
  }
}

function pushEventRow(ev) {
  evEmpty.classList.remove('show');
  const tr = document.createElement('tr');
  tr.innerHTML =
    `<td class="num" style="text-align:left">${fmtClock(ev.t1)}</td>` +
    `<td>${ev.label}${ev.micro ? ' <span style="color:#6e7681;font-size:9.5px">MICRO</span>' : ''}</td>` +
    `<td class="num">${ev.peak.toFixed(2)}</td>` +
    `<td class="num">${Math.round(ev.dur * 1000)}</td>`;
  evBody.prepend(tr);
  while (evBody.children.length > 200) evBody.lastChild.remove();
  $('evMeta').textContent = `${events.events.length} 条`;
}

/* ------------------------------------------------------------------ */
/*  导出                                                                */
/* ------------------------------------------------------------------ */

function exportCsv() {
  const list = events.events;
  const rows = [['time_s', 'event', 'value', 'duration_ms', 'micro', 'alternatives']];
  for (const ev of list) {
    rows.push([
      ev.t0.toFixed(3), ev.label, ev.peak.toFixed(3),
      Math.round(ev.dur * 1000), ev.micro ? 1 : 0, ev.alts.join(' / '),
    ]);
  }
  const csv = rows
    .map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${c}"` : c)).join(','))
    .join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `facial-events-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${list.length} 条事件`);
}

/* ------------------------------------------------------------------ */
/*  会话总结                                                            */
/* ------------------------------------------------------------------ */

function avgSignalsNow() {
  const out = {};
  for (const k of Object.keys(SIGNAL_MAP)) {
    out[k] = state.samples > 0 ? (state.sumSig[k] || 0) / state.samples : NaN;
  }
  return out;
}

function currentDuration() {
  if (state.duration) return state.duration;
  if (state.mode === 'file') return video.duration || 0;
  if (state.startAt) return performance.now() / 1000 - state.startAt;
  return 0;
}

function openSummary() {
  const summary = computeSummary({
    events: events.events,
    duration: currentDuration(),
    totalFrames: state.totalFrames,
    faceFrames: state.faceFrames,
    avgSignals: avgSignalsNow(),
    source: state.source || '未标注来源',
  });
  state.lastSummary = summary;

  const kpi = (label, value, note = '') => `
    <div class="sum-kpi"><div class="kl">${label}</div>
      <div class="kv">${value}</div>${note ? `<div class="kn">${note}</div>` : ''}</div>`;

  $('sumScope').textContent =
    `${summary.source} ｜ 时长 ${fmtClock(summary.duration)} ｜ 人脸检出率 ${(summary.faceRate * 100).toFixed(1)}%`;

  $('sumKpis').innerHTML = [
    kpi('采集时长', fmtClock(summary.duration)),
    kpi('人脸检出率', (summary.faceRate * 100).toFixed(1) + '%', `${summary.faceFrames} / ${summary.totalFrames} 帧`),
    kpi('事件总数', String(summary.total)),
    kpi('微表情事件', String(summary.microCount), `占 ${(summary.microShare * 100).toFixed(0)}%`),
    kpi('事件频率', (summary.total / Math.max(summary.duration / 60, 0.01)).toFixed(1), '次 / 分钟'),
    kpi('口径跨度', summary.total === 0 ? '—' : summary.spread.delta.toFixed(1) + ' 点',
      summary.total === 0 ? '无有效数据' : `${summary.spread.min.toFixed(1)} → ${summary.spread.max.toFixed(1)}`),
  ].join('');

  $('sumTimeline').innerHTML = timelineSvg(summary, { w: 860, padLeft: 92 });

  const rows = summary.perSignal.filter((p) => p.count > 0);
  $('sumStats').querySelector('tbody').innerHTML = rows.length
    ? rows.map((p) => `
      <tr>
        <td><span class="swatch" style="background:${SIG_COLORS[p.id] || '#8b949e'}"></span>${p.label}</td>
        <td class="num">${p.count}</td>
        <td class="num">${p.rate.toFixed(1)}</td>
        <td class="num">${p.avgPeak.toFixed(2)}</td>
        <td class="num">${Math.round(p.avgDur * 1000)}</td>
        <td class="num">${p.micro}</td>
        <td class="share"><i style="width:${(p.share * 100).toFixed(1)}%;background:${SIG_COLORS[p.id] || '#8b949e'}"></i></td>
      </tr>`).join('')
    : '<tr><td colspan="7" style="color:var(--faint);text-align:center;padding:16px">没有超过阈值的事件</td></tr>';

  // 没有事件时不能摆出六格 50.0%——那会被读成「真实测量结果是无法判断」，
  // 而实际是「没有数据」。这两种情况必须区分开。
  if (summary.total === 0) {
    $('sumCells').innerHTML = `
      <div class="sum-empty">
        <b>数据不足，无法给出任何读数</b>
        <span>这段材料里没有检测到超过阈值的行为事件${summary.faceRate === 0 ? '，且全程未检出人脸' : ''}。
        六种口径在这种情况下都只能落在基线 50%，那是「没有输入」的结果，不是「无法判断」的测量结论。</span>
      </div>`;
    $('sumSpread').innerHTML =
      '建议：换一段有人脸、时长 ≥ 10 秒的视频；或直接用摄像头采集，确认预览面板里能画出面部网格。';
  } else {
    const lo = Math.min(...summary.cells.map((c) => c.score));
    const hi = Math.max(...summary.cells.map((c) => c.score));
    $('sumCells').innerHTML = summary.cells.map((c) => {
      const isMax = c.score === hi;
      const isMin = c.score === lo;
      return `
      <div class="sum-cell${isMax ? ' is-max' : ''}${isMin ? ' is-min' : ''}">
        <div class="ch">${c.schemeName}<span>${c.lens}</span></div>
        <div class="cs" style="color:${c.color}">${c.score.toFixed(1)}%</div>
        <div class="cv">${c.verdict}</div>
        <div class="cb"><i style="width:${c.score.toFixed(1)}%;background:${c.color}"></i></div>
        ${isMax ? `<span class="tag" style="color:${c.color}">最高</span>` : ''}
        ${isMin && !isMax ? `<span class="tag" style="color:${c.color}">最低</span>` : ''}
      </div>`;
    }).join('');

    $('sumSpread').innerHTML =
      `最低 <b>${summary.spread.min.toFixed(1)}%</b>（${summary.spread.minLabel}）　`
      + `最高 <b>${summary.spread.max.toFixed(1)}%</b>（${summary.spread.maxLabel}）　`
      + `跨度 <b>${summary.spread.delta.toFixed(1)}</b> 点，出现 ${summary.spread.verdicts.length} 种互斥判定：`
      + `${summary.spread.verdicts.join(' / ')}<br>`
      + '六格读的是<b>完全相同</b>的事件序列，差别只在于用哪套假设加权、取全程平均还是动作峰值。';
  }

  $('sumAlts').innerHTML = summary.dominant.length
    ? summary.dominant.map((p) =>
      `<li><b>${p.label}</b>（${p.count} 次）—— 还可能是：${p.alts.join('、')}</li>`).join('')
    : '<li>没有足够的事件可用于列举替代解释。</li>';

  summaryEl.classList.add('open');
}

sumClose.addEventListener('click', () => summaryEl.classList.remove('open'));
summaryEl.addEventListener('click', (e) => { if (e.target === summaryEl) summaryEl.classList.remove('open'); });

sumCsv.addEventListener('click', exportCsv);

sumReport.addEventListener('click', () => {
  if (!state.lastSummary) return;
  const name = `facial-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.html`;
  download(name, reportHtml(state.lastSummary));
  toast('报告已保存 · 双击即可打开，可直接打印');
});

sumPng.addEventListener('click', async () => {
  if (!state.lastSummary) return;
  const W = 1200;
  const svg = timelineSvg(state.lastSummary, { w: W, padLeft: 120 });
  const m = svg.match(/height="(\d+(?:\.\d+)?)"/);
  const H = m ? Number(m[1]) : 300;
  const abs = svg.replace('width="100%"', `width="${W}"`).replace('<svg ', `<svg width="${W}" height="${H}" `);

  try {
    const blob = new Blob([abs], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('时间轴渲染失败')); img.src = url; });

    const scale = 2;
    const cv = document.createElement('canvas');
    cv.width = W * scale;
    cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#10151b';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, W, H);
    URL.revokeObjectURL(url);

    cv.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b);
      a.download = `facial-timeline-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast('时间轴已保存为 PNG');
    }, 'image/png');
  } catch (err) {
    toast(err?.message || 'PNG 导出失败', 4000);
  }
});

/* ------------------------------------------------------------------ */
/*  依据弹层                                                            */
/* ------------------------------------------------------------------ */

function buildModal() {
  const snap = {};
  for (const k of Object.keys(SIGNAL_MAP)) snap[k] = 0.10;
  for (const ev of events.recent(8)) snap[ev.id] = Math.max(snap[ev.id] || 0, ev.peak);

  $('mCards').innerHTML = SCHEMES.map((s) => {
    const v = scoreScheme(snap, s);
    const c = colorOf(v);
    return `<div class="mcard">
      <div class="top"><span class="nm">${s.name}</span>
        <span class="sc" style="color:${c}">${v.toFixed(1)}%</span></div>
      <p class="pm">${s.premise}</p>
      <div class="tr"><i style="width:${v}%;background:${c}"></i></div>
    </div>`;
  }).join('');

  const recent = events.recent(6).reverse();
  $('mEvents').innerHTML = recent.length
    ? recent.map((ev) => `
      <div class="mev">
        <span class="t">${fmtClock(ev.t0)}</span>
        <div>
          <div class="w">${ev.label}　强度 ${ev.peak.toFixed(2)}　${Math.round(ev.dur * 1000)}ms${ev.micro ? '　· 微表情' : ''}</div>
          <p class="a">还可能是：${ev.alts.join('、')}</p>
        </div>
      </div>`).join('')
    : '<p style="color:#6e7681;font-size:12px;margin:0">还没有采集到事件。</p>';
}

btnWhy.addEventListener('click', () => { buildModal(); modal.classList.add('open'); });
btnClose.addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.remove('open'); });

/* ------------------------------------------------------------------ */

const DEV = new URLSearchParams(location.search);
if (DEV.has('still')) {
  const st = document.createElement('style');
  st.textContent = '*,*::before,*::after{transition:none!important;animation:none!important}';
  document.head.appendChild(st);
}
if (DEV.has('demo')) {
  startDemo();
  if (DEV.has('explain')) setTimeout(() => { buildModal(); modal.classList.add('open'); }, 800);
}
// 开发用：?fake=60 伪造一段 60 秒会话并直接打开总结面板（无头截图验证用）
if (DEV.has('fake')) {
  if (state.running) stop();
  demoFakeSession(Number(DEV.get('fake')) || 60);
}
// 开发用：?vidurl=<地址> 直接分析该视频（自检离线分析链路）
if (DEV.get('vidurl')) {
  runVideoSource(DEV.get('vidurl'), DEV.get('vidurl').split('/').pop());
}

window.addEventListener('resize', () => { drawChart(); drawScan(); });
window.addEventListener('beforeunload', () => { cancelAnimationFrame(raf); tracker.stop(); });

if (!navigator.mediaDevices?.getUserMedia) {
  phint.textContent = '浏览器不支持摄像头 · 可用演示数据';
}

if (inFrame) {
  phint.innerHTML = '预览面板无法加载模型与摄像头<br>'
    + '<span style="color:#58a6ff">请在浏览器中打开 127.0.0.1:5174</span>';
  phint.classList.remove('hide');
  setConn('', '预览面板受限');
}
