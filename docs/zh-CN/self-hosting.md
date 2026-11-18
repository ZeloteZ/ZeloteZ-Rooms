# 自行托管

[English](../self-hosting.md) · [Deutsch](../de/self-hosting.md) · [简体中文](self-hosting.md)

[文档](README.md) · [配置](configuration.md) · [管理](administration.md) · [运维](operations.md)

## 选择部署方式

使用 [deploy/compose.image.yaml](../../deploy/compose.image.yaml)，在一个容器中运行 Rooms，并用两个持久卷保存应用数据和临时观影媒体。官方镜像 `ghcr.io/zelotez/zelotez-rooms` 已公开，支持 `linux/amd64` 和 `linux/arm64`；下载不需要 GitHub 账户或镜像仓库登录。

## 系统要求

- Linux Docker 主机，安装 Docker Engine 28 或更高版本及 Docker Compose 2.24.4 或更高版本。
- 单容器镜像要求 Linux Landlock ABI 3 或更高版本，且容器 seccomp 策略允许相关系统调用。Linux 6.2 或合适的回移版本提供该 ABI，但内核配置和容器策略同样重要。启动检查会在不满足条件时失败。不要通过删除角色隔离来绕过检查。
- 使用与 Docker 主机架构匹配的镜像（`linux/amd64` 或 `linux/arm64`）。
- 足够的存储，用于持久应用数据、加密聊天附件、上传图片和临时观影视频。单容器默认限制为 4 个 CPU、3 GiB 内存和 512 个进程；这些是上限，并非经过测量的最低需求。
- 公开实例还需要 DNS、HTTPS 反向代理和可达的媒体端口。Docker 或 Docker socket 访问权属于具有较高权限的管理访问。

## 在 Docker 主机上首次启动

下载并解压[仓库文件](https://github.com/ZeloteZ/ZeloteZ-Rooms/archive/refs/heads/main.zip)，然后在 Docker 主机上打开解压后的仓库根目录。以下命令使用该目录中随附的部署文件：

```sh
mkdir -p deploy/tls
```

对于**新安装**，创建权限受限的 `.env`，填写以下值。如果 `.env` 已存在，应先检查并修改目标值，不要直接覆盖。仓库中的 `.env.example` 是公开服务器示例，不能不加修改就用于本机回环测试。

```dotenv
ROOMS_IMAGE=ghcr.io/zelotez/zelotez-rooms:latest
PUBLIC_ORIGIN=http://127.0.0.1:8080
WEB_PORT=8080
INGEST_IP=127.0.0.1
VOICE_ICE_IP=127.0.0.1
VOICE_ICE_HOST=127.0.0.1
TRUST_PROXY_IP=0
```

```sh
chmod 600 .env
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml config --quiet
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml pull
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml up -d --wait
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml exec -T rooms node bootstrap.mjs --setup-key
```

在 **Docker 主机上打开 http://127.0.0.1:8080**。输入终端中的设置密钥，创建所有者账户，扫描二维码并确认六位验证码以配置身份验证器。如果在注册前关闭浏览器，同一个设置密钥仍然可用。注册完成后，首次设置会永久关闭。在此之前请保护好终端显示的密钥。

此回环配置适用于同一主机上的浏览器。SSH 转发可以私下访问网页，但仅转发 8080 端口不会转发 WebRTC 媒体。远程成员和生产环境应使用下面的公开配置。应在创建生产账户前确定 `PUBLIC_ORIGIN`；浏览器身份存储和原生客户端与所选源地址关联。

## 发布 HTTPS 实例

选择规范源地址，例如 `https://rooms.example.com`，不要附加路径、查询参数或片段。在反向代理上配置 HTTPS，并将请求转发到 Docker 主机的回环 Web 端口。另一个容器中的反向代理拥有独立的回环接口；应使用可达的 Docker 网络地址并配置准确的可信对端，不要假定 `127.0.0.1` 指向宿主机。

首次公开启动前修改 `.env`：

```dotenv
ROOMS_IMAGE=ghcr.io/zelotez/zelotez-rooms:latest
PUBLIC_ORIGIN=https://rooms.example.com
WEB_PORT=8080
TRUST_PROXY_IP=1
VOICE_ICE_HOST=203.0.113.10
VOICE_ICE_IP=0.0.0.0
VOICE_ICE_PORT=8189
INGEST_IP=127.0.0.1
```

将文档示例地址 `203.0.113.10` 替换为客户端真正能够直接访问的主机名或 IP。使用 NAT 时，应将配置的 UDP 和 TCP 媒体端口转发到 Docker 主机。网站的 HTTP/CDN 代理不会自动代理这些媒体连接。

反向代理必须：

- 保留公开主机信息，并在源地址根路径提供 Rooms，而不是挂载到 URL 子目录。
- 当 `TRUST_PROXY_IP=1` 时，用验证过的客户端地址覆盖 `X-Real-IP`，不得原样信任客户端提交的值。
- 保留应用响应头，包括 `X-ZeloteZ-Rooms-Client`，并支持持续响应。不要缓存需要登录的 API、事件流和私有媒体。
- 允许观影视频上传路由接收 4 MiB 请求体，并允许应用支持的附件和图片请求。内置网关已有按路由区分的限制，外层代理不能再施加更小的全局限制。
- 保持回环 Web 监听器私有，只开放真正需要的 HTTPS、媒体和推流端口。

单容器镜像在启用代理信任时，默认信任回环地址和检测到的 Docker 网桥网关。使用其他网络结构时，将准确的对端 IP 填入 `ROOMS_TRUSTED_PROXY_IPS`，以逗号分隔；不接受 CIDR 或主机名。详见[配置](configuration.md)。

重新执行上面的显式 Compose `config`、`up` 和 `--setup-key` 命令，然后打开 HTTPS 源地址。非回环源地址、安全浏览器捕获和受支持的桌面连接流程都要求 HTTPS。

## 可选的原生 RTMPS 推流

公开的浏览器 WebRTC 共享不需要公开 RTMPS 监听器。原生 RTMP 发布（包括 Linux 原生桌面辅助程序）需要可达的 RTMPS 端点，以及有效且匹配的证书。

将完整证书链放在 `deploy/tls/fullchain.pem`，私钥放在 `deploy/tls/privkey.pem`。镜像以 UID/GID 1000 运行，必须能读取这两个文件；请使用所有者、组权限或 ACL，不要将私钥设为所有人可读。该目录不得加入 Git。随后添加：

```dotenv
INGEST_IP=0.0.0.0
INGEST_PORT=1936
STREAM_INGEST_BASE=rtmps://rooms.example.com:1936
RTMPS_CERT_DIR=./deploy/tls
```

将 TCP 1936 或选定的宿主机推流端口直接开放或转发到 Docker 主机。配置的推流主机名必须与证书匹配。HTTPS 模式下，如果显式指定了推流基地址却没有两个可读的 TLS 文件，单容器镜像会启动失败。若既没有证书文件也没有显式推流地址，则关闭 RTMP，但浏览器共享仍可使用。续期证书后，重启或重新创建服务，让 MediaMTX 读取新文件。

## 选择镜像版本或离线传输

将 `ROOMS_IMAGE` 设为要运行的已发布标签或不可变摘要。官方镜像公开下载，无需登录。`latest` 随当前发布版本变化；需要固定修订时，使用已发布的 SHA 标签或摘要。在重新创建服务之前，使用相同 Compose 参数拉取镜像。

若需离线传输，在已经拥有所选镜像的机器上导出：

```sh
docker image save ghcr.io/zelotez/zelotez-rooms:latest -o rooms-image.tar
```

传输归档后，在目标机器运行 `docker image load -i rooms-image.tar`，并将 `ROOMS_IMAGE` 设为载入的标签。保留匹配的镜像摘要、配置和许可证声明。

## 后续步骤

参照[管理指南](administration.md)创建成员邀请，阅读[配置参考](configuration.md)，并建立经过验证的[备份与升级流程](operations.md)。[安全说明](security.md)介绍信任模型，[故障排除](troubleshooting.md)用于解决启动和媒体问题。
