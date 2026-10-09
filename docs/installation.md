# 安装与开发

当前正式接线与回归环境是 Windows 上的 DeepSeek Harness Desktop **0.2.0-rc.2**。新版 DSH 发布后，需要重新核对宿主服务和插件接口；版本号相近不代表已经兼容。

## 已安装用户

关闭并重新打开 DSH，在新会话的模式列表选择“新工头模式”。插件使用 DSH 自带的本机验证服务，无需启动 Docker。

模型和账号使用 DSH 当前配置；先确保普通聊天可以正常使用该模型。

## 在另一台机器安装

本仓库提供源码及受保护的发布工具，目前不是克隆后自动启用的一键安装包。每台机器需要配置 DSH profile、工作区保护、宿主服务，并验收后生成与该机器实际安装包匹配的发布凭据。不要复制另一台机器的批准文件。

维护者的流程：

1. 选择实际 DSH runtime，准备并验证依赖。
2. 运行离线回归；核对实际宿主的会话、用户确认、模型、文件与验证服务。
3. 用 `scripts/stage-release.mjs` 生成只读候选文件及哈希。
4. 停止 DSH 后，先审查 `scripts/upgrade-local-rc2.mjs desktop-plan`，再执行对应的受保护升级。
5. 用 `scripts/prepare-desktop-release.mjs plan` 审查配置、模型选择、验收证据和哈希；通过审核后 apply，并独立核验批准与实际宿主。

本机后端配置是 `verification: { backend: "native" }`。工具不会仅凭一个 `readyForProjects: true` 配置跳过验收。完整接口和回滚顺序见[工程说明](engineering.md)。

## 开发测试

需要可用的 Node.js、DSH runtime、React/ReactDOM 和 Windows 锁实现所需的 `koffi`。测试应与实际宿主使用同一份 `@deepseek-ai/dsh-scope`，避免多个作用域实例造成错误结论。

```powershell
$env:DSH_TEST_INSTALL = '实际 DSH 包目录'
$env:DSH_RUNTIME_ROOT = '实际 DSH runtime 根目录'
node --test test/*.test.mjs
```

环境变量应指向真实存在的目录，上面是占位示例。开发脚本中的 `C:/example/...` 是示例路径，不指向任何维护者的机器。使用前按实际安装位置配置运行时、测试目录与启动脚本。核心离线测试不需要模型密钥或付费推理。

运行实际模型联调脚本前，须单独准备对应的隔离测试项目和授权范围；这些脚本不是安装的必经步骤，不应直接用于现有工作项目。
