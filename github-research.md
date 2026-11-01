# GitHub 相关项目清单

> 数据来源：GitHub Search API，拉取时间 2026-10-31。star 数为当时快照，会变。
> 已剔除无关噪音：fall detection（"lying down"）、网络安全 deception/蜜罐、deepfake 检测、LLM 说谎检测。

---

## A. 微表情识别

| 项目 | ★ | 语言 | 说明 |
| --- | --- | --- | --- |
| IcedDoggie/Micro-Expression-with-Deep-Learning | 283 | Python | 深度学习微表情 spotting 与 recognition 实验 |
| Vision-Intelligence-and-Robots-Group/awesome-micro-expression-recognition | 189 | — | 微表情识别／检测／分析资源汇总，**入门首选** |
| uark-cviu/Micron-BERT | 183 | Python | CVPR 2023，基于 BERT 的微表情识别 |
| homxxx/MicroExpressionRecognition | 155 | Python | 中文项目，CASME2 训练，支持摄像头／图片／视频检测 |
| bogireddytejareddy/micro-expression-recognition | 147 | Python | 3D 时空 CNN |
| quangvnai/me_recognition | 130 | Python | IEEE FG 2019，CapsuleNet |
| Justin900429/Facial-Graph-Representation-Learning | 75 | Python | 面部图表示学习 + AU 融合 |
| xiaobaishu0097/MEGC2019 | 71 | Python | MEGC2019 微表情竞赛代码 |
| k-m-irfan/microexpression_recognition | 70 | Python | OpenCV + PyTorch **实时**识别 |
| Justin900429/PyTorch-DSSN-MER | 56 | Python | Dual-Stream Shallow Networks |
| TJUMMG/KFC-MER | 56 | Python | 关键面部组件引导 + 一阶／二阶运动 |
| genbing99/MEAN_Spot-then-recognize | 51 | Python | 先 spot 后 recognize |
| oceanhao/HSTA_MER | 49 | Python | 层级时空注意力 |
| JayShaun/MICRO-Expression-Recognition-with-deep-learning | 42 | Python | 深度学习微表情识别 |

常用数据集：CASME2、SMIC、SAMM、MMEW、CAS(ME)²

---

## B. 测谎／欺骗检测

| 项目 | ★ | 语言 | 说明 |
| --- | --- | --- | --- |
| sidmulajkar/sentiment-predictor-for-stress-detection | 100 | Notebook | 语音压力检测（Mel-filter bank + CNN） |
| Notabela/Lie_to_me | 76 | Python | 脸部 + 语音测谎，对标《Lie to Me》 |
| alicex2020/Deep-Learning-Lie-Detection | 57 | Notebook | 仅用声学特征测谎 |
| Redaimao/awesome-multimodal-deception-detection | 46 | — | 多模态欺骗检测文献列表 |
| DetectingHumanEmotion/detecting-human-emotion-webapp | 38 | Python | 音视频欺骗与情绪检测 webapp |
| zachmaurer/lie-detector | 38 | Python | CMU Deception Corpus + LSTM |
| NMS05/Audio-Visual-Deception-Detection-DOLOS | 37 | Python | **DOLOS 数据集**，参数高效跨模态学习 |

常用数据集：DOLOS、CMU Deception Corpus、Real-life Trial

---

## C. 面部动作单元（AU）检测

| 项目 | ★ | 语言 | 说明 |
| --- | --- | --- | --- |
| TadasBaltrusaitis/OpenFace | 7791 | MATLAB/C++ | 行业标准：关键点、头部姿态、AU、视线 |
| CMU-MultiComp-Lab/OpenFace-3.0 | 198 | Python | OpenFace 新版，含情绪识别 |
| mysee1989/TCAE | 168 | Python | 视频自监督表征学习用于 AU 检测 |
| BCV-Uniandes/AUNets | 152 | Python | 多视角动态 AU 检测 |
| ZhiwenShao/JAANet | 95 | C++ | ECCV 2018，AU 检测 + 人脸对齐联合 |
| zkl20061823/DRML | 65 | C++ | CVPR 2016，区域多标签学习 |
| awakening-ai/AUCanvas | 45 | Python | AU 检测模型 + **可视化画布** |
| ihp-lab/FG-Net | 32 | Python | WACV 2024，可泛化金字塔特征 |

---

## D. 使用这些项目时必须注意的三点

**1. A 类做的不是测谎。**
CASME2／SMIC／SAMM 标注的是**情绪类别**（高兴、厌恶、惊讶等），不是真伪。
用它们训练出的模型输出是"这个表情是压抑的愤怒"，不是"这个人在说谎"。
把 A 类成果说成测谎能力，是这类作品最常见的概念偷换。

**2. B 类的高准确率都来自实验室数据集。**
DOLOS、CMU Deception Corpus 里的"说谎"是**被指示的**——受试者按要求说假话，
没有真实动机、没有后果、没有风险评估。所以论文里的 70–80% 不能当作真实场景性能。

**3. 这些仓库几乎都不讨论效度。**
README 只写"准确率多少、怎么跑"，不会提 DePaulo 2003 那类元分析结论（54% vs 50%）。
做课程作业时：**引用数据集和论文，不要引用仓库**。

---

## E. 如果是做课程作业／比赛，推荐组合

| 目标 | 用哪个 |
| --- | --- |
| 实时 demo 底座 | `homxxx/MicroExpressionRecognition`（摄像头模式）、`k-m-irfan/microexpression_recognition` |
| 理解原理与文献 | `awesome-micro-expression-recognition` + `Micron-BERT` |
| 工业级 AU 测量 | `OpenFace` / `OpenFace-3.0` |
| 可视化参考 | `AUCanvas` |
| 叙事支撑 | `awesome-multimodal-deception-detection`（找 DOLOS 论文）+ DePaulo 2003 元分析 |
