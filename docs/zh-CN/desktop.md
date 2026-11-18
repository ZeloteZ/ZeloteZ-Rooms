# 桌面客户端

[文档目录](README.md) · [English](../desktop.md) · [Deutsch](../de/desktop.md)

桌面客户端为 Rooms 提供系统集成、捕获控制、可选通知和受保护的登录存储。仍需要可信 Rooms 实例的地址及该实例上的账户。

## 可用安装包

官方客户端提供 **Windows x64** 和 **Linux x64** 包。服务器镜像支持 arm64，并不表示桌面客户端也提供 arm64 安装包。当前没有配置官方 macOS 安装程序。

从 [GitHub 最新发布](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest)下载，或在 Rooms 中选择头像旁的“客户端”。

### Windows

运行 `ZeloteZ-Rooms-<version>-x64.exe` 并完成安装。只在准备使用相关功能时允许捕获和麦克风权限。“系统音频”支持 Windows 10/11；“应用音频”需要 Windows 11。先让目标应用播放声音，它的输出才能出现在列表中。

实验性的 Rooms Capture 后端需要 Windows 10 1903 或更新版本和兼容 D3D11 的显卡。程序会检测后端可用性，实际捕获和性能仍取决于硬件与系统支持。

### Linux AppImage

把 `ZeloteZ-Rooms-<version>-x86_64.AppImage` 放到准备长期保留的位置，赋予执行权限并运行：

```sh
chmod +x /path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
/path/to/ZeloteZ-Rooms-VERSION-x86_64.AppImage
```

把 `VERSION` 替换为下载的版本，并替换为实际文件路径。

Wayland 需要 PipeWire 以及当前桌面的 ScreenCast 门户后端，例如 GNOME 或 KDE。还需满足发行版的 AppImage 运行要求。Rooms 必须启用 Chromium 沙箱；不要通过添加 `--no-sandbox` 解决启动失败。请更新带有该参数的旧启动项，并按发行版说明检查此应用的非特权用户命名空间策略。

## 连接实例

1. 输入 HTTPS 基础地址，例如 `https://rooms.example.com`，不要附带房间路径。
2. 选择“检查地址”，核对结果后确认连接。
3. 使用该实例上的账户登录。
4. 打开房间，即可使用与浏览器相同的聊天和媒体功能。

地址检查验证客户端能否访问所选的 HTTPS 实例。仍应选择你信任的运营者。

## 设置、通知和关闭窗口

通过应用菜单或 **Ctrl+,** 打开“桌面设置”。Windows/Linux 可用 **Alt** 显示菜单。本地设置包括实例连接、可选系统通知、窗口关闭行为和更新检查。

默认关闭窗口时会询问在后台运行还是退出。“不再提示”会让之后的关闭操作自动最小化；可在设置中修改。通过系统托盘、菜单或任务栏恢复客户端，具体方式取决于桌面环境。后台运行与通知展示也受桌面支持影响。

通知可包括好友请求、私聊、提及和已开启的直播提醒。禁用系统通知时，应用内铃铛仍可使用。

## 登录存储

“在此设备上保持登录”使用受保护的系统存储保存会话与聊天解锁材料，直到会话过期或退出登录。这与仅保持普通浏览器会话打开不同。

Linux 下仅接受由系统后端保护的加密存储，会拒绝 Chromium 的固定密钥回退方式。密钥环被锁定或安全存储不可用时，请手动登录；保持登录功能可能不可用。各实例的数据按其 origin 隔离。共享或不可信设备上使用后应退出登录。

## 捕获和音频

在有直播权限的频道选择“分享屏幕”，选定屏幕、窗口或区域，批准系统选择器，设置质量与音频后开始。区域模式在预览中框选矩形。有嵌入预览支持时，Linux 原生捕获窗口会在开始后隐藏，主直播频道显示预览、时长、分辨率、FPS、上传率和停止按钮；否则捕获助手使用自己的窗口。

Linux 的应用和系统音频使用 PipeWire 输出。先播放目标应用再选择它。AppImage 的 PipeWire 音频路径需要 `pw-dump` 和 `pw-record`。所选输出断开时，停止并选择可用输出后重新开始。

“Standard”为默认引擎，实验性“Rooms Capture”只在后端可用时出现。[直播指南](streaming.md)说明质量目标、统计、限制及直接/缓冲播放。

### 可选 Linux 原生助手

需要 Python GObject/Cairo、GTK 4、Libadwaita、带 GTK 4 支持的 libportal、PipeWire、GStreamer，以及捕获和编码插件。原生依赖不可用时，AppImage 使用自身内置的捕获方式。

CachyOS/Arch Linux 的 GNOME 环境可安装以下依赖：

```sh
sudo pacman -S --needed python-gobject python-cairo gtk4 libadwaita libportal libportal-gtk4 \
  pipewire gst-plugin-pipewire xdg-desktop-portal xdg-desktop-portal-gnome \
  gstreamer gst-plugins-base gst-plugins-good gst-plugins-bad gst-plugins-ugly \
  gst-plugin-gtk4 gst-libav glib-networking ca-certificates
```

KDE Plasma 请将 GNOME 门户后端换为 `xdg-desktop-portal-kde`。其他发行版的包名不同，请安装对应组件，不要直接复制其他发行版命令。相关包参考：[Arch 的 gst-plugin-gtk4](https://archlinux.org/packages/extra/x86_64/gst-plugin-gtk4/)。

助手检查的 GStreamer 元素包括 `pipewiresrc`、`gtk4paintablesink`、`x264enc`、`h264parse`、`flvmux` 和 `rtmp2sink`；音频另需 AAC 编码器。Linux 原生发布使用 CPU x264，并通过系统信任存储验证 RTMPS 服务器证书。

## 浏览器扩展链接

先启动已安装客户端一次，并连接到与 [浏览器扩展](browser-extension.md)完全相同的 Rooms origin。Linux 下需从长期存放位置启动可执行 AppImage，以建立或更新菜单项和链接处理程序。移动文件或更新为新文件后，请重新启动一次。

支持 XDG 链接处理的桌面上，如果没有默认处理程序，Rooms 会注册 `zelotez-rooms:`，并合并识别到的旧 AppImage 启动项。如果已选择其他程序，请在系统链接设置中选择 Rooms，或使用扩展中的“在浏览器中继续”。

## 更新客户端

更新检查默认**关闭**。在“桌面设置 → 桌面更新”中开启，可选择每 1、6、24 或 168 小时检查。客户端不携带凭据查询官方公开 GitHub Release API，比较版本后在浏览器打开发布页，不会自动静默替换应用。

检查失败可能来自离线、请求频率限制或无效发布元数据；可手动打开发布链接。如果客户端需要新版实例协议，应一起更新服务器与网关。客户端和服务器更新是独立操作。

## 验证下载

官方桌面发布提供 SHA-256 校验文件和 Ed25519 签名的安装包清单。获取 `desktop-release-manifest.json`、`desktop-release-manifest.sig`、安装包，以及独立可信的[发布公钥](../../desktop/release-public.pem)副本。从源码仓库运行：

```sh
python3 deploy/desktop-release-signature.py verify VERSION \
  --source /path/to/downloads --trusted-key /path/to/trusted-public.pem --platform linux
```

Windows 安装包使用 `--platform windows`。将 `VERSION` 替换为目标数字版本，不含开头的 `v`。

Windows 上可通过 `openssl pkeyutl -verify -pubin -rawin -inkey public.pem -in desktop-release-manifest.json -sigfile desktop-release-manifest.sig` 验证签名，再比较安装包的准确文件名、大小和 SHA-256（`Get-FileHash -Algorithm SHA256`）与已验证的清单。只比较来自同一不可信来源的校验和不能证明真实性。桌面签名清单不覆盖浏览器扩展 ZIP。
