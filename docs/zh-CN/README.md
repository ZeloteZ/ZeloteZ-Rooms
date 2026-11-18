# ZeloteZ Rooms 文档

[English](../README.md) · [Deutsch](../de/README.md) · [简体中文](README.md) · [项目简介](../../README.zh-CN.md)

请根据你要完成的任务选择指南。本文档描述当前查看的源码版本；已安装的发行版可能有所不同。德语、英语和简体中文文档涵盖相同主题。

## 使用 Rooms

| 指南 | 内容 |
| --- | --- |
| [入门](getting-started.md) | 接受邀请、创建账户、选择语言并加入你的群组。 |
| [用户指南](user-guide.md) | 房间、频道、好友、加密消息、文件、管理、通知和外观。 |
| [直播与观影派对](streaming.md) | 分享屏幕或视频、使用语音、邀请访客、选择播放模式和理解统计信息。 |
| [桌面应用](desktop.md) | Windows 和 Linux 安装、屏幕与音频采集、设置和更新。 |
| [浏览器扩展](browser-extension.md) | 安装扩展、设置访问范围，以及在浏览器或桌面应用中打开观影派对。 |
| [ZeloteZ Vault](vault.md) | 私有加密文件、文件夹、共享、存储限额及可选的文件管理器集成。 |

创建成员账户需要 Rooms 实例运营者的邀请。安装客户端本身不会创建账户，也不会运行服务器。

## 部署和管理实例

| 指南 | 内容 |
| --- | --- |
| [自行部署](self-hosting.md) | 环境要求、获取镜像、首次启动、HTTPS、媒体端口和公网访问。 |
| [配置参考](configuration.md) | Compose 变量、网络绑定、存储、运行时选项和组件配置。 |
| [管理](administration.md) | 所有者设置、邀请、账户、MFA、密码和控制台恢复。 |
| [运行维护](operations.md) | 健康检查、日志、备份、数据恢复、更新和回滚。 |

建议从部署指南中的单容器方案开始。在 Windows 或 macOS 上使用 Docker Desktop，并不代表其 Linux 内核和运行时一定满足隔离要求。

## 安全与帮助

| 指南 | 内容 |
| --- | --- |
| [安全与隐私](security.md) | 加密范围、可读元数据、信任边界、本地密钥和恢复限制。 |
| [故障排查](troubleshooting.md) | 根据症状进行检查，并查找相应处理步骤。 |

## 许可证与贡献

Rooms 以 [PolyForm Noncommercial 1.0.0](../../LICENSE) 提供源码，具体范围见[许可说明](../../LICENSING.md)。第三方组件仍遵循自己的许可证。提交代码或其他项目材料之前，请阅读 [CONTRIBUTING.md](../../CONTRIBUTING.md) 和 [CLA.md](../../CLA.md)。

## 文档约定

- 除非明确切换目录，否则在仓库根目录执行命令。
- 将示例域名、地址、镜像标签和路径替换成你自己的实例配置。
- 推荐部署使用 `deploy/compose.image.yaml` 中的 `rooms` 服务。
- 管理和维护时，使用与安装时相同的 Compose 项目、环境文件和数据卷。
- 各语言版本保留相同的技术文件名、命令、环境变量和协议名称。
