# video-timesheet-web

一个纯前端工具站，用来把本地视频转换成序列帧资源。  
当前版本支持浏览器内裁剪、按片段提帧、点选背景色抠图、导出精灵图、动画 GIF、透明单帧 ZIP，以及进一步生成 Spine 动画资源包。

在线地址：
[https://mowangblog.github.io/video-timesheet-web/](https://mowangblog.github.io/video-timesheet-web/)

## 主要能力

- 本地上传视频，支持拖拽和点击选择
- 浏览器内读取视频，不上传到服务器
- 鼠标框选裁剪区域，并支持数值微调
- 按视频片段和每秒提取帧数生成序列帧
- 点选背景颜色做 ChromaKey 抠图
- 预览普通序列图、透明序列图和动画播放效果
- 导出精灵图 PNG
- 导出动画 GIF
- 导出透明单帧 ZIP
- 导出 Spine `JSON + PNG ZIP`

## 当前工作流

页面当前按下面的步骤工作：

1. 上传视频
2. 画面裁剪
3. 提取帧
4. 参考帧与抠像预览
5. 序列图预览
6. 导出结果
7. Spine 动画工作区

说明：

- 不抠图也可以直接生成普通序列图
- 如果做了背景扣像，则导出会优先使用透明帧
- 精灵图导出默认保持 `0` 间距，避免资源切片后出现位置漂移

## 导出说明

### 1. 序列图 PNG

- 支持自定义列数
- 支持单帧尺寸预设：`原始比例 / 32×32 / 64×64 / 128×128 / 256×256`
- 使用 `Pica` 对单帧进行高质量缩放
- 默认适合做 sprite sheet / timesheet

### 2. 动画 GIF

- 自动从当前帧序列生成 GIF
- 未抠图时导出普通 GIF；已抠图时导出透明 GIF（单通道透明）
- 帧间隔会根据提帧时间自动计算

### 3. 透明单帧 ZIP

- 仅在完成背景扣像后可用
- ZIP 中每一帧都是单独 PNG
- 文件名会带序号

### 4. Spine ZIP

导出内容固定为：

- `skeleton.json`
- `images/*.png`
- `README.txt`

当前 Spine 导出策略：

- 单骨骼：`root`
- 单插槽：默认 `sprite`
- 单动画：默认 `idle`
- 通过 attachment timeline 逐帧切换图片
- 不生成 atlas
- 不生成 `.skel`
- 不生成 `.spine` 项目文件

适用场景：

- 快速把序列帧资源转成 Spine 可继续加工的基础动画包
- 先在网页里完成裁剪和抠图，再交给 Spine 做后续编辑

## 技术栈

- `Vite`
- `React`
- `TypeScript`
- `JSZip`
- `Pica`

全部处理都在浏览器端完成，没有后端。

## 本地开发

安装依赖：

```bash
npm install
```

启动开发环境：

```bash
npm run dev
```

本地默认地址通常是：

```text
http://localhost:5173/video-timesheet-web/
```

## 测试与构建

运行测试：

```bash
npm run test
```

构建生产版本：

```bash
npm run build
```

## GitHub Pages 部署

仓库名固定为 `video-timesheet-web`，Vite `base` 已配置为：

```text
/video-timesheet-web/
```

部署方式：

1. 仓库 `Settings -> Pages`
2. `Build and deployment` 选择 `GitHub Actions`
3. 后续每次 push 到 `main` 都会自动部署

最终地址：
[https://mowangblog.github.io/video-timesheet-web/](https://mowangblog.github.io/video-timesheet-web/)

## 使用建议

- 绿幕、蓝幕、纯白或纯色背景视频更适合当前抠图方式
- 如果要做游戏精灵图，建议导出时保持 `0` 间距
- 如果要继续进 Spine，建议先确认帧率和裁剪尺寸，再进入 Spine 工作区
- 长视频和高 FPS 会消耗更多浏览器内存，建议先缩短片段再处理

## 许可证

本项目使用 [GNU General Public License v3.0](./LICENSE) 进行授权。  
SPDX 标识：`GPL-3.0-only`
