# Jev-cu OmO 分支

本仓库是 Sac-Y/Jev-cu 的正式 GitHub fork。保留上游 TypeSafe Jev 决策引擎，
增加 OmO extension 和 macOS cua-driver CLI 适配。不使用 Jev-like 模型、服务或回退。

技术栈：Node.js ESM、node:test、OmO registerTool、现有 cua-driver CLI、
TypeSafe System One HTTP API。无需新增运行时依赖。

当前模块：OmO 原生 macOS CUA 集成。模型只接收必要的 AX 文字；截图保留在本地。
先在独立 OmO 配置、会话和证据目录验证，验证前不修改生产配置。
