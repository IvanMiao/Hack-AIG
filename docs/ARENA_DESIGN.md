# NEMESIS — 场地玩法设计：崩塌 · 元素变体 · 可破坏掩体

> 目标：把"单场景 1v1"变成"Boss 连同它的场地一起被召唤出来，并且场地会随战斗变化"。
> 三个功能共用一套 sim 侧的 `arena` 状态和一组 `BattleEvent`，表现层只消费事件与状态，不改战斗规则本身。

---

## 0. 结论先行

| 功能 | 玩法价值 | sim 改动 | 表现改动 | 估时 |
|---|---|---|---|---|
| A · 场地崩塌（`closing_ring`） | 空间被压缩，远程/zone 越来越难躲，二阶段有"世界在塌"的压迫感 | 小（半径变成状态，~60 行） | 中（外环碎块掉落、断裂线跟随、尘雾） | 0.4 session |
| B · 元素场地变体（arena mutator） | 每个 Boss 的场地"活着"：岩浆冒出、风推人、血潮从边缘涌入 | 中（新 hazard 来源 + 一个 push 向量，~120 行） | 小（复用 hazard decal + 颜色/样式） | 0.5 session |
| C · 可破坏掩体（`pillars`） | 真正的"场景破坏"：能挡弹幕，Boss 冲撞/横扫会把柱子拆掉 | 中（obstacle 数组、圆-圆碰撞、弹丸/hazard 判定，~150 行） | 中（柱子升起/裂/碎、碎块与尘） | 0.6 session |
| 契约 + 平衡 + Lab | prompt、invariants、bot、dev.html 调参 | 小 | — | 0.3 session |

合计约 **1.8 session**，拆成 4 个可独立合并的 PR（见 §7）。

**关键发现：spec 里已经有这个 hook。** `Phase.rule: "none" | "closing_ring" | "pillars" | "rift_beat"`（`src/spec/types.ts:13`）从 schema 冻结起就存在，Gemini 每次都在输出它，6 个 bound boss 的 fallback spec 也都填了（`src/spec/fallback.ts`），但 **sim 完全没有读它**。A 和 C 直接落在 `closing_ring` / `pillars` 上，意味着：

- 不改 Gemini 的 responseSchema，不改分享码编码，历史分享码和烘焙资产自动获得新玩法；
- 三个默认 Boss 里已有 2 个 `pillars`、1 个 `closing_ring`，上线即有内容。

`rift_beat` 依赖音乐 bpm 同步，**本设计不做**，保留为 no-op。

---

## 1. 现状（设计依据）

- `src/sim` 是纯 2D（x, z）确定性 60Hz 模拟，零渲染依赖，`bot.ts` 用它跑 headless 平衡（`measureDifficulty` / `calibrateDifficulty`，目标 `DIFFICULTY_BAND = [0.35, 0.8]`）。任何新机制必须用 `state`/`rng` 保持确定性，且不能让 bot 卡死。
- 场地 = `ARENA_RADIUS = 9` 一个常量 + `clampToDisc`。被引用 8 处（`battle.ts:153/270/286/292/363/405/456/457`，`createStage.ts:522/528/562`）。
- hazard 是通用形状系统：`arc | circle | line | ring` + `overlaps(shape, p, r)`（`src/sim/hazard.ts`），`Hazard.source: MoveType` 用于 DeathLog/Grudge 归因。
- 表现层：`createStage.ts` 里 arena 是一个 GLB（`blender/build_assets.py:build_arena`），按节点名（`walkable`、`hairline floor fracture`、`floating debris`、`Broken obelisk`…）换材质；`hazardView.ts` 按 `state.hazards` / `previewShape()` 画 decal，落地留裂纹；`particles.ts` 有 `burst()`。
- `ForgeDraft` → `normalizeDraft` → `checkInvariants` 是唯一入口；`applyGrudge` 只允许白名单 op。

---

## 2. 总体架构

```ts
// src/sim/types.ts —— 新增
export interface ArenaState {
  radius: number;          // 当前可站立半径（替代 ARENA_RADIUS 的运行时读法）
  targetRadius: number;    // closing_ring 正在收缩到的目标
  mutator: ArenaMutator;   // 由 spec 决定，见 §4
  mutatorT: number;        // 距下次场地事件的 ms
  wind: Vec2;              // tempest 用；其他 mutator 恒为 0
  obstacles: Obstacle[];   // pillars 用；其他为空
}

export interface Obstacle {
  id: number;
  pos: Vec2;
  radius: number;          // 0.7
  hp: number;              // 剩余可承受的 Boss 打击次数，0 → 碎
}

export type HazardSource = MoveType | "arena";   // Hazard.source / DeathLog.killedBy / hitsTaken 的键

export type BattleEvent =
  | ...现有...
  | { type: "arenaShrink"; from: number; to: number; ms: number }
  | { type: "arenaPulse"; mutator: ArenaMutator; at: Vec2 }        // 场地事件的 telegraph 起点
  | { type: "obstaclesRaised"; ids: number[] }
  | { type: "obstacleHit"; id: number; hpLeft: number; by: MoveType }
  | { type: "obstacleBroken"; id: number; pos: Vec2; by: MoveType };
```

`BattleState` 加 `arena: ArenaState`。`ARENA_RADIUS` 常量保留作为初始值与表现层几何尺寸，**sim 内所有运行时判定改读 `state.arena.radius`**。

`step()` 顺序改为：`stepPlayer → stepBoss → stepArena → stepHazards → resolveObstacles`。
`stepArena` 负责收缩插值、mutator 计时与生成、风推；`resolveObstacles` 在所有位移之后做圆-圆分离，保证玩家/Boss 永远不嵌在柱子里。

规则触发点统一放在 **进入某个 phase 时**（`stepBoss` 的 phaseChange 分支 + `createInitialState` 对 phase 0）：

```ts
const applyPhaseRule = (phase: Phase, events) => {
  switch (phase.rule) {
    case "closing_ring": beginShrink(Math.max(ARENA.minRadius, state.arena.radius * ARENA.shrinkFactor), events); break;
    case "pillars":      raisePillars(events); break;
    default:             /* none / rift_beat: no-op */
  }
};
```

---

## 3. 功能 A · 场地崩塌（`closing_ring`）

**规则**
- 进入带 `closing_ring` 的 phase 时，`targetRadius = max(5.5, radius × 0.7)`，在 `ARENA.shrinkMs = 4000` 内线性收缩。半径 9 → 6.3；若两个 phase 都是 closing_ring，第二次到 5.5 下限（Boss 半径 1.1 + 玩家翻滚 4.2，5.5 是能绕背的最小值）。
- 收缩期间所有 `clampToDisc(..., state.arena.radius - margin)` 自动把玩家/Boss 挤进来；**不做边缘伤害**——Souls 味的压迫来自空间而非扣血，也避免 bot 被边缘误杀导致平衡失真。
- `zone` 落点、`blink` 落点、`ring` 的 `maxRadius`、弹丸出界判定都跟随新半径，否则会出现"打在虚空上"的 decal。
- `rule: "none"` 的 phase 切换也发一次 `arenaShrink { from: r, to: r, ms: 0 }`？不——改为表现层监听既有 `phaseChange` 做**纯视觉**崩落（外环掉几块碎石、不改半径），让每个 Boss 二阶段都有"场地在反应"，但只有 closing_ring 真的缩。

**表现（`createStage.ts` / `hazardView.ts`）**
- `fracture` 断裂线 torus 与 `edgeFade` 半径改为跟随 `state.arena.radius`（每帧 `scale.setScalar(r / ARENA_RADIUS)`）；断裂线在收缩期间亮度 ×3 并抖动。
- 崩落碎块：收缩开始时，在旧半径到新半径之间的环带上按 `rng`（表现层可用 `Math.random`，不影响 sim）生成 10–16 个楔形块（`CylinderGeometry` 扇形切片 + `createToonMaterial` + `addOutline`，和 `fallbackPlatform` 同风格），先上抬 0.15 抖 300ms，再以不同延迟自由落体到 y = -30 后回收。配合 `particles.burst` 石尘（复用 `bossStagger` 那组灰色参数）+ 相机 `shake` 0.4。
- 收缩完成后，走过被削掉区域的地面已经不存在——用 `edgeFade` 的 alpha 把外环压黑并加雾即可，不必真的删 GLB 顶点。
- HUD：`say()` 一句 Boss 的 `voice.lines.phase`（已有），无需新文案。

**bot**：无需改动，clamp 自动生效。预期 closing_ring Boss 的 bossWinRate 上升 5–10 个百分点，落在 band 内则不动，超出由 `calibrateDifficulty` 拉回。

---

## 4. 功能 B · 元素场地变体（arena mutator）

**为什么按 `identity.element` 派生而不是让 Gemini 单独选**
- 零 schema 变更：老分享码、烘焙资产、当前 Worker 全部兼容。
- 元素已经决定了调色板、hazard 风格、音乐倾向；场地跟着元素走视觉上天然一致。
- 仍留一个**可选**覆盖位：`ForgeDraft.arena?: { mutator: ArenaMutator } | null`（nullable，`normalizeDraft` 缺省时按元素派生）。第一版 prompt 不提它，等 A/B/C 稳定后再开放给 Gemini。

```ts
export const ARENA_MUTATORS = ["none", "ember", "tempest", "bloodtide", "frost", "rift"] as const;
const MUTATOR_BY_ELEMENT: Record<Element, ArenaMutator> = { fire: "ember", storm: "tempest", blood: "bloodtide", ice: "frost", void: "rift" };
```

| mutator | 元素 | 机制（sim） | 表现 |
|---|---|---|---|
| `ember` | fire | 每 `period` ms 在玩家附近 `rng` 位置生成 1–2 个 `circle` 常驻 hazard（`source: "arena"`，`repeat: true`，`ttl 5000`，tick 6），**telegraph 1200ms**（先发 `arenaPulse`，1200ms 后才 `spawnHazard`） | 地面裂开发橙光→喷出岩浆池；复用 zone decal 但 style 用暖色 crack 贴图 |
| `tempest` | storm | `arena.wind` 每 6s 换一个方向（`rng`），风速 1.6 u/s；`stepArena` 把 `wind × dt` 加到玩家位置（翻滚中 ×0.5），弹丸速度也叠加风 | 屏幕边缘朝风向的粒子流（`particles.ambient` 加方向偏置）+ HUD 边缘一条细箭头 |
| `bloodtide` | blood | 每 `period` ms 一次"潮涌"：从 `arena.radius` 向内推进到 `radius - 2.2` 的 `ring` hazard（`growth` 为负），telegraph 1500ms，逼玩家离开边缘 | 外环地面泛洋红、潮线扫过留下短暂血渍 decal |
| `frost` | ice | 每 `period` 在场地生成 1 块 `circle` 冰面（无伤害）；站在上面移动速度 ×1.35、翻滚距离 ×1.4、翻滚 iframe 不变 → 更难精确站位 | 半透明冰面 decal + 玩家脚下冰晶粒子 |
| `rift` | void | 一条穿过场地中心、以 8°/s 缓慢旋转的 `line` hazard（宽 0.5），碰到不掉血，而是**把玩家传送到直线另一侧对称点**（打乱站位） | 紫色细缝 + 穿越时短暂反色闪 |

**MVP 只做 `ember` / `tempest` / `bloodtide`**（三者全部复用现有 hazard/位移逻辑，不引入新玩家状态）。`frost`（需要速度修饰）与 `rift`（需要传送）标为 stretch，若时间允许在 PR3 末尾加。

**节奏**：`period` 按 phase 递减：phase 1 = 9000ms，phase 2 = 5500ms；`aggression` 再乘 `[1.2 → 0.8]`。Boss `staggerT > 0` 或 `invulnerableT > 0`（阶段过场）期间暂停 mutator 计时，避免过场被岩浆打死。

**归因**：`Hazard.source` 放宽为 `HazardSource`。`DeathLog.hitsTaken` / `killedBy` 同步放宽；`grudge.ts:218` 的 `moves.findIndex(m => m.type === log.killedBy)` 对 `"arena"` 返回 -1 → `Math.max(0, …)` 已兜底为第 0 招；`describeDeath` 会自然写出 "killed by arena"，改成 "killed by the arena itself" 更好。Gemini 的 `/learn` prompt 加一句"若 killedBy 是 arena，倾向 `tuneStats.aggression` 而非改招"。

**Invariants 新增**（`src/spec/invariants.ts`）：arena hazard 单次伤害 ≤ 8，telegraph ≥ 1000ms，任何时刻场上 arena hazard ≤ 4 个（sim 侧硬上限，防 ember 铺满）。

---

## 5. 功能 C · 可破坏掩体（`pillars`）

**生成**：进入带 `pillars` 的 phase 时 `raisePillars()`：在半径 `4.6` 的圆上放 **4 根**柱子（`radius 0.7`，`hp 2`），起始角 = Boss 朝向 + 45°，间隔 90°，保证不会正好卡在 Boss 与玩家连线上，也不会挡住 `sigil`。已有柱子不重复生成（上限 4）。柱子升起有 600ms，升起期间只挡弹丸不挡人（防止把人顶飞）。

**碰撞（`resolveObstacles`，在所有位移后执行）**
```ts
for (const o of arena.obstacles) for (const body of [player, boss]) {
  const d = sub(body.pos, o.pos); const l = len(d); const min = o.radius + body.radius;
  if (l < min) body.pos = add(o.pos, norm(d, perp(body.facing)), min);   // 推出，天然形成"滑动"
}
```
Boss 走路是直线追人，圆形推出后会沿切线滑过去，不会卡死；`charge` 是唯一高速位移，单独处理（见下）。

**破坏来源（只有 Boss 能拆）**

| 触发 | 判定 | 结果 |
|---|---|---|
| `charge` 撞柱 | active 期每 tick `dist(boss, o) ≤ o.radius + BOSS.radius` | 柱 `hp -= 2`（直接碎），Boss 立刻进 `recover` 并 **`+400ms`**（撞墙硬直，奖励用柱子骗冲撞），`spec.weakness.trigger === "after_charge"` 照常开窍 |
| `sweep` / `nova` / `thrust` / `ring` 命中 | 生成 hazard 时及 `stepHazards` 里对每根柱子 `overlaps(shape, o.pos, o.radius)`，同一 hazard 对同一柱只算一次 | `hp -= 1` |
| `volley` 弹丸 | `dist(pr.pos, o.pos) ≤ pr.radius + o.radius` | 弹丸消失（**这就是掩体价值**），柱 `hp -= 1` |
| `zone` / `blink` / arena mutator | 不影响柱子 | — |
| 玩家轻/重击 | 不影响柱子 | 避免自己拆掉掩体的挫败感；可作为后续选项 |

`hp ≤ 0` → 从 `obstacles` 移除，发 `obstacleBroken`。柱子掉光后本 phase 不再生成；若下一 phase 也是 `pillars` 则重新升起 4 根——形成"Boss 拆家 → 换阶段 → 场地重建"的节奏。

**Boss AI 微调**（`chooseMove`）：若玩家与 Boss 连线上有柱子（线段-圆相交），`volley` 候选权重 ×0.4，`charge` 权重 ×1.5——Boss 会倾向去撞碎你的掩体，而不是傻站着往柱子上打弹幕。

**bot**（`bot.ts`）：加一条规则——Boss telegraph `volley` 时，若最近的柱子在 3.5 内，向"柱子在 Boss 与自己之间"的点移动而不是侧移。这样平衡模拟能反映掩体收益；不加的话 pillars Boss 会被测得偏难，calibrate 会错误地削 Boss。

**表现**
- 柱子 mesh：优先在 `build_assets.py` 用现成 `pillar_mesh()` 导出一个 `cover_pillar.glb`（高 2.6、底半径 0.7、风格与 `Broken obelisk` 一致），走 `instantiate()`；没时间就 `CylinderGeometry(0.62, 0.72, 2.6, 7)` + toon + outline 兜底。
- 升起：600ms 从 y = -2.6 缓入到 0，底部 `particles.burst` 石尘一圈。
- 受击（`obstacleHit`）：柱身贴 `makeCrackTexture()` 裂纹 decal（`hazardView` 已有）+ 白闪 60ms + 相机 `punch`。
- 碎裂（`obstacleBroken`）：柱子隐藏；生成 5–7 个 `rock_chunk` 风格小块（可复用 GLB 里 `Raised fractured floor slab` 的几何 clone）沿冲击方向抛出，1.2s 后沉入地面回收；`particles.burst` 两组（灰石 + 元素色火星）；hit-stop 40ms。
- Debug：`debug.hitboxes` 时给柱子画半径圈（`makeCircle`）。

---

## 6. 契约、Prompt、兼容性

- **Schema**：仅新增可选 `arena?: { mutator } | null`（`schema.ts` + `toGeminiSchema` 已支持 nullable）。`Phase.rule` 不动。
- **`normalizeDraft`**：填 `arena.mutator`（缺省按元素）；`rule: "rift_beat"` 保留原值（表现层 no-op），不再在 prompt 中鼓励。
- **`FORGE_SYSTEM_PROMPT`** 加两条：
  - `phase.rule: none | closing_ring (the arena shrinks by 30% when this phase begins — pair with ranged movesets) | pillars (four breakable pillars rise that block volley projectiles and shatter under charge/sweep — pair with melee/charge bosses). Give phase 2 a rule unless the boss is a pure duelist.`
  - `rift_beat is deprecated; do not use.`
- **`/learn` GrudgeOp** 新增 `{ op: "setRule"; phaseIndex; rule }`（白名单内），让 Boss 死后能"学会拆场地"——这是最便宜的、最有叙事感的进化。
- **分享码**：`NemesisSpec` 加可选字段不影响 `deflate(JSON)` 解码；`version` 保持 1。
- **烘焙资产 / fallback**：不改；`bake-fallback.ts` 不受影响。

---

## 7. 实施顺序（4 个 PR，均可独立合并、随时可上 itch）

1. **PR-A `sim/arena` + closing_ring**：`ArenaState`、替换 8 处 `ARENA_RADIUS`、`applyPhaseRule`、`arenaShrink` 事件；表现层断裂线/edgeFade 跟随 + 崩落碎块 + 通用 phaseChange 视觉崩落。测试见 §8-A。
2. **PR-C pillars**：`Obstacle`、`resolveObstacles`、四类破坏判定、Boss 权重、bot 掩体规则、柱子表现三段（升/裂/碎）。测试见 §8-C。（放在 B 之前，因为它对"不像 1v1"的贡献最大。）
3. **PR-B mutators（ember / tempest / bloodtide）**：`HazardSource`、`stepArena`、三种生成器、归因与 Grudge 文案；表现层 decal 样式 + 风粒子。stretch：frost / rift。
4. **PR-D 契约与 Lab**：prompt、`arena` 可选字段、`setRule` GrudgeOp、invariants、`dev.html` 加 rule / mutator 下拉与"raise pillars / shrink now / pulse now"按钮、README 一节、`checkInvariants` 跑全部 fallback。

每个 PR 合并前跑 `npm run typecheck && npm test`，并对 6 个 fallback spec 跑 `measureDifficulty(spec, 40)` 贴在 PR 描述里（前后对比）。

---

## 8. 测试与平衡

**A**
- 同 seed 同输入结果相同（既有 determinism 测试覆盖新状态）。
- closing_ring phase 开始后 4s 内 `arena.radius` 到达目标且 ≥ 5.5；玩家/Boss 位置始终 `≤ radius - margin`。
- `zone` 落点 / `blink` 落点 / 弹丸出界均以新半径为准（造一个半径 6 的状态断言）。

**C**
- 弹丸命中柱子后消失且 `hp` 减 1；第 2 发使 `obstacleBroken`。
- `charge` 直线上有柱子：柱子碎、Boss 进入 recover 且 `recoverMs` 增加 400。
- **不卡死**：pillars phase 下 idle 玩家站在柱子后，Boss 8s 内进入 `meleeRange`（保证滑动有效）。
- 玩家攻击不改变柱子 `hp`。

**B**
- ember 的 `arenaPulse` 到 hazard 生成间隔 ≥ 1000ms；场上 `source === "arena"` 的 hazard 永不超过 4。
- 阶段过场 (`invulnerableT > 0`) 期间不生成 arena hazard。
- 被 arena 杀死时 `killedBy === "arena"`，`ruleGrudge` 不抛错。

**平衡**：新增 `src/sim/arena.test.ts`：对 6 个 fallback 各跑 `measureDifficulty(spec, 40)`，断言在 `DIFFICULTY_BAND` 内（允许由 `calibrateDifficulty` 修正 ≤ 2 步）。若 pillars Boss 系统性偏难，优先调 bot 掩体规则而不是削 Boss。

---

## 9. 风险与需要你拍板的点

1. **closing_ring 收缩后不做边缘伤害**（只 clamp）。如果你想要"掉下去就死"的 Souls 感，可以加 `edge` hazard，但 bot 和 Grudge 归因都要跟着改，建议先 clamp 版上线看手感。
2. **玩家攻击是否能拆柱子**：默认不能。能拆更"真实"，但会让新手把自己的掩体打光。
3. **柱子数量 / hp**：4 根 / 2 hp 是拍脑袋值，Lab 里做成可调；如果 `charge` 一发碎让柱子太脆，可改 `hp 3`、charge 扣 2。
4. **mutator 由元素派生 vs Gemini 选**：建议第一版派生，稳定后再把 `arena.mutator` 开放到 prompt。
5. **美术**：柱子和碎块走 Blender 导出还是 three 程序化？程序化零阻塞，Blender 更统一（`build_assets.py` 已有 `pillar_mesh` / `rock_chunk`，约 20 分钟 + 2 分钟烘焙）。建议 PR-C 先程序化占位，PR-D 换 GLB。
6. **rift_beat**：本设计明确不做；若后面音乐 bpm 稳定了再单开。
7. **性能**：新增 draw call 上限估计：碎块 ≤ 16、柱子 4 + 碎块 7×4、arena decal ≤ 4 → 仍在 roadmap 的 300 draw call 预算内；碎块统一用 InstancedMesh 更稳。
