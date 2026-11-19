<div align="center">

<img src="../mobile/assets/icon.png" alt="Kite" width="96">

# Kite

**基于 Kettu 的个人构建：桌面端 Kite、手机端纸鸢，加上自己的云服务。**

[English](#english) · [上游 Kettu](https://github.com/KettuAI/Kettu) · [许可证](../LICENSE)

</div>

Kite 是 [Kettu](https://github.com/KettuAI/Kettu) 的个人分支：把 Claude Code、Codex 等编码 Agent 放在一个窗口里用，
并在上面补了日常要用的东西。官方 Kettu 的更新每天自动合进来；与官方不同的地方都标着 `Huli:`，
清单在 [`tools/huli/README.md`](../tools/huli/README.md)。

## 和官方 Kettu 不一样的地方

- **自己的云服务 Kite Cloud**：账号、中转、推送和网页版都跑在自己的服务器上，更新也从自己的渠道下发并验签。
- **手机端纸鸢**：iOS 和 Android，能看会话、发消息、处理请求，有实时活动和小组件。
- **Agent 的网络**：导入机场订阅，给每个 Agent 选节点或跟随默认，或者只让它从选定的网卡出去；节点或网卡断了就断网，不会绕路。
- **从别处搬过来**：从 Kettu 导入会话、记忆和 Artifacts，从各 Agent 批量导入历史会话和 Codex 的记忆。
- **Codex**：速度档位、额外积分余额和重置卡、按轮撤销。
- **Claude Code**：输入建议、并发上限、可自定义的入口标识。
- **浏览器**：Agent 可以在你同意后往网页上传文件。
- **macOS 版签名并公证**，能自己更新。

## 构建

见 [`tools/huli/README.md`](../tools/huli/README.md)。各平台由 GitHub Actions 构建（`huli-build.yml`），
每晚的 `huli-sync.yml` 合并官方 Kettu 的 main。代码公开，安装包不公开：构建只发到自己的更新渠道，
GitHub 上的 Release 只有说明、没有附件。iOS 在 TestFlight 内部测试，也以 Ad Hoc 签名发到更新渠道，只有登记过的设备能装。

## 许可证

和 Kettu 一样，以 [AGPL-3.0](../LICENSE) 发布，附带 [LICENSE-EXCEPTION](../LICENSE-EXCEPTION) 中的额外许可。
Kettu 的名称和标志属于其作者；Kite 与 KettuAI 没有关联。

---

<a id="english"></a>

## English

Kite is a personal fork of [Kettu](https://github.com/KettuAI/Kettu), the desktop GUI for coding agents, with
its own cloud (accounts, relay, push and a web client), a phone app for iOS and Android, per-agent network
routing through proxy nodes or a chosen network interface that fails closed, imports from Kettu and from the
agents' own histories, extra Codex and Claude Code controls, and a signed, self-updating macOS build. Upstream
is merged nightly; every difference is marked `Huli:` and listed in [`tools/huli/README.md`](../tools/huli/README.md).
The code is public; the builds are not: they go only to Kite's own update channel, and the GitHub
releases carry notes, not files. Licensed under [AGPL-3.0](../LICENSE) with the [additional permission](../LICENSE-EXCEPTION) Kettu grants. Not
affiliated with KettuAI.
