# video-timesheet-web

一个部署到 GitHub Pages 的纯前端工具站，用于在浏览器中按选定片段和每秒帧数提取视频帧，执行点选背景色 ChromaKey 扣像，并导出透明序列帧结果。

## 功能

- 本地上传视频，支持拖拽和点击选择
- 自动读取时长、分辨率、文件名
- 自定义每秒提取帧数、视频片段、列数和间距
- 参考帧取色，支持增强版与经典版 ChromaKey
- 可调容差、羽化、采样半径、边缘检测半径、去溢色强度
- 浏览器端生成透明序列表 PNG 和透明单帧 ZIP

## 本地运行

```bash
npm install
npm run dev
```

## 测试与构建

```bash
npm run test
npm run build
```

## GitHub Pages

仓库名固定为 `video-timesheet-web`，Vite `base` 已配置为 `/video-timesheet-web/`。

部署方式：

1. 在 GitHub 上手动创建一个公开空仓库 `video-timesheet-web`
2. 将本地仓库推送到 `main`
3. 在仓库 `Settings -> Pages` 中确认 `Build and deployment` 使用 `GitHub Actions`
4. 后续每次 push 到 `main` 都会自动触发部署

Pages 地址格式：[https://mowangblog.github.io/video-timesheet-web/](https://mowangblog.github.io/video-timesheet-web/)
