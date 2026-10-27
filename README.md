# DSH Realtime Voice · System 1

在 DeepSeek Harness 当前会话上增加语音自动发送、双向打断和主动澄清。**所有播报文字均由当前会话的主模型生成**；百炼决策模型只返回轮次动作，ASR 只转写，TTS 只合成。

本分支基于 [dsh-realtime-voice](https://github.com/zfu691531-hash/dsh-realtime-voice) 改造，保留 MIT 许可。当前开发目标是 DSH `0.2.1-rc.2` 的原生 Session API。

## 已实现

- 语音经原生输入框自动发送。续说合并；键盘编辑、清空、手动发送会撤销该草稿的自动发送权。
- 播报期间持续收音。起声先暂停播放，决策区分附和、接管话轮和明确取消；附和可以续播，普通打断只停止说话，明确取消才停止对应 DSH 任务。
- 主模型忙时暂存新语音，空闲后按当前草稿和轮次判断提交。
- 决策模型可以请求一次短澄清，由同一个 DSH 主模型生成。输入变化或用户重新起声会取消尚未播出的旧候选。
- 流式读取主模型的可见回答并分句播报，过滤代码块和 Markdown 标记，不读取推理或工具结果。已播记录以完整播报片段计，不冒充逐字播放进度。
- 取消、重试、迟到转写、过时决策和过时音频均有对应生命周期检查。
- 本地 SenseVoice 识别可选，与云端 ASR 共用断句、预览和取消逻辑；模型只在 Host 加载一次，不需要 Python 服务。
- AudioWorklet 在音频线程处理重采样，每 20 ms 传输一帧。收音与播放使用独立 AudioContext，暂停播报不会暂停麦克风；启用浏览器回声消除并过滤相似回声转写。
- 状态栏显示上轮尾静音、ASR、决策、主模型首字、分句和 TTS 首音频耗时，便于定位当前瓶颈。

原定四步的代码已具备：自动发送 → 用户打断与附和续播 → 语义判断与主模型主动澄清 → 音频采集、回声处理与延迟优化。第四步的真实麦克风、外放和噪声验收仍需在目标设备完成；当前自动化测试不能代替这部分。

## 本地启动

需要 Node.js 22+，以及已经构建的 DSH 源码，默认位于相邻目录 `../deepseek-harness`。这个 checkout 的依赖和构建已准备好。

```bash
# 首次安装或依赖变化时
npm ci --ignore-scripts
npm run dev:link-dsh
npm run check

# 首次配置时复制模板，填写 Host 凭据；已有 .env.local 则保留
cp .env.example .env.local

# 启动本项目专用 DSH 实例
npm run dev:dsh
```

`.env.local` 中设置 `BAILIAN_TOKEN_PLAN_API_KEY`。凭据仅由 Host 读取；本文件与 `.local/` 均被 Git 忽略。`DSH_SOURCE_ROOT`、`DSH_VOICE_PORT` 和 `DSH_VOICE_MAIN_MODEL` 可以覆盖源码位置、端口和开发配置的默认主模型。

启动器使用 `.local/dsh` 与 `.local/agents` 保存独立 profile、配置和测试会话。打开终端打印的本地链接，在输入框右侧开启麦克风；“左下角账号菜单 → 设置 → 内置插件 → 实时语音”可调整轮次判断与主动澄清。主模型使用 DSH 自己的模型选择器。

当前启动默认端口为 `3081`，主模型为 `deepseek-v4.1-flash`，推理等级为 **Off**。启动器显式传递百炼的 `enable_thinking: false`，仍可在 DSH 模型选择器中开启 High；长思考会增加语音等待。修改插件后执行 `npm run build`，重启开发实例并刷新页面。

## 本地 ASR

```bash
npm run setup:asr  # 显式下载官方量化 SenseVoice 模型，支持断点续传
npm run dev:dsh
```

在“设置 → 内置插件 → 实时语音 → 语音识别”选择“本地 SenseVoice”，再开启麦克风。模型保存在插件目录 `.local/models/`，也可通过 `DSH_VOICE_ASR_MODEL_DIR` 指定包含 `model.int8.onnx` 和 `tokens.txt` 的目录。换电脑后需重新安装依赖和准备模型；权重不提交 Git，也不随插件包发布。运行时 `sherpa-onnx-node` 是可选依赖，安装时不要省略 optional dependencies。

这是在运行 DSH 的电脑上识别；决策、主模型和 TTS 仍使用云端。SenseVoice 本身是分段模型，插件以滚动窗口提供预览，不把它当作原生流式 ASR。新安装默认保留云端识别，避免尚未准备权重时无法启动。

本机 M4 的 4.21 秒合成中文测试，五次纯识别耗时为 **71–83 ms**，首次加载约 **461 ms**。完整链路还受云端决策、主模型首字和 TTS 影响，测量范围、成功/失败样本见 [延迟报告](docs/LATENCY.md)。

## 百炼 Token Plan

| 职责 | 默认模型 / 接口 |
|---|---|
| 主模型 | `deepseek-v4.1-flash`，由 DSH 调用兼容接口 |
| 轮次决策 | `decision-model-preview`，`/systemone` |
| ASR | `qwen-audio-3.0-asr-flash`，HTTP 分段识别 |
| TTS | `qwen-audio-3.0-tts-plus`，inference WebSocket |
| 音色 | `longanlingxin` |

**当前套餐中的独立 ASR 是 HTTP 模型，不是原生流式 ASR。** Host 用本地 VAD、约一秒的预览窗口和最终识别结果提供持续转写，最多一个识别请求在途。最终识别会取消过时预览；尾静音和识别时间计入同一个续说窗口，不再额外累加一整段等待。不会自动切换到按量计费服务。

如需独立 DashScope 实时 ASR，可在设置中明确选择“百炼按量服务”，另外配置 `DASHSCOPE_API_KEY` 和匹配的模型、音色；详见 [配置](docs/EXAMPLE_CONFIG.md)。

## 验证

```bash
npm run check          # 类型、单元测试、构建和浏览器 bundle 边界
npm run check:bailian  # 使用 .env.local，真实调用主模型、决策、TTS、ASR
CHECK_ASR=local npm run check:bailian  # 通过真实 Host WebSocket 验证本地识别
BENCH_ASR=local npm run bench:voice   # 合成中文，生产轮次控制器，记录分段延迟
```

真实接口测试使用一条合成测试语音，经插件 Host 代理完成 TTS → ASR 回环，不读取麦克风。已验证默认主模型和决策接口，以及默认 TTS 音色和 ASR 请求格式。

回归测试覆盖原生会话委派、转写修订、草稿所有权、双向打断、附和续播、插话过期、过时请求取消、决策有界重试和音频采集。真实麦克风、扬声器回声、不同浏览器和长时间对话仍需人工验收；建议先用耳机测试。

## 当前范围

这是 DSH 插件版本。独立客户端、Jev 本地推理和键盘输入的免回车发送尚未实现；已经实现的是**语音转写自动发送**。主动澄清使用同一个主模型，必须等待它生成回答，不承诺即时接场；其“不要调用工具”目前是主模型指令约束。

没有独立答题的语音模型、轻量接场模型或预写播报句。可选腾讯声纹后端保留兼容，默认关闭，当前简化设置页未提供录入管理界面。

代码职责和验收场景见 [开发说明](docs/ARCHITECTURE_PACKAGE.md)，后续音频决策和本地推理方案见 [双向语音开发方案](docs/DUPLEX_ROADMAP.md)，数据边界见 [SECURITY.md](SECURITY.md)。
