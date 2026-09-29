# 小小故事书 · 3D Flipbook

Three.js + Vite 的儿童英文绘本脚手架。支持立体翻页、横屏阅读、按页配音与本地 MP4 导出。

## 运行

```bash
npm install
npm run dev
npm run build
npm run preview
```

## 目录约束：一个故事，一个文件夹

所有故事专属内容统一存放在 `stories/<id>/`，文件夹名与 `manifest.json` 的 `id` 一致。不同输出版本保留在故事内部。

```text
stories/little-red-demo-v1/
├── manifest.json        # 故事元数据、英文原文、原始插画路径
├── story.md             # 故事原稿
├── storyboard.md        # 分镜
├── characters.md        # 角色和画风
├── prompts.md           # 图片生成提示词和来源
├── content.js           # 当前书页数据
├── narration.js         # 当前配音配置
├── art/                 # 原始插画
├── pages/v1/            # 排版后的书页
├── audio/               # 各版本配音、测试音调、时间轴、请求计划
├── video/               # MP4 及导出元数据
├── qa/                  # 检查报告、截图
├── backups/             # 历史内容/配音配置
└── archive/             # 迁移前的历史书包
```

`src/active-story.js` 是唯一的当前故事入口，同时选择该故事的 `content.js` 和 `narration.js`。`src` 内保留应用代码，不保存第二份故事内容。

开发时由 Vite 直接提供故事目录中的书页和正式音频。生产构建时仅把浏览器所需资源复制到 `dist/stories/`；不再手动维护 `public/stories`、`public/narration`、根目录 `exports` 或共享的 `stories/narration`。历史记录中的旧路径仅作为当时的记录保留。

## 项目 Skill

使用 [children-storybook](skills/children-storybook/SKILL.md)：

> 使用 children-storybook：小兔在花园遇到迷路的萤火虫，帮助它找到家。制作适合 4–7 岁儿童的英文绘本并填入翻页书。

默认 4 个主题跨页，可指定年龄、页数、画风及图片数量。完整目录规范见 [story-layout.md](skills/children-storybook/references/story-layout.md)。

## 生成插画

提示词由故事目录里的 `characters.md`（角色圣经 + 画风）和 `scenes.md`（逐页场景）展开而来，不再手写脚本：

```bash
python3 skills/children-storybook/scripts/gen_prompts.py --story stories/<id>
python3 skills/children-storybook/scripts/gen_art.py --story stories/<id> --dry-run   # 只打印计划，不联网、不花钱
python3 skills/children-storybook/scripts/gen_art.py --story stories/<id>             # 真实生成
```

`--dry-run` 会列出每个资产用到的参考图及其顺序，务必先看。`gen_art.py` 用标准库直接调用 OpenAI Images API，只需 `.env.local` 里的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_IMAGE_NAME`；默认串行，默认跳过已存在的图片，可断点续跑。细节见 [art-prompts.md](skills/children-storybook/references/art-prompts.md) 与 [art-pipeline.md](skills/children-storybook/references/art-pipeline.md)。

`skills/children-storybook/examples/goldilocks/` 是一本完整可离线构建的参考书，可用来在不花钱的前提下验证排版链路。

## 生成书页

原始图片存入该故事的 art/，在 manifest.json 中引用相对路径。生成一个新的页面版本：

```bash
python3 skills/children-storybook/scripts/build_book.py stories/<id>/manifest.json --check
python3 skills/children-storybook/scripts/build_book.py stories/<id>/manifest.json --build v2
```

脚本写入 `pages/v2/`，更新故事内的 content.js 并备份旧版本。增加或切换故事时修改 `src/active-story.js` 的两个导出路径。已生成的小红帽 demo 使用两张插画，复用于两个跨页和封面。

## 配音（统一走 OpenAI TTS 接口）

配音只有一套接口：OpenAI 的 `POST /v1/audio/speech`。官方云端、中转站、以及本地的 MOSS-TTS 服务都
通过它访问——skill 里没有任何 MOSS 专属代码。

把 `.env.example` 复制为 `.env.local`，在本地填写凭据。密钥不放入故事文件夹、不使用 VITE_* 前缀、
不提交仓库。默认模型 gpt-4o-mini-tts、marin 声线、0.9 倍速度，可配置。

```bash
npm run narration:plan
npm run narration:generate -- --name red-audio-v1 --install
```

端点优先级：`OPENAI_TTS_BASE_URL` → `OPENAI_BASE_URL` → `https://api.openai.com/v1`。之所以单独提供
`OPENAI_TTS_BASE_URL`，是因为 `OPENAI_BASE_URL` 是**图片**用的（`gen_art.py` 读它），改它会把图片请求
一起改道。凭据同理：`OPENAI_TTS_API_KEY` → `OPENAI_API_KEY`。

自动使用当前故事的 `audio/`，不需要传输出路径。plan 不调用接口；generate 才生成真实语音。--install
更新故事自己的 narration.js，原配置保存在 backups/。生成后试听每页再交付。

## 本地 MOSS-TTS（离线，Apple Silicon）

本地离线合成由一个**独立的姊妹项目** `moss-tts` 提供，它把 MOSS-TTS 包装成 OpenAI 兼容接口。本项目
不含它的任何代码，也不依赖它——配音只认 `OPENAI_TTS_BASE_URL` 指向的端点。

启动那个项目（默认就在 `../moss-tts`）：

```bash
cd ../moss-tts
uv sync                 # 一次性：创建 .venv 并装好依赖
.venv/bin/python server.py   # 后台预加载模型，监听 127.0.0.1:8123
```

然后在**本项目**的 `.env.local` 里：

```bash
OPENAI_TTS_BASE_URL=http://127.0.0.1:8123/v1
OPENAI_TTS_API_KEY=local               # 本地服务接受任意 token
OPENAI_TTS_VOICE=narrator              # 必须是那个项目 voices.json 里的预设名
```

之后用**完全相同**的 `npm run narration:plan` / `narration:generate` / `narrate` 命令。音色（参考音频、
语言、seed、采样参数）在 `moss-tts/voices.json` 里配置，请求体保持纯 OpenAI 字段；`timeline.json` 的
`tts.provider` 记为 `openai-compatible`，`tts.endpoint` 记录实际端点。

用官方 API 或中转站时不需要它：只填 `OPENAI_TTS_BASE_URL`/凭据即可，或者干脆都不填，默认走官方域名。

## 导出 MP4

```bash
npm run video:export -- \
  --timeline stories/little-red-demo-v1/audio/red-audio-v1/timeline.json \
  --output stories/little-red-demo-v1/video/little-red-v1.mp4
```

默认 1080p、30fps、H.264 + AAC。也可省略 --output，默认以音频版本命名并存入当前故事 video/。脚本拒绝故事目录外的时间轴和视频输出，且不覆盖已有文件。

使用同一条音频时间轴驱动网页与逐帧渲染；暂停/继续保持同步，手动翻页停止旧配音。

**不需要在项目里 npm install。** 阅读器以预编译产物 `skills/children-storybook/renderer/book.js` 随 skill 发布，导出时由 `node:http` 静态服务器提供，逐帧通过 Chrome DevTools Protocol 抓取。你只需要：**node 22+、python3、ffmpeg/ffprobe，以及一个 Chromium 系浏览器**（Chrome / Chromium / Edge / Brave，自动探测，可用 `CHROME_PATH` 或 `--chrome` 指定；也可在 `.env.local` 配置程序路径）。

改动阅读器源码后需要重建产物：`npm run build:renderer`；`npm run test:skill` 会检查产物是否与源码同步。

## 无 TTS 配置的验证

```bash
npm run test:skill
npm run test:narration
npm run test:media
npm run narration:fixture -- --name sync-test-v2
npm run video:export -- --timeline stories/little-red-demo-v1/audio/sync-test-v2/timeline.json --allow-test-audio
npm run video:verify-fixture -- --video stories/little-red-demo-v1/video/sync-test-v2.mp4 --timeline stories/little-red-demo-v1/audio/sync-test-v2/timeline.json
npm run test:e2e
```

`test:narration` 覆盖端点解析、纯 OpenAI 请求体与预设指纹缓存，不需要模型和网络。服务端的契约测试在
`moss-tts` 项目里，同样不需要模型。

测试音调不是英文朗读，不会安装为真实配音。视频和音频检查记录仍归属于同一个故事。浏览器截图存入当前故事的 qa/screenshots/。

配音工作流细节见 [narration-video.md](skills/children-storybook/references/narration-video.md)。
