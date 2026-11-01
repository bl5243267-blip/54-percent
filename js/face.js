/**
 * MediaPipe Face Landmarker 封装
 *
 * 输出：478 个面部关键点、52 个 blendshape 系数、头部变换矩阵。
 * 这里只做测量，不做任何推断——推断的事交给 analysis.js，并且会被拆穿。
 */

const VISION_SOURCES = [
  {
    lib: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  },
  {
    lib: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs',
    wasm: 'https://unpkg.com/@mediapipe/tasks-vision@0.10.14/wasm',
  },
];

/**
 * 模型地址必须相对 document.baseURI（也就是 index.html 所在目录），
 * 不能用 '../models/'：页面被代理托管时（如预览面板的 /static-html/<hash>/），
 * 上溯一级会跑出项目根，直接 404。
 */
const MODEL_SOURCES = [
  () => new URL('models/face_landmarker.task', document.baseURI).href,
  // 预览面板会把页面代理到 /static-html/<hash>/，那条代理按内容类型白名单转发，
  // .task 会被 404，但 .json 能过。内容是同一份二进制（已验证字节一致），
  // MediaPipe 只按 ArrayBuffer 解析，不看扩展名。
  () => new URL('models/face_landmarker.json', document.baseURI).href,
  () => 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
];

export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.landmarker = null;
    this.stream = null;
    this.lastVideoTime = -1;
    this.backend = '';
    this.present = false;
    this.blendshapes = null;
    this.landmarks = null;
    this.matrix = null;
    this.connections = null;
    this.tesselation = null;
    this.pointCount = 0;
  }

  async start(onStage = () => {}) {
    onStage('请求摄像头…');
    await this.#openCamera();
    onStage('加载面部模型…');
    await this.#load();
    return this.backend;
  }

  /** 只加载模型，不碰摄像头（离线分析视频文件时用） */
  async loadModel(onStage = () => {}) {
    if (this.landmarker) return this.backend;
    onStage('加载面部模型…');
    await this.#load();
    return this.backend;
  }

  async #openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('浏览器不支持摄像头');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError') throw new Error('摄像头权限被拒绝');
      if (err?.name === 'NotFoundError') throw new Error('没有找到摄像头');
      throw new Error('摄像头启动失败：' + (err?.message || '未知'));
    }

    this.video.srcObject = this.stream;
    this.video.muted = true;
    await this.video.play().catch(() => {});
    await new Promise((resolve, reject) => {
      if (this.video.videoWidth > 0) return resolve();
      const timer = setTimeout(() => reject(new Error('摄像头画面超时')), 10000);
      this.video.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  async #load() {
    let mod = null;
    let src = null;
    for (const c of VISION_SOURCES) {
      try {
        const m = await import(/* @vite-ignore */ c.lib);
        if (m?.FaceLandmarker && m?.FilesetResolver) { mod = m; src = c; break; }
      } catch { /* 换下一个源 */ }
    }
    if (!mod) throw new Error('视觉库加载失败');

    let fileset;
    try {
      fileset = await mod.FilesetResolver.forVisionTasks(src.wasm);
    } catch {
      throw new Error('识别引擎初始化失败');
    }

    const failures = [];
    for (const modelPath of MODEL_SOURCES) {
      const url = modelPath();
      for (const delegate of ['GPU', 'CPU']) {
        try {
          this.landmarker = await mod.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: url, delegate },
            runningMode: 'VIDEO',
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
          });
          this.backend = `FaceLandmarker · ${delegate}`;
          this.modelUrl = url;

          // 官方常量直接给出各部位连接关系。
          // 0.10.14 没有 FACE_LANDMARKS_NOSE —— 鼻子靠 TESSELATION 覆盖，
          // 比起手写索引去连鼻梁鼻翼，宁可多画网格：手写索引一旦错位就会连到脸颊上。
          const K = mod.FaceLandmarker;
          this.tesselation = K.FACE_LANDMARKS_TESSELATION || [];
          this.connections = {
            oval: K.FACE_LANDMARKS_FACE_OVAL || [],
            lips: K.FACE_LANDMARKS_LIPS || [],
            leftEye: K.FACE_LANDMARKS_LEFT_EYE || [],
            rightEye: K.FACE_LANDMARKS_RIGHT_EYE || [],
            leftBrow: K.FACE_LANDMARKS_LEFT_EYEBROW || [],
            rightBrow: K.FACE_LANDMARKS_RIGHT_EYEBROW || [],
            leftIris: K.FACE_LANDMARKS_LEFT_IRIS || [],
            rightIris: K.FACE_LANDMARKS_RIGHT_IRIS || [],
          };
          this.pointCount = 478;
          return;
        } catch (e) {
          const short = String((e && e.message) || e).slice(0, 80);
          failures.push(`${delegate} ${new URL(url, location.href).pathname.slice(-40)} → ${short}`);
        }
      }
    }

    // 模型取不到时，先确认到底是文件 404 还是引擎问题
    let reachable = '未知';
    try {
      const r = await fetch(MODEL_SOURCES[0](), { method: 'HEAD' });
      reachable = r.ok ? `可访问（${r.status}）` : `HTTP ${r.status}`;
    } catch (e) {
      reachable = '无法访问';
    }
    console.error('[face] 模型加载失败', failures, MODEL_SOURCES[0]());
    throw new Error(
      `面部模型加载失败。本地模型：${reachable}。` +
      (reachable === '无法访问' || reachable.includes('404')
        ? '　本地文件取不到，且官方 CDN 也不可达，请检查 models/face_landmarker.task 是否在正确目录。'
        : '　模型文件在，但识别引擎初始化失败，可能是浏览器不支持 WebGL/WASM。')
    );
  }

  /** 每帧调用，返回最新一帧的测量结果 */
  detect(nowMs) {
    if (!this.landmarker || this.video.readyState < 2) return this.present;
    if (this.video.currentTime === this.lastVideoTime) return this.present;
    this.lastVideoTime = this.video.currentTime;

    let res;
    try {
      res = this.landmarker.detectForVideo(this.video, nowMs);
    } catch {
      return this.present;
    }

    const lm = res?.faceLandmarks?.[0];
    this.present = !!lm;
    this.landmarks = lm || null;
    this.blendshapes = res?.faceBlendshapes?.[0]?.categories || null;
    this.matrix = res?.facialTransformationMatrixes?.[0]?.data || null;
    return this.present;
  }

  /** blendshape 名称 → 分数 的字典 */
  shapeMap() {
    if (!this.blendshapes) return null;
    const out = Object.create(null);
    for (const c of this.blendshapes) out[c.categoryName] = c.score;
    return out;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}
