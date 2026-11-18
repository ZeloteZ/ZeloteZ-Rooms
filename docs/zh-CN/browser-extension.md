# YouTube 浏览器扩展

[文档目录](README.md) · [English](../browser-extension.md) · [Deutsch](../de/browser-extension.md)

可选扩展在 YouTube 视频页“分享”旁添加“创建 ZeloteZ 房间”，在你选定的 Rooms 实例上发起临时 YouTube 观影派对。它不会下载 YouTube 视频，也不绕过嵌入限制。

## 浏览器与安装

清单要求 Chromium 浏览器 **121 或更新版本**，以及 Firefox **140 或更新版本**。从公开的 GitHub 发布下载 [ZeloteZ-Rooms-YouTube.zip](https://github.com/ZeloteZ/ZeloteZ-Rooms/releases/latest/download/ZeloteZ-Rooms-YouTube.zip)。

| 浏览器 | 本地安装 |
| --- | --- |
| Chrome、Brave、Edge | 解压 ZIP，打开扩展管理器，开启“开发者模式”，选择“加载已解压的扩展程序”，选中包含 `manifest.json` 的目录。 |
| Firefox 140+ | 打开 `about:debugging` → “This Firefox” → “Load Temporary Add-on”，选择 ZIP 或解压的 `manifest.json`。 |

Firefox 本地安装是临时的，重启浏览器后需重新加载。永久安装需要 Mozilla 签名包；提供的 ZIP 使用临时安装方式。

官方步骤：[Chromium 加载解压扩展](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-an-unpacked-extension)、[Firefox 临时安装](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/)。

## 配置实例

1. 通过扩展工具栏图标打开设置。
2. 输入 Rooms 的 HTTPS 基础地址，例如 `https://rooms.example.com`，不含房间路径或查询参数。
3. 选择在当前浏览器或桌面应用中打开。
4. 按提示授予该实例的主机访问权限。
5. 重新加载已经打开的 YouTube 视频页。

请连接可信的实例，并在 Rooms 中正常登录。

## 分享视频

1. 打开 YouTube 视频页。
2. 点击“分享”旁的“创建 ZeloteZ 房间”。
3. 检查“允许持链接的访客加入”和“向成员显示在正在直播列表”。
4. 选择“在浏览器中打开”或“ZeloteZ Rooms Desktop”。

这两个访问选项默认开启。可以在扩展设置中保存其他默认值，或为单个视频调整。访客选项生成受密码保护的临时房间链接；成员选项控制已登录成员能否发现房间。详见[临时房间访问](streaming.md#发起临时房间)。

## 在浏览器中打开

扩展可以使用同一浏览器窗口中已打开且登录同一账户的 Rooms 标签页。如果需要新标签页，即使其他标签页已有会话，也可能需要登录或“解锁聊天”。然后在 Rooms 中确认视频。

普通 Rooms 权限及临时房间限制继续适用。同一账户不能同时拥有两个临时房间；请先返回或结束已有房间。

## 在桌面应用中打开

安装并手动启动 [ZeloteZ Rooms Desktop](desktop.md)一次。扩展与客户端必须连接到完全相同的 Rooms origin。

Linux 下将 AppImage 标记为可执行，并从长期存放位置启动，以注册 `zelotez-rooms:` 处理程序。移动文件或更新后重新启动新文件。只有准备打开 Rooms 时才批准浏览器打开外部应用的提示。

兼容的桌面客户端确认接收后，交接标签页会关闭。Web/Desktop **0.1.22+** 支持访问范围选项；基于回执关闭标签页需要 **0.1.25+**。如果系统仍选用旧客户端处理链接，可使用“打开旧版桌面应用”、更新处理程序，或“在浏览器中继续”。

## 权限与数据存储

扩展请求 `storage` 和 `scripting`，在 YouTube 页面运行内容脚本，并请求你配置的 Rooms 实例的可选主机访问权限。实例地址、打开目标和访问默认值保存在本机。

你点击分享时，它会向 Rooms 传递选定的 YouTube 视频 ID 和访问选项。Firefox 清单声明 **browsingActivity**，因为当前视频 ID 标识了所分享的视频。扩展不请求 Cookie 读取权限、不读取账户密码，也不维护观看历史数据库。同源 Rooms 请求使用现有浏览器会话，登录由 Rooms 自身处理。

桌面交接回执使用短期随机 ID，不含 Cookie、账户信息或视频 ID。YouTube 仍直接为观看者提供其播放器和视频媒体。详见[隐私与外部服务](security.md)。

## 更新或移除

对于 Chromium 解压安装，用目标版本替换提取文件，再在扩展管理器重新加载。Firefox 临时插件则按需重新安装/加载。更新后刷新 YouTube 标签页。可在浏览器扩展管理器禁用或移除。

按钮未出现或交接失败时，检查实例地址、主机权限、Rooms 登录/解锁状态及协议兼容性。详见[故障排查](troubleshooting.md)。

## 许可证

扩展采用 [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0)。分享下载副本时，请保留附带的 `LICENSE` 和 `NOTICE`。超出许可证允许范围的商业使用需另行授权；第三方组件仍使用各自条款。详见[项目许可](../../LICENSING.md)。
