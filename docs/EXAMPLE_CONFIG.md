# 配置与排障

## Token Plan 默认值

在 DSH “左下角账号菜单 → 设置 → 内置插件 → 实时语音”设置语音服务。凭据由 Host 环境变量或 DSH credentials 服务提供，不能填入模型名或音色字段。

| 配置 | 默认值 |
|---|---|
| Host 凭据 | `BAILIAN_TOKEN_PLAN_API_KEY` |
| 服务 | `token-plan` |
| ASR 引擎 | `cloud`；可选 `local-sensevoice` |
| ASR | `qwen-audio-3.0-asr-flash` |
| TTS | `qwen-audio-3.0-tts-plus` |
| 音色 | `longanlingxin` |
| 决策模型 | `decision-model-preview` |
| 决策总超时 | 4000 ms |
| 尾静音 | 400 ms |
| 续说窗口 | 600 ms，从最后人声起算，包含尾静音和识别时间 |
| 忙后草稿停留 | 700 ms |
| 语音自动发送 / 语义判断 / 主动澄清 | 开启 |
| 敏感指令手动发送 | 开启 |

断句、转写、决策、主模型生成和 TTS 都有耗时，状态栏可展开查看。续说窗口不是叠加在识别后的固定等待：例如尾静音 400 ms、识别 80 ms 时，只补余下的 120 ms。人声阈值设置仅用于 DashScope 原生实时 VAD；Token Plan 和本地 SenseVoice 使用本地能量检测。

最终决策的总超时至少 3000 ms 时，首次请求超过 2000 ms 会取消并重试一次，仍受总超时约束。用户继续说话会取消过时请求；partial、接口拒绝或无效响应不重试。两次均失败时明确提示，并保留输入框文字供手动发送。旧安装保留已保存的参数，可手动改成上表数值。

关闭语义判断后使用确定性的尾静音与续说窗口提交，主动澄清关闭。决策失败不会把模型错误当成回答播出。

## 本地识别与主模型

运行 `npm run setup:asr`，再选择“本地 SenseVoice”。首次连接加载模型，后续连接复用；识别不需要 ASR 云端凭据。主模型、决策和 TTS 仍需要各自配置。自备模型时，将 `DSH_VOICE_ASR_MODEL_DIR` 设为包含 `model.int8.onnx` 与 `tokens.txt` 的目录。此路径属于运行 DSH 的 Host，不能填到云端“ASR 模型”字段。

本地开发启动器默认主模型为 `deepseek-v4.1-flash · Off`，也提供 `qwen3.8-flash` 供 DSH 原生选择器切换。通用插件安装不会改写宿主的主模型配置；需在宿主供应商兼容配置中使用 `thinkingFormat: qwen`，并选择 Off，才能向百炼明确传递 `enable_thinking: false`。选择 High 会增加推理等待。

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
