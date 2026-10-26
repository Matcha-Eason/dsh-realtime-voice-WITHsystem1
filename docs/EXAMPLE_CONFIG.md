# 配置与排障

## Token Plan 默认值

在 DSH “左下角账号菜单 → 设置 → 内置插件 → 实时语音”设置语音服务。凭据由 Host 环境变量或 DSH credentials 服务提供，不能填入模型名或音色字段。

| 配置 | 默认值 |
|---|---|
| Host 凭据 | `BAILIAN_TOKEN_PLAN_API_KEY` |
| 服务 | `token-plan` |
| ASR | `qwen-audio-3.0-asr-flash` |
| TTS | `qwen-audio-3.0-tts-plus` |
| 音色 | `longanlingxin` |
| 决策模型 | `decision-model-preview` |
| 决策超时 | 2000 ms |
| 尾静音 | 700 ms |
| 续说合并 | 400 ms |
| 忙后草稿停留 | 700 ms |
| 语音自动发送 / 语义判断 / 主动澄清 | 开启 |
| 敏感指令手动发送 | 开启 |

尾静音、网络转写、续说窗口和决策各自有延迟，不能将某一个参数解释为整体响应时间。人声阈值设置仅用于 DashScope 原生实时 VAD；Token Plan 的 HTTP 适配器使用本地能量检测。

关闭语义判断后使用确定性的尾静音与续说窗口提交，主动澄清关闭。决策失败不会把模型错误当成回答播出。

## 可选 DashScope 实时语音

选择 `dashscope` 后，显式提供 `DASHSCOPE_API_KEY`，并将 ASR / TTS / 音色一起改为该服务支持的组合，例如原有的 `qwen3-asr-flash-realtime` / `qwen3-tts-flash-realtime` / `Chelsie`，同时配置区域与 Workspace ID。该线路保留协议测试，尚未用当前账号实测。仅切换服务下拉框不会替用户更换全部模型。

轮次决策仍使用 Token Plan 的 `BAILIAN_TOKEN_PLAN_API_KEY`。主模型独立由 DSH 模型选择器配置。

## 排障顺序

1. `npm run check` 确认代码与 DSH SDK 匹配。
2. `npm run check:bailian` 检查真实服务。它会调用套餐中的模型，但不会录音。
3. 在已授权的本地 DSH 页面访问 `/dsh-realtime-voice/status`，查看凭据是否配置，不会返回 Key。
4. 确认模型名与服务匹配。Token Plan 不接受原先的 `qwen3-*-realtime` 模型名。
5. 若桌面内嵌页不支持麦克风，在外部 Chrome / Edge 打开同一个本地 DSH 链接。先用耳机排除扬声器回声。

模型、音色与管线参数变更后关闭并重新开启语音。不要在问题报告里附上 `.env.local`、完整授权链接或私人转写。
