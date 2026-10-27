# 双向语音交互：模型调研与开发方案

调研日期：2026-10-27。本文描述后续方案；DuplexJev 和 Tyger 尚未接入，也没有在 RTX 5080 或 4060 Laptop 上实测。

## 目标与原则

- 在语音对话中支持用户打断、附和后继续播放，以及合适时机的主动澄清。
- 所有实际发声的回答、插话和澄清都由用户选定的主大模型生成。决策模型只决定动作或时机，不生成接场话术。
- 延续 DSH 的原生输入和会话链路，同时让音频决策服务以后可供独立客户端复用。
- 优先在现有轮次控制器中接入必要能力，避免为实验引入完整的新对话框架。

## 当前基线

项目已有语音自动提交、说话时可恢复暂停、语义打断、主模型主动澄清、本地 SenseVoice 可选识别和分段延迟诊断。当前收音与播放使用独立的 AudioContext；记录已听内容的粒度是完成播放的语音片段，而非逐字播放位置。

在 Apple M4 上，少量合成中文样本的本地 ASR 最终识别为 71–74 ms，云端为 550–1028 ms；最终本地链路从输入结束到收到第一段 TTS 音频为 2.026–2.794 s。样本不包含真实麦克风、设备播放和完整 DSH 工具调用，不能代表真人对话体感。云端决策、主模型首字、断句等待和 TTS 也会影响总延迟。测试方法、失败样本和限制见 [延迟报告](LATENCY.md)。

## 调研结论

### DuplexJev：候选音频决策模型

[DuplexJev](https://github.com/adventists-ai/duplexjev) 使用音频和可选的助手前文，对预设选项给出概率，可用于判断说完、继续、附和和打断。它是决策组件，仍需要 ASR、主模型、TTS 和会话控制。

推荐先比较 [4B-Para 和 4B-Para-LiveTurn](https://github.com/adventists-ai/duplexjev/blob/main/docs/models.md)：前者覆盖更多通用能力，后者针对实时轮次结束进行调整。两者上游标注均约需 10 GB 显存；先在 5080 上单会话运行，一次仅驻留一个模型。上游 H200 的决策耗时不代表 5080 的端到端延迟。

注意动作映射：上游 LiveKit 集成把 finished 和 backchannel 的概率合并用于其结束判断；本项目必须区分附和与新请求。“嗯、继续”应允许恢复播放，不能直接自动提交。参考 [集成实现](https://github.com/adventists-ai/duplexjev/blob/main/integrations/livekit/livekit/plugins/duplexjev/turn_detector.py)。

上游中文 eot-bench 验证集对 4B-Para-LiveTurn 的报告：300 ms / 600 ms 设置下的误截断率为 38.8% / 12.0%。这只是该评测协议的结果，但说明不能单凭模型接入就大幅缩短所有停顿阈值。具体阈值需用本项目的中文场景验证。

上游提供 [小型研究连接器](https://github.com/adventists-ai/duplexjev/blob/main/docs/connectors.md)，包括搭配 1.7B 或 0.6B 语言模型的版本；它们与特定编码器和语言模型绑定，成熟度和指标不能直接等同于最新完整 4B 模型。量化和 8 GB 实际表现也需要验证。

### Tyger-S2S：播放对齐与打断工程参考

[Tyger-S2S](https://github.com/nineninesix-ai/tyger-s2s) 是包含听觉、对话模型和语音合成的完整系统。当前实现面向英语，默认完整配置在四路对话下约 28 GB 显存，不适合直接搬到 16 GB 的 5080。它的听觉决策头依赖 Nemotron ASR 内部特征，替换为 SenseVoice 需要适配和训练。

值得借鉴的是播放对齐：浏览器为麦克风数据附带回复 ID 与实际播放位置，服务端据此对齐助手声音和用户声音，而不是依据音频到达顺序。上游曾观察到后者比真实播放提前中位数约 566 ms。浏览器报告的设备延迟不一定完整，尤其需要测试蓝牙设备；播放位置也不自动提供逐字对齐。[实现说明](https://github.com/nineninesix-ai/tyger-s2s/blob/main/DEVELOPING.md)

Tyger [记录了](https://github.com/nineninesix-ai/tyger-s2s/blob/main/ISSUES.md)附和误判为打断和残余回声引发误判等限制。我们保留发声即暂停、确认附和后恢复的机制，并以真实麦克风和外放测试为准。

## 推荐架构

```text
麦克风 ──┬── VAD：发声时立即、可恢复地暂停播放
         ├── 本地音频决策：继续等待 / 附和 / 说完 / 打断
         └── ASR：并行产生提交给 DSH 的文字
                         │
              现有轮次控制器：合并状态和结果
                         │
              用户选择的主大模型：生成全部回答
                         │
              TTS → 播放，并记录实际播放进度
```

音频决策和 ASR 并行，不能消除 ASR、主模型及 TTS 的时间。即时暂停由轻量 VAD 触发，较慢的判断负责确认是否恢复或正式打断。主动插话仍需结合对话上下文，并由主模型生成内容。每次会话选择一种决策后端，避免把新旧判断无条件串联。

5080 可作为独立的局域网决策服务，供 DSH 插件及未来独立端调用；CPU SenseVoice、现有云端主模型和 TTS 保持可用。4060 Laptop 的 8 GB 不足以按上游约 10 GB 的配置直接运行完整 4B，可连接 5080 或继续使用现有方案；小模型或量化仅作为后续实验。显存判断是基于公开规格和模型标注，尚无本机实测。

## 实施顺序和验收

1. **建立旁路评估。** 在 5080 部署一个 DuplexJev 候选，让它读取音频并记录判断，不控制真实会话。比较 4B-Para 与 LiveTurn，收集中文长句、句中停顿、附和、改口、主动打断和外放回声场景。记录模型版本、显存和延迟。
2. **接入现有控制器。** 明确等待、附和、提交、打断的映射和超时回退；保留先暂停后确认、附和恢复、显式取消的行为。全部发声内容仍来自主模型。用同一测试集对比现有决策，避免以单一推理速度替代质量评估。
3. **实现播放进度对齐。** 用实际播放位置维护运行时上下文，评估收音与播放时钟及设备延迟。当前播放器依赖 `AudioContext.suspend()` 暂停；若采用共享时钟，先改成只暂停输出而持续收音，避免中断麦克风。不得把播放进度当作逐字时间戳。
4. **真人验证并决定后续优化。** 分别测耳机、外放、蓝牙、背景人声与长会话；记录误截断率、附和误打断率、漏打断率、开口到停止播放时间、说完到实际首声的 P50/P95，以及失败率。优先解决实测瓶颈，再考虑本地 TTS；4B 决策模型和 Tyger 默认 VoxCPM2 的公开显存需求相加已超过 16 GB，不能假设可同时原样运行。

## 许可与来源

- DuplexJev 代码为 Apache 2.0；本文推荐的完整 Para / LiveTurn 权重标注 CC BY-NC 4.0。商业用途需重新核对权重及依赖模型许可：[模型表](https://github.com/adventists-ai/duplexjev/blob/main/docs/models.md)。
- Tyger 的代码、模型权重和底层模型分别有各自许可，复用时需核对其[仓库](https://github.com/nineninesix-ai/tyger-s2s)和[模型卡](https://huggingface.co/nineninesix/tyger)。
- NVIDIA 官方规格：[RTX 5080](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5080/)、[RTX 40 系列笔记本 GPU](https://www.nvidia.com/en-us/geforce/laptops/40-series/)。
