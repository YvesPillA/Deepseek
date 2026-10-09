# 新工头模式

DeepSeek Harness 的项目协作模式：**执行代理负责做，监督代理负责验收，你负责确认目标和最终交付。**

适合需要分阶段实现、独立审查和持续返工的项目。简单任务也可以只设一个里程碑。

## 怎么工作

| 角色 | 职责 |
| --- | --- |
| 外层主代理 | 与你确认开局、处理重大问题、提交最终成果 |
| 执行负责人和执行者 | 规划里程碑、分配任务、实现与验证 |
| 监督者 | 每人负责一个方面，独立提出问题和验收要求 |

1. 在 DSH 选择 **新工头模式**，描述目标，调整并确认监督名单。
2. 执行模块推进任务。规划和阶段验收均需全体监督者通过；不通过就返工。
3. 最终验收通过后，由你确认交付。进度和待处理问题可以在侧栏面板查看。

默认每完成 **3 个任务**巡检一次；同一里程碑累计第 **3 轮否决**后暂停，请你裁决。其他不依赖它的里程碑可继续。执行模块不能修改监督规则。

## 使用与环境

- 当前验证环境：**Windows + DeepSeek Harness Desktop 0.2.0-rc.2**。
- 使用 DSH 自带的本机验证能力，**不需要启动 Docker**。
- 已安装用户重新打开 DSH 即可使用。新机器安装与开发入口见[安装说明](https://github.com/YvesPillA/Deepseek/blob/main/docs/installation.md)。
- 归档、删除记录与内部会话的处理方式见[使用说明](https://github.com/YvesPillA/Deepseek/blob/main/docs/usage.md)。

本机验证是部分写限制，不隔离读取和网络；其他宿主版本和复杂工具链需要另行验证。模型推理时间仍会影响速度。

## 更多说明

- [效率优化与参考资料](https://github.com/YvesPillA/Deepseek/blob/main/docs/efficiency.md)
- [架构、验证边界与回滚](https://github.com/YvesPillA/Deepseek/blob/main/docs/engineering.md)

仓库仅包含插件源码、测试和开发工具，不包含账号密钥、用户会话、工作项目或本机发布凭据。
