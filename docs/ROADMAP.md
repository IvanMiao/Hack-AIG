# NEMESIS — 7 小时 Roadmap

> **"Speak a nightmare into existence. Fight it. It learns how you die — then it goes hunting your friends."**
> 仓库：IvanMiao/Hack-AIG · 部署：Cloudflare Pages（前端）+ Worker（代理/KV）· 发布：itch.io HTML

---

## 0. 原则（7 小时的取舍规则）
1. **AI 只在召唤阶段和死亡之后**运行；战斗循环零网络请求，确定性 60Hz。
2. **每小时结束都有一个可上传 itch 的构建**。第 1 小时就上传空包，之后每次里程碑重传。
3. 三条并行轨道，靠一份冻结的 `NemesisSpec` schema 契约解耦（0:45 前冻结，之后只加可选字段）。
4. 落后就按 §6 砍单顺序砍，不讨论。

## 1. 三条轨道
| 轨道 | 负责 | 产出 |
|---|---|---|
| **A · Runtime**（Yifan） | 战斗手感、相机、视觉、场景流 | three.js 游戏本体 |
| **B · Forge Backend**（Devin session 1） | Cloudflare Worker：Gemini 结构化输出、Gradium Voice Design+TTS、Nano Banana、音乐适配器、KV 缓存/血脉计数、兜底 Boss 烘焙 | `/forge` `/learn` `/voice-token` `/lineage` |
| **C · Contract & QA**（Devin session 2 / Codex） | 脚手架、`NemesisSpec` schema + normalize + clamp、headless 平衡模拟器、Vitest、itch 构建脚本、README/技术文档 | 契约层 + 文档 + 发布流水线 |

## 2. 小时级计划

### H0 · 0:00–0:45 — 打通与决策（全员）
- [ ] C：Vite + TS + three 脚手架推到 Hack-AIG；`npm run build:itch` 产出 `dist/` zip（`base: './'`）。
- [ ] B：Worker 骨架部署，绑定 `GEMINI_API_KEY` / `GRADIUM_API_KEY` secrets + KV namespace；各调一次 Gemini 文本、Nano Banana、Gradium TTS 确认通。
- [ ] A：itch.io 建页面，上传空包；**在 itch iframe 里测 `getUserMedia`**（决定语音输入是 Must 还是 Could）。
- [ ] **音乐决策（0:45 截止）**：B 用 `lyria-3-clip-preview` 生 2 段（grief / rage 各 1，指定 bpm 与 "instrumental boss battle loop"），再用 ElevenLabs 生 1 段；Yifan 听完拍板。两者都藏在 `MusicProvider` 接口后面，切换只改一个 env。
- [ ] **冻结 `NemesisSpec` v1 schema**（见 §3），三轨都以它为准。
- [ ] 确认 Gemini 项目 tier（AI Studio）；Gradium 自定义声音槽位上限。

### H1 · 0:45–2:00 — 战斗核心 + 生成通路
- A：确定性战斗模拟核心（纯逻辑、无渲染依赖、可 headless 测试），招式原语 **8 个**：`sweep thrust charge nova ring volley zone blink`；玩家：**肩后锁定相机**（Tab）、体力、轻/重击、翻滚 i-frame。先用一个硬编码 spec 打起来。
- A：美术方向定稿并落地基础材质（见 §3b/§4）；`#hud` DOM 层骨架。
- B：`POST /forge {incantation}` → Gemini `gemini-3.8-flash` structured output → ajv 校验 + clamp → 返回 spec；失败返回兜底 spec。同 incantation 命中 KV 缓存。
- C：`normalize()` + 公平不变量（telegraph ≥ 500ms、单招伤害 ≤ 35% HP、每阶段 ≥ 3 招）；headless bot 模拟 100 局给 `difficultyScore`，超出区间自动缩放。
- **里程碑 1（2:00）**：本地能从一句话生成 Boss 并打完一局。

### H2 · 2:00–3:15 — 召唤仪式 + 声音 + 美术资产
- A：**Incantation 场景**：输入框（若麦克风可用则加按住说话，Gradium STT 直连）；提交后进入法阵：四张 Forge 卡（FORM / TEMPER / VOICE / ARENA）随后端返回字段依次翻开；Boss 剪影按部件拼装；TTS intro 到达即播放 + 音乐淡入。延迟用仪式动画遮盖，进度条 = 4 个并行任务。
- B：Voice Design（Gemini 写 design prompt → Gradium 造声 → TTS 合成 intro / phase / taunt×3 / playerDeath×2 / defeat → 存 KV/R2 → 返 URL → 删临时 voice 释放槽位）。Nano Banana 2 按 `art.styleAnchor` 生天空盒（equirect，比例不支持就 1:1 远景板）+ 立绘 + 2 张冲击帧 + 面孔贴图（黑底精灵图）。音乐适配器出 P1/P2 两段。
- C：`/forge` 契约测试；兜底资产管线脚本 `bake:fallback`。
- **里程碑 2（3:15）**：说一句话 → 有声音有音乐有天空的 Boss 出现并开打。上传 itch。

### H3 · 3:15–4:30 — GRUDGE 学习 + 二阶段 + 分享
- A：死亡日志采集（翻滚方向分布、被哪招打中、攻击时机）；死亡画面出 **GRUDGE 卡**（"You rolled left 78% of the time"）→ 新招/参数刻进法阵 → 再战。二阶段 **"空间破碎"过场**：时间膨胀 0.3s、天空盒切换/反色、音乐切 P2、Boss 剪影变形；Boss 台词按事件播放。
- B：`POST /learn {code, deathLog}` → Gemini 输出**白名单字段补丁**（加 1 招 / 调 1–2 个参数），服务端 clamp + 重跑不变量。`GET/POST /lineage/:code`：KV 计数 `gen`、`kills`，每日进化上限 3。
- C：分享 URL 编码（`?b=base64(deflate(spec))`）+ 短码 KV；结算卡 DOM→canvas 截图。
- **里程碑 3（4:30）**：完整循环：召唤 → 死 → 它学了 → 赢 → 分享链接在手机上能开。

### H4 · 4:30–5:30 — 兜底 + 手感 + Rift
- B：烘焙 **3 个离线兜底 Boss**（含声音、图、音乐）打进包；`/forge` 失败/超时（>20s）自动回退。
- A：打击感：hit-stop 70ms、屏震、白闪、墨迹粒子、完美翻滚时间膨胀；弹反（Q，imminent 窗口）若手感一小时内可调好就留，否则砍。
- A（Should）：**Rift: Beat** —— 若音乐 bpm 已知，二阶段 `volley/zone` 按拍点落下，屏幕边缘脉冲；否则跳过。
- C：README 初稿（安装、架构图、合作方技术表、API 文档、已知问题）。
- **里程碑 4（5:30）**：**功能冻结**。上传 itch。

### H5 · 5:30–6:20 — 冻结后只修
- 全员：bug bash（3 个兜底 Boss 各打 2 局 + 2 个现场生成）；Chrome Performance 看 1080p 是否 60fps，draw call < 300，粒子用 InstancedMesh；控制台零报错。
- C：README/技术文档定稿，Devin session 链接与 PR 列表进 README（Cognition side challenge）。
- A：截图 ×5、15s GIF、itch 页面文案（英文一句话 + 操作说明）。

### H6 · 6:20–7:00 — 缓冲与提交
- 最终构建上传，换一台机器/手机打开 itch 链接实测（音频需首次点击）。
- 准备演示用的两句 incantation（提前烤过缓存，确保现场秒出）。
- 提交表单：itch 链接、GitHub 链接、技术清单。

## 3. `NemesisSpec` v1（0:45 冻结的契约）
```ts
interface NemesisSpec {
  version: 1;
  code: string;                       // 分享短码
  lineage: { gen: number; kills: number };
  identity: {
    name: string; title: string; incantation: string;   // 原句，Boss 会扭曲复述
    silhouette: "colossus"|"hound"|"seraph"|"serpent"|"knight"|"swarm";
    element: "fire"|"ice"|"void"|"blood"|"storm";
    temper: "grief"|"rage"|"hunger"|"pride";
    palette: [string, string, string];
  };
  stats: { maxHp: number; poise: number; aggression: number /*0–1*/ };
  phases: Array<{
    hpThreshold: number;                // 1.0 = 开局
    moves: Move[];                      // ≥3
    rule: "none"|"closing_ring"|"pillars"|"rift_beat";
  }>;
  weakness: { trigger: "after_blink"|"after_charge"|"heavy_hit"|"parry"; multiplier: number };
  arena: { theme: string; skyPrompt: string; skyUrl?: string };
  art: {
    styleAnchor: string;          // 所有 Nano Banana 图共用的风格锚句，保证同一 Boss 的图风格一致
    accentHex: string;
    portraitUrl?: string; impactFrameUrls?: string[]; faceTextureUrl?: string; splatterSheetUrl?: string;
  };
  voice: { designPrompt: string; voiceId?: string;
           lines: { intro: string; phase: string; taunt: string[]; playerDeath: string[]; defeat: string };
           audio?: Record<string, string> };
  music: { p1Prompt: string; p2Prompt: string; bpm: number; p1Url?: string; p2Url?: string };
  grudges: Array<{ observation: string; patch: string }>;   // 学习历史，展示用
}
type Move = {
  type: "sweep"|"thrust"|"charge"|"nova"|"ring"|"volley"|"zone"|"blink";
  telegraphMs: number; damage: number; scale?: number; count?: number; followUp?: Move["type"];
};
```

## 3b. 技术栈决策
| 决策 | 选择 | 理由 |
|---|---|---|
| 构建 | **Vite + TypeScript**（不用 Next.js） | itch.io 只吃静态 HTML + 相对路径，`base: './'` 一行搞定；无 SSR 需求，后端全在 Worker；Next 的 static export 相对路径别扭且 hydration 抢首帧 |
| UI 层 | **DOM + CSS**（不用 React） | 一个 `#hud` div 叠在 canvas 上：法阵、Forge 卡、GRUDGE 卡、血条、字幕；CSS 动画 / blur / mix-blend-mode 白送 |
| 3D | **three.js r18x，WebGL2** | 熟悉、toon 材质 / InstancedMesh / decal 现成；不开 WebGPU（iframe 兼容风险）；描边用反面法线外扩，避免全屏 pass |
| 部署 | Cloudflare Pages（`dist/`）+ wrangler 独立部署 Worker | 两条流水线互不干扰 |

### 3D + 2D 混合：3D 负责"能打"，2D 负责"好看"
3D 只做低模 cel-shaded 玩家 / Boss / 平台；质感全部来自 2D 图层（按性价比排序）：
1. **DOM/CSS 层**：法阵 UI、四张 Forge 卡翻牌、撕纸 GRUDGE 卡、手写体 Boss 名、YOU DIED、二阶段宽银幕黑边。
2. **Nano Banana 全屏背景**：equirect 天空盒或大幅远景板（虚空 + 元素色），占屏 60%，直接决定质感。
3. **Impact Frame（漫画冲击帧）**：重击命中 / 阶段切换时插 2–3 帧全屏高对比 2D 插画（`impactFrameUrls`，每 Boss 生 2 张），停 80ms 回 3D。
4. **Boss 立绘登场**：intro 台词时立绘侧滑入 + 字幕，3D 模型同时溶解出现；结算卡复用同一张。
5. **2D 精灵进 3D**：墨迹飞溅 / 命中火花 / 符文用生成的精灵图做 billboard 粒子和 decal；生成时要求纯黑背景，shader 里 luma key 抠图。
6. **Boss 面孔 / 纹样贴图**：程序化部件出剪影，Nano Banana 出"脸"（`faceTextureUrl`），每个 Boss 一眼不同而不碰 3D 生成。

规则：所有图共用 `art.styleAnchor`（如 "ink wash + neon rim light, black void, single accent color {accentHex}"），由 Gemini 在出 spec 时一并生成；天空盒 / 立绘 / 冲击帧 / 贴图 prompt 全部拼接该句。
不做：Boss 本体 2D 纸片（动画与判定复杂）；2D 侧视关卡仍留 Could。

## 4. 视觉方向
| 维度 | Nemesis |
|---|---|
| 调性 | **"墨与霓虹的噩梦"**：黑底 + 单一高饱和元素色（火=橙红、冰=青、虚空=紫、血=洋红、风暴=黄绿） |
| 渲染 | **Cel-shading**（`MeshToonMaterial` + 3 阶渐变）+ **反面法线外扩描边**（无后处理，省 fps）+ 溶解 shader 做进场/死亡 |
| 相机 | **肩后第三人称 + 锁定**，二阶段拉远变宽银幕黑边 |
| 场地 | **漂浮在虚空中的破碎平台**，Nano Banana 天空盒占满背景，边缘是发光断裂线 |
| 打击 | **墨迹飞溅 decals** + 元素色 hit-stop 闪、屏幕边缘脉冲 |
| 玩家 | **召唤者**：斗篷 + 锁链武器（轻击甩链、重击回收拉扯），剪影一眼可辨 |
| UI | 法阵符文式 UI，Boss 名用 Nano Banana 立绘 + 手写体，GRUDGE 卡是"被撕开的纸" |
| 音乐 | 按 temper 生成：grief 慢管风琴 / rage 打击乐 / hunger 工业 / pride 圣咏，P2 加速 |

## 5. 合作方技术使用点（README 用）
- **Gemini 3.8 Flash**：incantation → spec、GRUDGE 补丁、Voice Design 描述、音乐 prompt
- **Nano Banana 2**：天空盒、立绘、冲击帧、面孔贴图、墨迹精灵图、分享卡（统一 `styleAnchor`）
- **Lyria 3 Clip** 或 ElevenLabs Music（0:45 决定）：P1/P2 循环
- **Gradium**：Voice Design + TTS（Boss 嗓音）；STT（语音咒语输入，若 iframe 允许）
- **Devin / Codex**：轨道 B、C 全部由 agent 执行，README 附 session 链接
- Cloudflare Pages + Worker + KV

## 6. 砍单顺序（落后 30 分钟以上就从上往下砍）
1. Rift: Beat
2. 语音输入（STT）
3. 弹反
4. Nano Banana 面孔贴图 → 冲击帧 → 立绘（保留天空盒）
5. 血脉 KV 计数（保留纯 URL 分享）
6. 兜底 Boss 3 → 2
7. GRUDGE 从 Gemini 补丁降级为**规则补丁**（本地统计翻滚方向 → 直接加对应招，仍有效果，零 API）

## 7. 决策点时间表
| 时间 | 决策 |
|---|---|
| 0:30 | itch iframe 麦克风可用？→ 语音输入 Must/Could |
| 0:45 | Lyria vs ElevenLabs；schema 冻结 |
| 2:00 | 里程碑 1 未达 → 原语 8 → 6 |
| 4:30 | 功能冻结，无例外 |
