# 接入方案（本轮不执行安装）

## 已核对的现有契约

目标：`/Users/wileyzhang/Code/voice_book`。已只读检查 `src/content.js` 与 `src/main.js`。`makeTexture` 加载 `data.image` 后绘制到 1024×1400 canvas；单加 `text` 不会显示内页文字。背面现有 repeat.x=-1 与 offset.x=1 负责镜像处理，不能另行反转英文。chapter 按钮由 sheets.length+1 自动生成。

## 精确纸张顺序

| Sheet | Front | Back |
|---|---|---|
| 0 | Front cover | Page 1 (spread 1 left) |
| 1 | Page 2 (spread 1 right) | Page 3 (spread 2 left) |
| 2 | Page 4 (spread 2 right) | Page 5 (spread 3 left) |
| 3 | Page 6 (spread 3 right) | Page 7 (spread 4 left) |
| 4 | Page 8 (spread 4 right) | Back cover |

共 5 张物理纸、8 个内页、2 个封面、6 个 chapter 状态。

`chapters = ["Cover", "A Little Light", "Looking Together", "Over the Wall", "Lights at Home", "The End"]`

## 排版及资源

manifest 的路径相对于本目录。所有 art/*.png 均缺失；额外 identity reference 也未生成。没有可安装的完整书包。

生成并检查原图后，使用本 skill 的 `scripts/build_book.py`。输出 1024×1400 SVG 页面，嵌入真实栅格原图；插画位于 (0,0,1024,900)，居中裁切。正文在 x=80…944 范围，44px 字体、60px 行距、最多 6 行；封面 64px、最多 5 行。文字独立排版，超出时拒绝，不截断、不自动缩小。保留 manifest 原文。每个内页的 number/label/text/image 由 helper 生成；封面带 cover/title/text/image，封底另带 end。

## 后续命令（安装未执行）

```bash
python3 /Users/wileyzhang/Code/voice_book/skills/children-storybook/scripts/build_book.py /Users/wileyzhang/Code/voice_book/skills/children-storybook-workspace/iteration-1/eval-1/with_skill/outputs/manifest.json --check
python3 /Users/wileyzhang/Code/voice_book/skills/children-storybook/scripts/build_book.py /Users/wileyzhang/Code/voice_book/skills/children-storybook-workspace/iteration-1/eval-1/with_skill/outputs/manifest.json --output /Users/wileyzhang/Code/voice_book/skills/children-storybook-workspace/iteration-1/eval-1/with_skill/outputs/book-package
```

完整 build 前必须补齐并目视检查全部 10 张 artwork，reference 另计；book-package 必须为全新目录。先检查合成页面，再将 `book-package/public/stories/milo-and-the-little-light-v1/` 复制到项目同路径（若已存在则使用新 story ID）。将现有 src/content.js 备份到本工作目录内带时间戳的文件，再以 book-package/content.js 替换它。不修改 main.js、翻页、摄像机、UI 或部署设置。保留旧书目录，便于恢复备份内容。

## 验证与当前限制

本轮仅执行 helper --check，结果见 check.txt；missing artwork 是计划状态，不是完成插画。未运行 full build、npm build 或浏览器视觉检查，因为没有图片且要求不修改应用。

将来安装后运行 `npm run build` 和现有有意义的交互测试；在浏览器 1366×768 与 844×390 横屏逐一核对 cover、每跨页和 back cover。检查图片加载、书页背面文字方向、正文实际可读性、长标题换行、裁切/书沟、拖动/点击与 chapter 数量。若字体不可读，改排版或缩短文字后重新验证。测试若硬编码旧章节名称，仅修改内容相关期望。自动 schema 检查不等于图片质量或浏览器渲染通过。
