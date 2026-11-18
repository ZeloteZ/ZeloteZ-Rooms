# 运维、备份与升级

[English](../operations.md) · [Deutsch](../de/operations.md) · [简体中文](operations.md)

[文档](README.md) · [自行托管](self-hosting.md) · [配置](configuration.md) · [管理](administration.md)

本页命令适用于**单镜像方案**。在仓库根目录执行，使用与首次部署相同的 `.env`、Compose 项目和数据卷配置。

## 检查服务

```sh
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml ps
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml logs --tail 100 rooms
docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml images
```

镜像健康检查测试本地 Web 网关和媒体信令监听器。健康状态并不证明外部 DNS、HTTPS、NAT、浏览器权限和客户端媒体路径都正常。变更后，应从真实客户端验证登录、一次浏览器直播、语音和可选原生推流。

容器统一管理子进程：API、网关或 MediaMTX 意外退出会停止服务，随后由 Docker 应用重启策略。应寻找最早的错误，而非只看最后一次重启消息。Compose 配置了日志保留上限；在日志轮换前保存相关信息，分享前删除账户或链接秘密。

## 哪些数据持久保存，哪些会随重启结束

- `/data` 包含 `community.sqlite` 及相关 SQLite 文件、账户/MFA 状态、加密历史与附件、头像和房间图片、首次设置状态。应备份整个卷，而非仅复制 `.sqlite` 文件。
- `/watch-data` 包含临时上传的观影视频。派对状态位于内存；启动会清理孤立的派对视频文件。该卷不是持久视频媒体库。
- 活跃直播、语音连接、观影播放/队列和临时直播聊天消息可能在重启时结束。临时房间记录依赖活跃媒体，来源不再活跃时会被清理，不能当作永久保存的房间。维护前应通知正在使用的成员。
- `.env`、Compose 覆盖配置、可选 TLS 文件、反向代理配置、所选镜像标签和摘要不在这些卷内，必须单独保留。

普通 Compose `down` 会保留命名卷，但卷名称或项目变更仍可能挂载另一套空数据库。常规维护不要使用删除卷的选项。应先检查实际挂载，再判断数据位置。

## 备份已停止的实例

此流程需要停机，以保持 SQLite 与文件的一致性。停止服务前，应确保辅助镜像已可用。流程只创建归档，不会删除或替换现有数据卷。

先为当前 Shell 定义一致的 Compose 调用，创建权限受限的绝对备份目录，并确定实际挂载的卷：

```sh
rooms() { docker compose --project-directory . --env-file .env -f deploy/compose.image.yaml "$@"; }
backup_dir="$HOME/rooms-backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
chmod 700 "$HOME/rooms-backups" "$backup_dir"
container_id=$(rooms ps -aq rooms)
test -n "$container_id"
data_volume=$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')
watch_volume=$(docker inspect "$container_id" --format '{{range .Mounts}}{{if eq .Destination "/watch-data"}}{{.Name}}{{end}}{{end}}')
test -n "$data_volume" && test -n "$watch_volume"
docker pull alpine:3.24
rooms config > "$backup_dir/compose.resolved.yaml"
cp .env "$backup_dir/rooms.env"
docker inspect "$container_id" > "$backup_dir/container.json"
rooms stop rooms
```

随后归档每个卷，保留所有者和文件权限：

```sh
docker run --rm --network none --read-only --security-opt no-new-privileges \
  --mount "type=volume,src=$data_volume,dst=/source,readonly" \
  --mount "type=bind,src=$backup_dir,dst=/backup" \
  alpine:3.24 tar -C /source -czf /backup/application.tar.gz .
docker run --rm --network none --read-only --security-opt no-new-privileges \
  --mount "type=volume,src=$watch_volume,dst=/source,readonly" \
  --mount "type=bind,src=$backup_dir,dst=/backup" \
  alpine:3.24 tar -C /source -czf /backup/watch-media.tar.gz .
rooms start rooms
rooms ps
tar -tzf "$backup_dir/application.tar.gz" > /dev/null
tar -tzf "$backup_dir/watch-media.tar.gz" > /dev/null
```

若归档步骤失败，应保持卷完整，解决备份问题，并在合适时显式启动服务。将 TLS 文件、反向代理和覆盖配置按实际路径单独纳入私有备份集。把备份复制到独立且受保护的存储，并测试恢复。备份包含敏感账户状态、MFA 密钥、私有元数据和加密材料；聊天加密并不意味着备份可以公开。

## 恢复到新数据卷

应恢复到**全新、未使用的卷名**，以保留原始数据。先为当前 Shell 定义备份章节中的 `rooms` 函数，或将其替换为完整 Compose 调用，再停止目标服务。将 `backup_dir` 设为所选备份的绝对路径，验证来源和归档内容，然后选择不存在的卷名：

```sh
rooms stop rooms
backup_dir=/absolute/path/to/the/backup
restore_data=rooms-data-restore-20261118
restore_watch=rooms-watch-media-restore-20261118
if docker volume inspect "$restore_data" >/dev/null 2>&1; then exit 1; fi
if docker volume inspect "$restore_watch" >/dev/null 2>&1; then exit 1; fi
docker volume create "$restore_data"
docker volume create "$restore_watch"
docker run --rm --network none --read-only \
  --mount "type=volume,src=$restore_data,dst=/restore" \
  --mount "type=bind,src=$backup_dir,dst=/backup,readonly" \
  alpine:3.24 tar -C /restore -xzf /backup/application.tar.gz
docker run --rm --network none --read-only \
  --mount "type=volume,src=$restore_watch,dst=/restore" \
  --mount "type=bind,src=$backup_dir,dst=/backup,readonly" \
  alpine:3.24 tar -C /restore -xzf /backup/watch-media.tar.gz
```

归档辅助容器保留 Docker 默认 capabilities，以便读取应用私有文件，并恢复归档中的 UID/GID 和权限。备份源挂载为只读。不要恢复不可信的归档。

在目标 `.env` 中将 `ROOMS_DATA_VOLUME` 和 `ROOMS_WATCH_VOLUME` 改成两个恢复后的卷名。恢复匹配的实例设置、TLS 和代理配置，选择与备份匹配的镜像版本，检查 `rooms config`，再运行 `rooms up -d --wait`。切换真实用户前，应在隔离主机或私有网络使用**原本的规范 `PUBLIC_ORIGIN` 与 HTTPS 主机名**进行验证，并通过受控 DNS/hosts 路由和匹配的代理证书访问。账户凭据派生和浏览器身份存储与源地址绑定，将生产源地址改成回环地址不是有效的恢复账户登录测试。检查数据库访问、所有者 MFA/登录、房间权限、使用正确密码解密历史、附件和媒体。备份不能恢复未知的聊天解锁密码。

## 升级与回滚

1. 记录当前镜像 ID/摘要和发布版本，阅读变更，并在停止实例后创建备份。
2. 在 `.env` 选择目标已发布标签或摘要，并运行 `rooms pull`。
3. 保持相同项目、配置和数据卷。先运行 `rooms config --quiet`，再执行 `rooms up -d --wait`。
4. 检查健康状态与日志，并从客户端测试登录、加密/历史、附件、语音与视频。

简写的 `rooms` 命令依赖备份章节中的函数；否则请使用完整的显式 Compose 参数。升级和恢复流程验证完成前应保留旧镜像。旧程序可能无法理解新版本已迁移的数据库。若回滚需要旧数据库结构，应将升级前匹配的备份恢复到新卷，而不是让旧镜像直接访问已经修改的生产数据库。

使用与所选发布兼容的客户端和服务器版本。更新随附的单容器镜像会同时更新服务器和网关；桌面客户端和浏览器扩展需单独更新。

## 证书续期与访问恢复

替换配置的 TLS 目录中的 RTMPS 证书后，重启或重新创建 `rooms` 并验证原生推流。外层代理的 HTTPS 证书由其自身机制续期。若失去所有者访问，应使用[所有者恢复流程](administration.md)，不要通过删除数据卷来重新开放首次设置。
