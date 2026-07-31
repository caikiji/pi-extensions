# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions。

## 扩展列表

| 扩展 | 说明 |
|------|------|
| handoff | 按目标提取当前会话关键上下文，生成可编辑的提示词并开新会话（相比 compact：针对性强、可审阅、父会话保留可回溯） |

## 安装

作为 pi package 安装：

```bash
# 本地路径
pi install /path/to/pi-extensions

# git 仓库
pi install git:github.com/caikiji/pi-extensions

# 仅安装到项目
pi install -l git:github.com/caikiji/pi-extensions
```

临时测试单个扩展：

```bash
pi -e ./extensions/handoff.ts
```
