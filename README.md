# video-timesheet-web

一个部署到 GitHub Pages 的纯前端工具站，用于在浏览器中把本地视频均匀抽帧，并拼成一张可下载的序列帧表 PNG。

## 功能

- 本地上传视频，支持拖拽和点击选择
- 自动读取时长、分辨率、文件名
- 自定义抽帧数量、列数、间距、背景色
- 可选在每一帧下显示时间戳
- 浏览器端生成预览并导出 PNG

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
