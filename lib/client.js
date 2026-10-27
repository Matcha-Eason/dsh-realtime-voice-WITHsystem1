window.__ModuleLoader__.load({
	id: "dsh-realtime-voice",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/harness-delegate.ts
		/** Owns voice observation and addressed cancellation over the native Session API. */
		var HarnessBridge = class {
			sessions;
			promptTimeoutMs;
			setVoiceContext;
			voices = /* @__PURE__ */ new Map();
			lifetime = new AbortController();
			constructor(sessions, promptTimeoutMs = 3e4, setVoiceContext = updateVoiceContext) {
				this.sessions = sessions;
				this.promptTimeoutMs = promptTimeoutMs;
				this.setVoiceContext = setVoiceContext;
			}
			isBusy(sessionId) {
				const voice = this.voices.get(sessionId);
				const snapshot = (voice?.binding ?? this.sessions.binding(sessionId))?.session.getSnapshot();
				return voice?.operation !== void 0 || snapshot?.running === true || snapshot?.awaitingFirstTurn === true || (snapshot?.pendingSubmissions.length ?? 0) > 0;
			}
			async setVoiceMode(sessionId, active, signal, context) {
				if (active) await this.voices.get(sessionId)?.reference.ready;
				signal?.throwIfAborted();
				await this.setVoiceContext(sessionId, active, signal, context);
			}
			observeSession(sessionId, callbacks) {
				const voice = this.retain(sessionId);
				voice.observer = callbacks;
				return () => {
					if (voice.observer !== callbacks) return;
					voice.observer = void 0;
					this.releaseUnused(sessionId, voice);
				};
			}
			async delegate(sessionId, task, signal) {
				if (signal?.aborted || this.lifetime.signal.aborted) return {
					ok: false,
					cancelled: true,
					error: "已取消"
				};
				if (this.isBusy(sessionId)) return {
					ok: false,
					error: "当前会话正在执行，请等待本轮完成"
				};
				const voice = this.retain(sessionId);
				let settle;
				const result = new Promise((resolve) => {
					settle = resolve;
				});
				const requestCancel = () => {
					operation.cancelRequested = true;
					this.cancel(sessionId).catch((error) => {
						this.finish(sessionId, voice, {
							ok: false,
							error: String(error)
						});
					});
				};
				const timer = setTimeout(() => {
					this.finish(sessionId, voice, {
						ok: false,
						error: "Harness 任务等待超时"
					});
				}, 6e5);
				const operation = {
					cancelRequested: false,
					settle,
					cleanup: () => {
						clearTimeout(timer);
						signal?.removeEventListener("abort", requestCancel);
					}
				};
				voice.operation = operation;
				signal?.addEventListener("abort", requestCancel, { once: true });
				let submission;
				try {
					await voice.reference.ready;
					if (operation.cancelRequested || this.lifetime.signal.aborted) {
						this.finish(sessionId, voice, {
							ok: false,
							cancelled: true,
							error: "已取消"
						});
						return await result;
					}
					const snapshot = voice.binding.session.getSnapshot();
					if (snapshot.running || snapshot.pendingSubmissions.length > 0) {
						this.finish(sessionId, voice, {
							ok: false,
							error: "当前会话正在执行，请等待本轮完成"
						});
						return await result;
					}
					submission = voice.binding.session.beginSubmission({
						mode: "queue",
						text: task,
						attachments: []
					});
					operation.requestId = submission.requestId;
					const admissionSignal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.promptTimeoutMs)]);
					const admitted = await voice.binding.session.prompt([{
						type: "text",
						text: task
					}], "queue", admissionSignal, submission.requestId);
					if (!admitted.ok && operation.turn === void 0) {
						submission.abandon();
						this.finish(sessionId, voice, {
							ok: false,
							error: `${admitted.error.code}: ${admitted.error.message}`
						});
					} else if (operation.cancelRequested) await this.cancel(sessionId);
				} catch (error) {
					submission?.abandon();
					this.finish(sessionId, voice, {
						ok: false,
						...signal?.aborted || this.lifetime.signal.aborted ? { cancelled: true } : {},
						error: error instanceof Error ? error.message : String(error)
					});
				}
				return await result;
			}
			async cancel(sessionId) {
				const voice = this.voices.get(sessionId);
				if (voice === void 0) return false;
				if (voice.cancelPending !== void 0) return await voice.cancelPending;
				const operation = voice.operation;
				if (operation !== void 0) operation.cancelRequested = true;
				const turnBeforeCancel = operation?.turn;
				const pending = Promise.resolve().then(() => this.cancelOwned(voice));
				voice.cancelPending = pending;
				let cancelled;
				try {
					cancelled = await pending;
				} finally {
					if (voice.cancelPending === pending) voice.cancelPending = void 0;
				}
				if (operation !== void 0 && voice.operation === operation && turnBeforeCancel === void 0 && operation.turn !== void 0) return await this.cancel(sessionId);
				return cancelled;
			}
			dispose() {
				this.lifetime.abort();
				for (const [sessionId, voice] of this.voices) {
					voice.observer = void 0;
					if (voice.operation !== void 0) this.finish(sessionId, voice, {
						ok: false,
						cancelled: true,
						error: "插件已卸载"
					});
					else this.releaseUnused(sessionId, voice);
				}
				this.voices.clear();
			}
			retain(sessionId) {
				const previous = this.voices.get(sessionId);
				if (previous !== void 0) return previous;
				const reference = this.sessions.retain(sessionId, {
					source: "realtimeVoice",
					signal: this.lifetime.signal
				});
				const binding = reference.binding;
				const events = binding.eventSource;
				const inbox = binding.session.projections.faceOf("inbox");
				const voice = {
					reference,
					binding,
					text: "",
					revision: events.getSnapshot().revision,
					dispose: () => {
						offEvents();
						offInbox();
						reference.release();
					}
				};
				const baseline = events.getSnapshot();
				for (const entry of baseline.entries) {
					if (entry.event.type === "turn/start") voice.openTurn = String(entry.event.data.turn);
					if (entry.event.type === "turn/end") voice.openTurn = void 0;
				}
				voice.activeTurn = voice.openTurn;
				const offEvents = events.subscribe(() => {
					const snapshot = events.getSnapshot();
					if (snapshot.revision === voice.revision) return;
					voice.revision = snapshot.revision;
					const change = snapshot.change;
					if (change.kind === "append") for (const entry of change.entries) this.handleEvent(sessionId, voice, entry.event);
					else if (change.kind === "settle-assistant") {
						if (change.entry !== void 0) this.handleEvent(sessionId, voice, change.entry.event);
						else if (voice.attemptId === change.attemptId) this.resetText(voice, "retry");
					} else if (change.kind === "replace") {
						voice.openTurn = void 0;
						for (const entry of change.entries) {
							if (entry.event.type === "turn/start") voice.openTurn = String(entry.event.data.turn);
							if (entry.event.type === "turn/end") voice.openTurn = void 0;
						}
						voice.activeTurn = voice.openTurn;
					}
				});
				const offInbox = inbox.subscribe(() => {
					if (voice.operation?.cancelRequested) this.cancel(sessionId).catch((error) => {
						this.finish(sessionId, voice, {
							ok: false,
							error: String(error)
						});
					});
				});
				this.voices.set(sessionId, voice);
				reference.ready.catch((error) => {
					this.finish(sessionId, voice, {
						ok: false,
						error: `会话打开失败：${String(error)}`
					});
				});
				return voice;
			}
			async cancelOwned(voice) {
				const operation = voice.operation;
				const session = voice.binding.session;
				if (operation !== void 0 && operation.turn === void 0) {
					const inbox = session.projections.faceOf("inbox").getSnapshot();
					const item = [...inbox?.["next-turn"] ?? [], ...inbox?.["next-step"] ?? []].find((message) => message.source.kind === "user" && "rpcId" in message.source && message.source.rpcId === operation.requestId);
					if (item === void 0) return true;
					const removed = await session.updateQueue(item.id, { kind: "remove" });
					if (removed.ok) this.finish(voice.binding.sessionId, voice, {
						ok: false,
						cancelled: true,
						error: "已取消"
					});
					else if (removed.error.code !== "session/queue-item-not-found") throw new Error(`${removed.error.code}: ${removed.error.message}`);
					return true;
				}
				const ownedTurn = operation?.turn ?? (voice.observer === void 0 ? void 0 : voice.activeTurn);
				if (ownedTurn === void 0 || ownedTurn !== voice.openTurn || !session.getSnapshot().running) return false;
				const cancelled = await session.cancel();
				if (!cancelled.ok) throw new Error(`${cancelled.error.code}: ${cancelled.error.message}`);
				return true;
			}
			handleEvent(sessionId, voice, event) {
				const operation = voice.operation;
				if (event.type === "turn/start") {
					voice.openTurn = String(event.data.turn);
					return;
				}
				if (event.type === "user/message") {
					const source = event.data.source;
					if (source.kind !== "user" || voice.openTurn === void 0) return;
					if (operation !== void 0 && "rpcId" in source && source.rpcId === operation.requestId) {
						operation.turn = voice.openTurn;
						if (operation.cancelRequested) this.cancel(sessionId).catch((error) => {
							this.finish(sessionId, voice, {
								ok: false,
								error: String(error)
							});
						});
					}
					if (voice.activeTurn !== voice.openTurn) {
						voice.activeTurn = voice.openTurn;
						voice.text = "";
						voice.attemptId = void 0;
						voice.observer?.onTurnStart(voice.openTurn);
					}
					return;
				}
				const turn = "turn" in event.data ? String(event.data.turn) : void 0;
				if (turn === void 0 || turn !== voice.activeTurn) return;
				if (event.type === "assistant/live-chunk") {
					if (voice.attemptId !== void 0 && voice.attemptId !== event.data.attemptId) this.resetText(voice, "retry");
					voice.attemptId = event.data.attemptId;
					const chunk = event.data.chunk;
					if (chunk.type === "text-delta") {
						voice.text += chunk.text;
						voice.observer?.onTextDelta(turn, chunk.text);
					} else if (chunk.type === "tool-call-delta" || chunk.type === "block-start" && chunk.blockType === "tool-call") this.resetText(voice, "tool");
				} else if (event.type === "assistant/message") voice.text = extractAssistantText(event.data.message);
				else if (event.type === "assistant/attempt") this.resetText(voice, "retry");
				else if (event.type === "tool/call") this.resetText(voice, "tool");
				else if (event.type === "turn/end") {
					const reason = event.data.reason.kind;
					const result = reason === "completed" ? {
						ok: true,
						text: voice.text
					} : reason === "aborted" || reason === "interrupted" ? {
						ok: false,
						cancelled: true,
						error: "已取消"
					} : {
						ok: false,
						error: `Harness 任务结束：${reason}`
					};
					voice.openTurn = void 0;
					voice.activeTurn = void 0;
					voice.attemptId = void 0;
					voice.text = "";
					voice.observer?.onTurnEnd(turn, result);
					if (operation?.turn === turn) this.finish(sessionId, voice, result);
				}
			}
			resetText(voice, reason) {
				voice.text = "";
				if (voice.activeTurn !== void 0) voice.observer?.onTextReset?.(voice.activeTurn, reason);
			}
			finish(sessionId, voice, result) {
				const operation = voice.operation;
				if (operation === void 0) return;
				voice.operation = void 0;
				operation.cleanup();
				operation.settle(result);
				this.releaseUnused(sessionId, voice);
			}
			releaseUnused(sessionId, voice) {
				if (voice.observer !== void 0 || voice.operation !== void 0) return;
				voice.dispose();
				this.voices.delete(sessionId);
			}
		};
		async function updateVoiceContext(sessionId, active, signal, context) {
			const response = await fetch("/dsh-realtime-voice/context", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId,
					active,
					...context
				}),
				signal
			});
			if (!response.ok) throw new Error(await response.text() || `HTTP ${response.status}`);
		}
		function extractAssistantText(message) {
			if (typeof message !== "object" || message === null) return "";
			const record = message;
			if (!Array.isArray(record.content)) return "";
			return record.content.map((part) => {
				if (typeof part !== "object" || part === null) return "";
				const block = part;
				return block.type === "text" && typeof block.text === "string" ? block.text : "";
			}).join("\n").trim();
		}
		//#endregion
		//#region src/client/prefs.ts
		const KEY = "dsh-realtime-voice:prefs:v1";
		const PREFS_URL = "/dsh-realtime-voice/prefs";
		const DEFAULTS = {
			provider: "qwen",
			speechService: "token-plan",
			asrEngine: "cloud",
			decisionEnabled: true,
			decisionModel: "decision-model-preview",
			decisionTimeoutMs: 4e3,
			proactiveEnabled: true,
			qwenWorkspaceId: "token-plan",
			qwenRegion: "cn-beijing",
			qwenAsrModel: "qwen-audio-3.0-asr-flash",
			qwenTtsModel: "qwen-audio-3.0-tts-plus",
			qwenTtsVoice: "longanlingxin",
			qwenVadThreshold: .85,
			qwenSilenceMs: 400,
			qwenMergeMs: 600,
			voiceDraftAutoSend: true,
			voiceDraftDwellMs: 700,
			voiceDraftAllowWithoutVoiceprint: true,
			voiceDraftSensitiveDeny: true,
			voiceprintEnabled: false,
			voiceprintThreshold: 75,
			instructions: "请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。"
		};
		let cache;
		const listeners = /* @__PURE__ */ new Set();
		function loadPrefs() {
			if (cache !== void 0) return cache;
			try {
				const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
				cache = sanitize({
					...DEFAULTS,
					...parsed
				});
			} catch {
				cache = { ...DEFAULTS };
			}
			return cache;
		}
		function updatePrefs(patch) {
			cache = sanitize({
				...loadPrefs(),
				...patch
			});
			localStorage.setItem(KEY, JSON.stringify(cache));
			persistPrefs(cache);
			listeners.forEach((listener) => listener());
			return cache;
		}
		/** Push the current prefs to the host bridge so they survive browser switches and port changes. */
		function persistPrefs(prefs) {
			try {
				fetch(PREFS_URL, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(prefs),
					cache: "no-store"
				}).catch(() => {});
			} catch {}
		}
		function hasCustomPrefs(prefs) {
			return Object.keys(DEFAULTS).some((key) => prefs[key] !== DEFAULTS[key]);
		}
		/**
		* One-shot hydration: pull prefs persisted on the host (settings document) and
		* merge them over localStorage. When the host has nothing yet but this browser
		* already has custom values (pre-fix state), push them up so they are saved.
		*/
		function hydrateFromHost() {
			fetch(PREFS_URL, {
				cache: "no-store",
				headers: { accept: "application/json" }
			}).then((response) => response.ok ? response.json() : null).then((data) => {
				const local = loadPrefs();
				if (data && data.hasUserData && typeof data.prefs === "object" && data.prefs !== null) {
					cache = sanitize({
						...local,
						...data.prefs
					});
					localStorage.setItem(KEY, JSON.stringify(cache));
					listeners.forEach((listener) => listener());
				} else if (hasCustomPrefs(local)) persistPrefs(local);
			}).catch(() => {});
		}
		function subscribePrefs(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		}
		function sanitize(value) {
			const qwenMergeMs = numberInRange(value.qwenMergeMs, 100, 5e3, DEFAULTS.qwenMergeMs);
			return {
				provider: "qwen",
				asrEngine: value.asrEngine === "local-sensevoice" ? "local-sensevoice" : "cloud",
				speechService: value.speechService === "dashscope" ? "dashscope" : "token-plan",
				decisionEnabled: value.decisionEnabled !== false,
				decisionModel: text(value.decisionModel, 128) || DEFAULTS.decisionModel,
				decisionTimeoutMs: numberInRange(value.decisionTimeoutMs, 250, 1e4, DEFAULTS.decisionTimeoutMs),
				proactiveEnabled: value.proactiveEnabled !== false,
				qwenWorkspaceId: text(value.qwenWorkspaceId, 128),
				qwenRegion: value.qwenRegion === "ap-southeast-1" ? "ap-southeast-1" : "cn-beijing",
				qwenAsrModel: text(value.qwenAsrModel, 128) || DEFAULTS.qwenAsrModel,
				qwenTtsModel: text(value.qwenTtsModel, 128) || DEFAULTS.qwenTtsModel,
				qwenTtsVoice: text(value.qwenTtsVoice, 128) || DEFAULTS.qwenTtsVoice,
				qwenVadThreshold: numberInRange(value.qwenVadThreshold, -1, 1, DEFAULTS.qwenVadThreshold),
				qwenSilenceMs: numberInRange(value.qwenSilenceMs, 200, 6e3, DEFAULTS.qwenSilenceMs),
				qwenMergeMs,
				voiceDraftAutoSend: value.voiceDraftAutoSend !== false,
				voiceDraftDwellMs: Math.max(qwenMergeMs, numberInRange(value.voiceDraftDwellMs, 500, 6e3, DEFAULTS.voiceDraftDwellMs)),
				voiceDraftAllowWithoutVoiceprint: value.voiceDraftAllowWithoutVoiceprint !== false,
				voiceDraftSensitiveDeny: value.voiceDraftSensitiveDeny !== false,
				voiceprintEnabled: value.voiceprintEnabled === true,
				voiceprintThreshold: numberInRange(value.voiceprintThreshold, 0, 100, DEFAULTS.voiceprintThreshold),
				instructions: text(value.instructions, 12e3) || DEFAULTS.instructions
			};
		}
		function numberInRange(value, min, max, fallback) {
			return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
		}
		function text(value, max) {
			return typeof value === "string" ? value.slice(0, max) : "";
		}
		//#endregion
		//#region src/client/capture-worklet.ts
		/** Runs resampling and fixed 20 ms framing off the UI thread. No audio is stored. */
		const PCM_CAPTURE_WORKLET = String.raw`
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.ratio = sampleRate / 16000; this.weight = 0; this.sum = 0;
    this.frame = new Int16Array(320); this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      let remaining = 1;
      while (remaining > 1e-6) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= this.ratio - 1e-6) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.frame[this.offset++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.sum = 0; this.weight = 0;
          if (this.offset === this.frame.length) {
            this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
            this.frame = new Int16Array(320); this.offset = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor('dsh-pcm-capture', PcmCapture);
`;
		//#endregion
		//#region src/client/voiceprint.ts
		const SAMPLE_RATE = 16e3;
		const MAX_SAMPLES = SAMPLE_RATE * 30;
		const PRE_ROLL_SAMPLES = SAMPLE_RATE;
		/** Keeps only bounded in-memory PCM for the current ASR utterance. */
		var VoiceprintCapture = class {
			preRoll = [];
			preRollSamples = 0;
			active;
			completed = /* @__PURE__ */ new Map();
			push(frame) {
				if (frame.length === 0) return;
				const copy = frame.slice();
				this.preRoll.push(copy);
				this.preRollSamples += copy.length;
				while (this.preRollSamples > PRE_ROLL_SAMPLES && this.preRoll.length > 1) {
					const removed = this.preRoll.shift();
					if (removed !== void 0) this.preRollSamples -= removed.length;
				}
				const active = this.active;
				if (active === void 0 || active.samples >= MAX_SAMPLES) return;
				const remaining = MAX_SAMPLES - active.samples;
				const addition = copy.length <= remaining ? copy : copy.slice(0, remaining);
				active.frames.push(addition);
				active.samples += addition.length;
			}
			start(itemId) {
				if (itemId === "") return;
				const frames = this.preRoll.map((frame) => frame.slice());
				this.active = {
					itemId,
					frames,
					samples: frames.reduce((sum, frame) => sum + frame.length, 0)
				};
			}
			stop(itemId) {
				const active = this.active;
				if (active === void 0) return;
				if (itemId !== "" && itemId !== active.itemId) return;
				const key = itemId || active.itemId;
				this.active = void 0;
				this.preRoll = [];
				this.preRollSamples = 0;
				if (key === "" || active.samples < SAMPLE_RATE) return;
				const samples = new Int16Array(Math.min(active.samples, MAX_SAMPLES));
				let offset = 0;
				for (const frame of active.frames) {
					if (offset >= samples.length) break;
					const addition = frame.length <= samples.length - offset ? frame : frame.subarray(0, samples.length - offset);
					samples.set(addition, offset);
					offset += addition.length;
				}
				this.completed.set(key, samples);
				while (this.completed.size > 4) this.completed.delete(this.completed.keys().next().value);
			}
			takeBase64(itemId) {
				const samples = this.completed.get(itemId);
				if (samples === void 0) return void 0;
				this.completed.delete(itemId);
				return pcmBase64(samples);
			}
			discard(itemId) {
				if (itemId !== "") this.completed.delete(itemId);
				if (this.active?.itemId === itemId) this.active = void 0;
			}
			clear() {
				this.preRoll = [];
				this.preRollSamples = 0;
				this.active = void 0;
				this.completed.clear();
			}
		};
		async function getVoiceprintStatus() {
			try {
				const response = await fetch("/dsh-realtime-voice/status", {
					cache: "no-store",
					headers: { accept: "application/json" }
				});
				const body = await response.json();
				return {
					configured: response.ok && body.voiceprint?.configured === true,
					enrolled: response.ok && body.voiceprint?.enrolled === true
				};
			} catch {
				return {
					configured: false,
					enrolled: false
				};
			}
		}
		async function checkVoiceprint(operation, audio) {
			try {
				const response = await fetch("/dsh-realtime-voice/voiceprint", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						operation,
						audio
					}),
					cache: "no-store"
				});
				const body = await response.json().catch(() => ({}));
				if (!response.ok) return {
					status: "unavailable",
					error: body.error ?? `HTTP ${response.status}`
				};
				if (operation === "enroll") return body.enrolled === true ? { status: "enrolled" } : {
					status: "unavailable",
					error: "声纹服务未确认录入"
				};
				const score = typeof body.score === "number" && Number.isFinite(body.score) ? body.score : 0;
				return body.approved === true ? {
					status: "approved",
					score
				} : {
					status: "rejected",
					score
				};
			} catch (error) {
				return {
					status: "unavailable",
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		function pcmBase64(samples) {
			const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
			let binary = "";
			const chunkSize = 32768;
			for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
			return btoa(binary);
		}
		//#endregion
		//#region src/client/qwen-pipeline.ts
		var QwenPipelineConnection = class {
			prefs;
			callbacks;
			asr;
			tts;
			microphone;
			captureContext;
			captureSource;
			processor;
			silentGain;
			player = new PcmPlayer();
			ttsReady;
			resolveTtsReady;
			rejectTtsReady;
			speechResolve;
			speechReject;
			disposed = false;
			speechAudible = false;
			currentSpeechText = "";
			inputPhase = "listening";
			speechEpoch = 0;
			pendingSpeechText = "";
			pendingSpeechHasAudio = false;
			asrEventTail = Promise.resolve();
			activeUtteranceId;
			nextUtteranceId = 0;
			utteranceBusy = /* @__PURE__ */ new Map();
			utteranceSpeech = /* @__PURE__ */ new Map();
			completedUtterances = /* @__PURE__ */ new Set();
			voiceprintCapture = new VoiceprintCapture();
			voiceprintDispatchTail = Promise.resolve();
			voiceprintEpoch = 0;
			voiceprintConfigured = false;
			voiceprintEnrolled = false;
			constructor(prefs, callbacks) {
				this.prefs = prefs;
				this.callbacks = callbacks;
			}
			async connect() {
				if (this.disposed) return;
				this.callbacks.onState("connecting");
				if (this.prefs.speechService === "dashscope" && this.prefs.qwenWorkspaceId.trim() === "") throw new Error("请先在插件设置中填写阿里云百炼 Workspace ID");
				if (navigator.mediaDevices?.getUserMedia === void 0) throw new Error("当前页面无法访问麦克风，请用 Chrome 打开此 Harness 地址");
				const microphone = await navigator.mediaDevices.getUserMedia({ audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: false,
					channelCount: 1
				} });
				if (this.disposed) {
					microphone.getTracks().forEach((track) => track.stop());
					return;
				}
				this.microphone = microphone;
				if (this.prefs.voiceprintEnabled) {
					const status = await getVoiceprintStatus();
					if (this.disposed) return;
					this.voiceprintConfigured = status.configured;
					this.voiceprintEnrolled = status.enrolled;
				}
				await this.openTts();
				if (this.disposed) return;
				await this.openAsr();
				if (this.disposed) return;
				await this.startCapture();
			}
			async speak(text) {
				const epoch = this.speechEpoch;
				const chunks = splitForTts(text);
				if (chunks.length === 0 || this.disposed) return;
				if (this.tts?.readyState !== WebSocket.OPEN) await this.openTts();
				await this.ttsReady;
				if (this.speechEpoch !== epoch) throw new Error("语音已被替换");
				if (this.disposed || this.tts?.readyState !== WebSocket.OPEN) throw new Error("千问 TTS 连接已关闭");
				this.currentSpeechText = joinSpeechText(this.currentSpeechText, text);
				for (const chunk of chunks) {
					if (this.speechEpoch !== epoch) throw new Error("语音已被替换");
					if (this.disposed || this.tts?.readyState !== WebSocket.OPEN) throw new Error("千问 TTS 连接已关闭");
					await new Promise((resolve, reject) => {
						this.speechResolve = resolve;
						this.speechReject = reject;
						this.pendingSpeechText = chunk;
						this.pendingSpeechHasAudio = false;
						this.sendTts({
							type: "input_text_buffer.append",
							event_id: eventId(),
							text: chunk
						});
						this.sendTts({
							type: "input_text_buffer.commit",
							event_id: eventId()
						});
					});
				}
			}
			async waitForSpeechIdle() {
				const epoch = this.speechEpoch;
				await this.player.waitUntilIdle();
				if (epoch !== this.speechEpoch) return;
				this.speechAudible = false;
				this.currentSpeechText = "";
			}
			pauseSpeech() {
				this.player.pause();
			}
			resumeSpeech() {
				this.player.resume();
			}
			cancelSpeech() {
				this.speechEpoch++;
				this.player.stop();
				const error = /* @__PURE__ */ new Error("语音播放已被用户打断");
				this.speechReject?.(error);
				this.rejectTtsReady?.(error);
				this.speechResolve = void 0;
				this.speechReject = void 0;
				this.resolveTtsReady = void 0;
				this.rejectTtsReady = void 0;
				this.pendingSpeechText = "";
				this.pendingSpeechHasAudio = false;
				const socket = this.tts;
				this.tts = void 0;
				this.ttsReady = void 0;
				socket?.close(1e3, "speech cancelled");
				this.speechAudible = false;
				this.currentSpeechText = "";
			}
			setInputPhase(phase) {
				this.inputPhase = phase;
			}
			disconnect() {
				this.disposed = true;
				this.cancelSpeech();
				this.player.dispose();
				if (this.processor) {
					this.processor.port.onmessage = null;
					this.processor.port.close();
					this.processor.disconnect();
				}
				this.captureSource?.disconnect();
				this.silentGain?.disconnect();
				this.captureContext?.close();
				this.microphone?.getTracks().forEach((track) => track.stop());
				finishAndClose(this.asr);
				this.asr = void 0;
				this.tts = void 0;
				this.activeUtteranceId = void 0;
				this.utteranceSpeech.clear();
				this.completedUtterances.clear();
				this.utteranceBusy.clear();
				this.voiceprintCapture.clear();
				this.voiceprintEpoch++;
				this.voiceprintDispatchTail = Promise.resolve();
			}
			async openAsr() {
				const socket = new WebSocket(proxyUrl("asr", this.prefs));
				this.asr = socket;
				await opened(socket);
				if (this.disposed || this.asr !== socket) {
					socket.close();
					return;
				}
				socket.onmessage = (event) => {
					const handle = async () => {
						if (!this.disposed && this.asr === socket) await this.handleAsr(event.data);
					};
					this.asrEventTail = this.asrEventTail.then(handle, handle);
				};
				socket.onerror = () => {
					if (!this.disposed && this.asr === socket) this.callbacks.onState("error", "千问专用 ASR 连接失败");
				};
				socket.onclose = () => {
					if (this.asr !== socket) return;
					this.asr = void 0;
					if (!this.disposed) this.callbacks.onState("error", "千问专用 ASR 已断开");
				};
				this.sendAsr({
					type: "session.update",
					event_id: eventId(),
					session: {
						input_audio_format: "pcm",
						sample_rate: 16e3,
						input_audio_transcription: { language: "zh" },
						turn_detection: {
							type: "server_vad",
							threshold: this.prefs.qwenVadThreshold,
							silence_duration_ms: this.prefs.qwenSilenceMs
						}
					}
				});
			}
			async openTts() {
				if (this.tts?.readyState === WebSocket.OPEN || this.tts?.readyState === WebSocket.CONNECTING) return await this.ttsReady;
				this.ttsReady = new Promise((resolve, reject) => {
					this.resolveTtsReady = resolve;
					this.rejectTtsReady = reject;
				});
				const socket = new WebSocket(proxyUrl("tts", this.prefs));
				this.tts = socket;
				socket.onmessage = (event) => {
					if (!this.disposed && this.tts === socket) this.handleTts(event.data);
				};
				socket.onerror = () => {
					if (this.tts === socket) this.rejectTtsReady?.(/* @__PURE__ */ new Error("千问专用 TTS 连接失败"));
				};
				socket.onclose = () => {
					if (this.tts !== socket) return;
					this.tts = void 0;
					this.rejectTtsReady?.(/* @__PURE__ */ new Error("千问专用 TTS 已断开"));
					this.speechReject?.(/* @__PURE__ */ new Error("千问专用 TTS 已断开"));
					this.speechResolve = void 0;
					this.speechReject = void 0;
				};
				await Promise.all([opened(socket), this.ttsReady]);
			}
			async startCapture() {
				if (this.microphone === void 0 || this.disposed) return;
				const context = new AudioContext();
				this.captureContext = context;
				const moduleUrl = URL.createObjectURL(new Blob([PCM_CAPTURE_WORKLET], { type: "text/javascript" }));
				try {
					await context.audioWorklet.addModule(moduleUrl);
				} finally {
					URL.revokeObjectURL(moduleUrl);
				}
				if (this.disposed) return;
				const source = context.createMediaStreamSource(this.microphone);
				const processor = new AudioWorkletNode(context, "dsh-pcm-capture", {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [1]
				});
				const silent = context.createGain();
				silent.gain.value = 0;
				processor.port.onmessage = (event) => {
					if (this.disposed || this.asr?.readyState !== WebSocket.OPEN || this.asr.bufferedAmount > 524288) return;
					this.appendAsr(new Int16Array(event.data));
				};
				source.connect(processor);
				processor.connect(silent);
				silent.connect(context.destination);
				this.captureSource = source;
				this.processor = processor;
				this.silentGain = silent;
				await context.resume();
				const settings = this.microphone.getAudioTracks?.()[0]?.getSettings?.();
				this.callbacks.onAudioInfo?.({
					capture: "audio-worklet",
					echoCancellation: settings?.echoCancellation
				});
			}
			async handleAsr(raw) {
				if (this.disposed) return;
				const event = jsonEvent(raw);
				if (event === void 0) return;
				const type = event.type;
				if (type === "session.updated") this.callbacks.onState("listening");
				if (type === "input_audio_buffer.speech_started") {
					const itemId = typeof event.item_id === "string" ? event.item_id : `asr-${++this.nextUtteranceId}`;
					this.activeUtteranceId = itemId;
					this.utteranceBusy.set(itemId, this.inputPhase !== "listening" && this.inputPhase !== "endpoint-candidate");
					this.utteranceSpeech.set(itemId, this.currentSpeechText);
					if (this.prefs.voiceprintEnabled) this.voiceprintCapture.start(itemId);
					if (this.speechAudible || this.player.isPlaying || this.speechResolve !== void 0) this.pauseSpeech();
					this.callbacks.onSpeechStart?.({
						utteranceId: itemId,
						capturedWhileBusy: this.utteranceBusy.get(itemId)
					});
				}
				if (type === "input_audio_buffer.speech_stopped") {
					const itemId = typeof event.item_id === "string" ? event.item_id : this.activeUtteranceId;
					const silenceMs = typeof event.silence_ms === "number" ? Math.max(0, Math.min(6e3, event.silence_ms)) : this.prefs.qwenSilenceMs;
					this.callbacks.onSpeechEnd?.({
						utteranceId: itemId,
						silenceMs
					});
					if (this.prefs.voiceprintEnabled && itemId !== void 0) this.voiceprintCapture.stop(itemId);
				}
				if (type === "conversation.item.input_audio_transcription.text" || type === "conversation.item.input_audio_transcription.completed") {
					const itemId = typeof event.item_id === "string" ? event.item_id : this.activeUtteranceId ??= `asr-${++this.nextUtteranceId}`;
					if (this.completedUtterances.has(itemId)) return;
					const final = type === "conversation.item.input_audio_transcription.completed";
					const transcript = final ? typeof event.transcript === "string" ? event.transcript.trim() : "" : `${typeof event.text === "string" ? event.text : ""}${typeof event.stash === "string" ? event.stash : ""}`.trim();
					const meta = {
						utteranceId: itemId,
						capturedWhileBusy: this.utteranceBusy.get(itemId) ?? (this.inputPhase !== "listening" && this.inputPhase !== "endpoint-candidate"),
						likelyEcho: isLikelyTtsEcho(transcript, this.utteranceSpeech.get(itemId) ?? this.currentSpeechText)
					};
					if (!final) {
						this.callbacks.onPartialTranscript?.(transcript, meta);
						return;
					}
					this.completedUtterances.add(itemId);
					while (this.completedUtterances.size > 128) this.completedUtterances.delete(this.completedUtterances.values().next().value);
					this.utteranceBusy.delete(itemId);
					this.utteranceSpeech.delete(itemId);
					if (this.activeUtteranceId === itemId) this.activeUtteranceId = void 0;
					if (this.prefs.voiceprintEnabled && isActionableTranscript(transcript)) {
						this.voiceprintDispatchTail = this.voiceprintDispatchTail.then(() => this.dispatchVoiceprintTranscript(itemId, transcript, meta), () => this.dispatchVoiceprintTranscript(itemId, transcript, meta)).catch((error) => {
							if (!this.disposed) this.callbacks.onState("error", error instanceof Error ? error.message : String(error));
						});
						return;
					}
					this.voiceprintCapture.discard(itemId);
					if (this.prefs.voiceprintEnabled) meta.voiceprint = "unavailable";
					this.callbacks.onTranscript?.(transcript, meta).catch((error) => {
						if (!this.disposed) this.callbacks.onState("error", error instanceof Error ? error.message : String(error));
					});
				}
				if (type === "error") this.callbacks.onState("error", safeError(event));
			}
			handleTts(raw) {
				const event = jsonEvent(raw);
				if (event === void 0) return;
				if (event.type === "session.created") this.sendTts({
					type: "session.update",
					event_id: eventId(),
					session: {
						voice: this.prefs.qwenTtsVoice,
						mode: "commit",
						language_type: "Chinese",
						response_format: "pcm",
						sample_rate: 24e3
					}
				});
				if (event.type === "session.updated") {
					this.resolveTtsReady?.();
					this.resolveTtsReady = void 0;
					this.rejectTtsReady = void 0;
				}
				if (event.type === "response.audio.delta" && typeof event.delta === "string") {
					const epoch = this.speechEpoch;
					const socket = this.tts;
					if (!this.speechAudible) {
						this.speechAudible = true;
						this.callbacks.onState("speaking");
					}
					if (this.disposed || epoch !== this.speechEpoch || socket !== this.tts) return;
					this.pendingSpeechHasAudio = true;
					this.player.enqueue(event.delta, 24e3);
				}
				if (event.type === "response.done") {
					if (this.pendingSpeechHasAudio) {
						const text = this.pendingSpeechText;
						this.player.whenCurrentAudioEnds(() => this.callbacks.onPlaybackProgress?.(text));
					}
					this.pendingSpeechText = "";
					this.pendingSpeechHasAudio = false;
					this.speechResolve?.();
					this.speechResolve = void 0;
					this.speechReject = void 0;
				}
				if (event.type === "error") {
					const error = new Error(safeError(event));
					this.rejectTtsReady?.(error);
					this.speechReject?.(error);
					this.speechResolve = void 0;
					this.speechReject = void 0;
				}
			}
			appendAsr(pcm) {
				if (this.prefs.voiceprintEnabled) this.voiceprintCapture.push(pcm);
				this.sendAsr({
					type: "input_audio_buffer.append",
					event_id: eventId(),
					audio: base64(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
				});
			}
			beginVoiceprintCheck(itemId) {
				const audio = this.voiceprintCapture.takeBase64(itemId);
				if (audio === void 0) return Promise.resolve({
					status: "unavailable",
					error: "有效人声不足一秒"
				});
				if (!this.voiceprintConfigured) return Promise.resolve({
					status: "unavailable",
					error: "腾讯云声纹凭据未配置"
				});
				return checkVoiceprint(this.voiceprintEnrolled ? "verify" : "enroll", audio).then((result) => {
					if (result.status === "enrolled") this.voiceprintEnrolled = true;
					return result;
				});
			}
			async dispatchVoiceprintTranscript(itemId, transcript, meta) {
				if (this.disposed) return;
				const epoch = this.voiceprintEpoch;
				this.voiceprintCapture.stop(itemId);
				const voiceprint = await this.beginVoiceprintCheck(itemId);
				if (this.disposed || epoch !== this.voiceprintEpoch) return;
				if (voiceprint.status === "enrolled") {
					this.callbacks.onState("listening", "声纹录入成功；请再说一次刚才的指令");
					await this.callbacks.onTranscript?.("", {
						...meta,
						voiceprint: "unavailable"
					});
					return;
				}
				if (voiceprint.status !== "approved") {
					const detail = voiceprint.status === "rejected" ? `声纹未通过（${Math.round(voiceprint.score)}分）；文字已保留，可手动发送` : "声纹暂不可用；文字已保留，可手动发送";
					this.callbacks.onState("listening", detail);
					await this.callbacks.onTranscript?.(transcript, {
						...meta,
						capturedWhileBusy: true,
						voiceprint: voiceprint.status
					});
					return;
				}
				await this.callbacks.onTranscript?.(transcript, {
					...meta,
					voiceprint: "approved"
				});
			}
			sendAsr(event) {
				this.asr?.send(JSON.stringify(event));
			}
			sendTts(event) {
				this.tts?.send(JSON.stringify(event));
			}
		};
		function isLikelyTtsEcho(transcript, speech) {
			const heard = normalizeSpeech(transcript);
			const spoken = normalizeSpeech(speech);
			if (heard.length < 3 || spoken.length < 3 || isExplicitBargeIn(heard)) return false;
			if (spoken.includes(heard)) return true;
			if (heard.length >= 6 && heard.includes(spoken)) return true;
			const shorter = Math.min(heard.length, spoken.length);
			if (shorter / Math.max(heard.length, spoken.length) < .25) return false;
			if (longestCommonSubstring(heard, spoken) / shorter >= .72) return true;
			return bigramDice(heard, spoken) >= .62;
		}
		function isExplicitBargeIn(normalized) {
			return /^(停|停止|停下|打住|别说了|等一下|等等|不对|取消|取消任务|不要了|算了)$/.test(normalized);
		}
		function normalizeSpeech(text) {
			return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
		}
		function joinSpeechText(existing, addition) {
			const clean = addition.trim();
			return existing === "" ? clean : clean === "" ? existing : `${existing} ${clean}`;
		}
		function longestCommonSubstring(left, right) {
			const row = new Uint16Array(right.length + 1);
			let longest = 0;
			for (let i = 1; i <= left.length; i++) for (let j = right.length; j >= 1; j--) {
				const value = left.charAt(i - 1) === right.charAt(j - 1) ? (row[j - 1] ?? 0) + 1 : 0;
				row[j] = value;
				if (value > longest) longest = value;
			}
			return longest;
		}
		function bigramDice(left, right) {
			if (left.length < 2 || right.length < 2) return left === right ? 1 : 0;
			const counts = /* @__PURE__ */ new Map();
			for (let index = 0; index < left.length - 1; index++) {
				const gram = left.slice(index, index + 2);
				counts.set(gram, (counts.get(gram) ?? 0) + 1);
			}
			let overlap = 0;
			for (let index = 0; index < right.length - 1; index++) {
				const gram = right.slice(index, index + 2);
				const count = counts.get(gram) ?? 0;
				if (count <= 0) continue;
				overlap++;
				counts.set(gram, count - 1);
			}
			return 2 * overlap / (left.length + right.length - 2);
		}
		var PcmPlayer = class {
			context;
			gain;
			nextStart = 0;
			sources = /* @__PURE__ */ new Set();
			idleWaiters = [];
			paused = false;
			lastSource;
			completionMarkers = /* @__PURE__ */ new Map();
			get isPlaying() {
				return this.sources.size > 0;
			}
			enqueue(encoded, sampleRate) {
				const bytes = fromBase64(encoded);
				if (bytes.byteLength < 2) return;
				const context = this.context ??= new AudioContext();
				if (this.paused && context.state !== "suspended") context.suspend();
				if (this.gain === void 0) {
					this.gain = context.createGain();
					this.gain.connect(context.destination);
				}
				const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
				const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
				for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768;
				const buffer = context.createBuffer(1, samples.length, sampleRate);
				buffer.copyToChannel(samples, 0);
				const source = context.createBufferSource();
				source.buffer = buffer;
				source.connect(this.gain);
				const start = Math.max(context.currentTime + .02, this.nextStart);
				source.start(start);
				this.nextStart = start + buffer.duration;
				this.sources.add(source);
				this.lastSource = source;
				source.onended = () => {
					this.sources.delete(source);
					const markers = this.completionMarkers.get(source);
					this.completionMarkers.delete(source);
					markers?.forEach((marker) => marker());
					this.resolveIdle();
				};
			}
			whenCurrentAudioEnds(callback) {
				const last = this.lastSource;
				if (last === void 0) return;
				if (!this.sources.has(last)) {
					callback();
					return;
				}
				const markers = this.completionMarkers.get(last) ?? [];
				markers.push(callback);
				this.completionMarkers.set(last, markers);
			}
			pause() {
				if (this.paused) return;
				this.paused = true;
				this.context?.suspend();
			}
			resume() {
				if (!this.paused) return;
				this.paused = false;
				this.context?.resume();
			}
			stop() {
				this.completionMarkers.clear();
				this.lastSource = void 0;
				this.resume();
				for (const source of this.sources) try {
					source.stop();
				} catch {}
				this.sources.clear();
				this.nextStart = 0;
				this.resolveIdle();
			}
			async waitUntilIdle() {
				if (this.sources.size === 0) return;
				await new Promise((resolve) => this.idleWaiters.push(resolve));
			}
			resolveIdle() {
				if (this.sources.size !== 0) return;
				this.idleWaiters.splice(0).forEach((resolve) => resolve());
			}
			dispose() {
				this.stop();
				this.context?.close();
				this.context = void 0;
				this.gain = void 0;
				this.paused = false;
			}
		};
		function proxyUrl(kind, prefs) {
			const protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const service = prefs.speechService ?? "token-plan";
			const query = new URLSearchParams({
				service,
				...kind === "asr" ? { engine: prefs.asrEngine ?? "cloud" } : {},
				workspaceId: service === "token-plan" ? "token-plan" : prefs.qwenWorkspaceId,
				region: service === "token-plan" ? "cn-beijing" : prefs.qwenRegion,
				model: kind === "asr" ? prefs.qwenAsrModel : prefs.qwenTtsModel
			});
			return `${protocol}//${location.host}/dsh-realtime-voice/${kind}/qwen?${query}`;
		}
		function opened(socket) {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup();
					try {
						socket.close();
					} catch {}
					reject(/* @__PURE__ */ new Error("本地语音代理连接超时"));
				}, 1e4);
				const onOpen = () => {
					cleanup();
					resolve();
				};
				const onError = () => {
					cleanup();
					reject(/* @__PURE__ */ new Error("本地语音代理连接失败"));
				};
				const cleanup = () => {
					clearTimeout(timer);
					socket.removeEventListener("open", onOpen);
					socket.removeEventListener("error", onError);
				};
				socket.addEventListener("open", onOpen, { once: true });
				socket.addEventListener("error", onError, { once: true });
			});
		}
		function finishAndClose(socket) {
			if (socket?.readyState !== WebSocket.OPEN) return socket?.close();
			socket.send(JSON.stringify({
				type: "session.finish",
				event_id: eventId()
			}));
			setTimeout(() => socket.close(1e3, "finished"), 200);
		}
		function jsonEvent(raw) {
			try {
				const value = JSON.parse(typeof raw === "string" ? raw : String(raw));
				return typeof value === "object" && value !== null ? value : void 0;
			} catch {
				return;
			}
		}
		function safeError(event) {
			const error = typeof event.error === "object" && event.error !== null ? event.error : event;
			return typeof error.message === "string" ? error.message.slice(0, 300) : "语音服务错误";
		}
		function eventId() {
			return `event_${crypto.randomUUID()}`;
		}
		function isActionableTranscript(text) {
			const normalized = text.replace(/[\s，。！？,.!?、]/g, "");
			return normalized !== "" && !/^(嗯+|啊+|呃+|额+|唔+|哦+|哈+)$/.test(normalized);
		}
		/** Keep only speakable prose and stay below Qwen's weighted text limit. */
		function splitForTts(text, maxWeight = 1e3) {
			const spoken = text.replace(/```[\s\S]*?```/g, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/?[^>]+>/g, " ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, " ").replace(/[`*_#>|<]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
			if (spoken === "") return [];
			const units = spoken.split(/(?<=[。！？!?；;：:\n])/u).map((value) => value.trim()).filter(Boolean);
			const chunks = [];
			let current = "";
			for (const unit of units) for (const part of splitWeighted(unit, maxWeight)) {
				const candidate = current === "" ? part : `${current}${needsSpace(current, part) ? " " : ""}${part}`;
				if (ttsWeight(candidate) <= maxWeight) current = candidate;
				else {
					if (current !== "") chunks.push(current);
					current = part;
				}
			}
			if (current !== "") chunks.push(current);
			return chunks;
		}
		function splitWeighted(text, maxWeight) {
			const output = [];
			let current = "";
			let weight = 0;
			for (const char of text) {
				const charWeight = isCjk(char) ? 2 : 1;
				if (current !== "" && weight + charWeight > maxWeight) {
					output.push(current);
					current = "";
					weight = 0;
				}
				current += char;
				weight += charWeight;
			}
			if (current !== "") output.push(current);
			return output;
		}
		function ttsWeight(text) {
			let weight = 0;
			for (const char of text) weight += isCjk(char) ? 2 : 1;
			return weight;
		}
		function isCjk(char) {
			return /[\u3400-\u9fff\uf900-\ufaff]/u.test(char);
		}
		function needsSpace(left, right) {
			return /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
		}
		function base64(buffer) {
			const bytes = new Uint8Array(buffer);
			let binary = "";
			for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
			return btoa(binary);
		}
		function fromBase64(value) {
			const binary = atob(value);
			const bytes = new Uint8Array(binary.length);
			for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
			return bytes;
		}
		//#endregion
		//#region src/client/voice-summary.ts
		/** Streams the main model's visible prose; code and markup never become speech. */
		var VoiceSummaryStream = class {
			emit;
			input = "";
			sentence = "";
			fence = "";
			comment = false;
			received = false;
			finished = false;
			constructor(emit) {
				this.emit = emit;
			}
			push(delta) {
				if (this.finished || delta === "") return;
				this.received = true;
				this.input += delta;
				this.drain(false);
			}
			finish(finalText) {
				if (this.finished) return;
				if (!this.received) this.input = finalText;
				this.drain(true);
				this.flush();
				this.finished = true;
			}
			drain(final) {
				while (this.input !== "") {
					if (this.fence !== "") {
						const end = this.input.indexOf("\n");
						if (end < 0 && !final) return;
						const line = end < 0 ? this.input : this.input.slice(0, end);
						this.input = end < 0 ? "" : this.input.slice(end + 1);
						const marker = line.trim();
						if (marker.length >= this.fence.length && [...marker].every((char) => char === this.fence[0])) this.fence = "";
						continue;
					}
					if (this.comment) {
						const end = this.input.indexOf("-->");
						if (end < 0) {
							this.input = final ? "" : this.input.slice(-2);
							return;
						}
						this.input = this.input.slice(end + 3);
						this.comment = false;
						continue;
					}
					if (!final && [
						"<",
						"<!",
						"<!-",
						"!",
						"`",
						"``",
						"~",
						"~~"
					].includes(this.input)) return;
					if (this.input.startsWith("<!--")) {
						this.input = this.input.slice(4);
						this.comment = true;
						continue;
					}
					const fence = /^(`{3,}|~{3,})/.exec(this.input);
					if (fence !== null) {
						const end = this.input.indexOf("\n");
						if (end < 0) {
							if (final) this.input = "";
							return;
						}
						this.flush();
						this.fence = fence[0];
						this.input = this.input.slice(end + 1);
						continue;
					}
					if (/^<\/?[a-z]/iu.test(this.input)) {
						const end = this.input.indexOf(">");
						if (end < 0) {
							if (final) this.input = "";
							return;
						}
						this.input = this.input.slice(end + 1);
						continue;
					}
					if (this.input.startsWith("`")) {
						const marker = this.input.startsWith("``") ? "``" : "`";
						const end = this.input.indexOf(marker, marker.length);
						if (end < 0 && !final) return;
						this.accept(this.input.slice(marker.length, end < 0 ? void 0 : end));
						this.input = end < 0 ? "" : this.input.slice(end + marker.length);
						continue;
					}
					if (/^!?\[/u.test(this.input)) {
						const start = this.input.startsWith("!") ? 2 : 1;
						const labelEnd = this.input.indexOf("]", start);
						if (labelEnd < 0 || labelEnd === this.input.length - 1 && !final) {
							if (!final) return;
						} else if (this.input[labelEnd + 1] === "(") {
							let depth = 1;
							let end = labelEnd + 2;
							for (; end < this.input.length && depth > 0; end++) {
								if (this.input[end] === "(") depth++;
								if (this.input[end] === ")") depth--;
							}
							if (depth > 0 && !final) return;
							this.accept(this.input.slice(start, labelEnd));
							this.input = depth > 0 ? "" : this.input.slice(end);
							continue;
						}
					}
					const next = /[`<\[!~\n]/u.exec(this.input.slice(1));
					const length = next === null ? this.input.length : next.index + 1;
					if (this.input[0] === "\n") {
						this.flush();
						this.input = this.input.slice(1);
					} else {
						this.accept(this.input.slice(0, length));
						this.input = this.input.slice(length);
					}
				}
			}
			accept(text) {
				this.sentence += text;
				let boundary = /[。！？!?；;]+[”’」』】）)]*|\.(?=\s)/u.exec(this.sentence);
				while (boundary !== null) {
					const end = boundary.index + boundary[0].length;
					const complete = this.sentence.slice(0, end);
					this.sentence = this.sentence.slice(end);
					this.speak(complete);
					boundary = /[。！？!?；;]+[”’」』】）)]*|\.(?=\s)/u.exec(this.sentence);
				}
			}
			flush() {
				this.speak(this.sentence);
				this.sentence = "";
			}
			speak(text) {
				const clean = text.replace(/^\s*(?:#{1,6}\s+|>\s*|[-+*]\s+|\d+[.)、]\s*)/u, "").replace(/\*+/gu, "").replace(/(?<!\w)_{1,2}|_{1,2}(?!\w)/gu, "").replace(/[\[\]`~]/gu, "").replace(/\s+/gu, " ").trim();
				if (clean !== "") this.emit(clean);
			}
		};
		//#endregion
		//#region src/turn-decision.ts
		const TURN_ACTIONS = [
			"wait",
			"submit",
			"backchannel",
			"interrupt",
			"interject",
			"cancel"
		];
		//#endregion
		//#region src/client/controller.ts
		/** Owns turn decisions and draft ownership; capture, generation and playback may overlap. */
		var VoiceController = class {
			sessionId;
			bridge;
			createConnection;
			decide;
			connection;
			epoch = 0;
			listeners = /* @__PURE__ */ new Set();
			snapshot = {
				state: "idle",
				detail: "",
				provider: "qwen",
				userSpeaking: false,
				mainBusy: false,
				playback: "idle",
				transcript: ""
			};
			stopObserving;
			contextTimer;
			draft;
			boundDraft = "";
			draftRev;
			writingDraft = false;
			ownsDraft = false;
			finals = [];
			partial = "";
			stablePartial = "";
			partialId;
			consumedPrefix;
			finalIds = /* @__PURE__ */ new Set();
			pendingFinals = /* @__PURE__ */ new Set();
			revision = 0;
			speechActive = false;
			speechEndedAt;
			output;
			heardText = "";
			interrupted = false;
			playback = "idle";
			nativePending = false;
			submitTimer;
			decisionTimer;
			decisionAbort;
			decisionDirty = false;
			interjection;
			lastInterjectionAt = -Infinity;
			trace = {};
			latency;
			audioInfo;
			voiceprint;
			constructor(sessionId, bridge, createConnection = (prefs, callbacks) => new QwenPipelineConnection(prefs, callbacks), decide = requestTurnDecision) {
				this.sessionId = sessionId;
				this.bridge = bridge;
				this.createConnection = createConnection;
				this.decide = decide;
			}
			subscribe = (listener) => {
				this.listeners.add(listener);
				return () => this.listeners.delete(listener);
			};
			getSnapshot = () => this.snapshot;
			bindDraft(target) {
				const value = target.getDraft();
				const rev = target.getDraftRev?.();
				if (rev !== void 0 && this.draftRev !== void 0 && rev < this.draftRev) return () => {};
				if (this.writingDraft && value === this.boundDraft) this.writingDraft = false;
				else if (value !== this.boundDraft || rev !== void 0 && this.draftRev !== void 0 && rev !== this.draftRev) {
					this.ownsDraft = false;
					this.writingDraft = false;
					this.invalidateDecision();
					this.cancelUnheardInterjection();
					if (value === "" && this.boundDraft !== "") {
						this.finals = [];
						this.partial = "";
						this.stablePartial = "";
						this.partialId = void 0;
						this.consumedPrefix = void 0;
						this.voiceprint = void 0;
					}
				}
				this.boundDraft = value;
				this.draftRev = rev;
				this.draft = target;
				return () => {
					if (this.draft === target) this.draft = void 0;
				};
			}
			async toggle() {
				if (this.connection) return this.stop();
				const epoch = ++this.epoch;
				this.publish("connecting", "正在连接语音服务");
				let source;
				source = this.createConnection(loadPrefs(), {
					onState: (state, detail) => {
						if (this.connection !== source || this.epoch !== epoch) return;
						if (state === "error") {
							this.publish("error", detail ?? "语音连接失败");
							return;
						}
						if (state === "speaking") {
							if (!this.output || this.output.muted || this.output.source !== source) return;
							const trace = this.trace;
							if (trace.turn === this.output.turn && trace.userEnd !== void 0 && trace.submit !== void 0 && trace.firstAudio === void 0) {
								trace.firstAudio = Date.now();
								const points = [
									[
										"尾静音",
										trace.userEnd,
										trace.endpoint
									],
									[
										"ASR",
										trace.endpoint,
										trace.final
									],
									[
										"轮次等待",
										trace.final,
										trace.decisionStart ?? trace.submit
									],
									[
										"决策",
										trace.decisionStart,
										trace.decisionEnd
									],
									[
										"主模型首字",
										trace.submit,
										trace.firstText
									],
									[
										"分句等待",
										trace.firstText,
										trace.tts
									],
									[
										"TTS 首音频",
										trace.tts,
										trace.firstAudio
									]
								];
								this.latency = {
									totalMs: trace.firstAudio - trace.userEnd,
									stages: points.flatMap(([name, from, to]) => from === void 0 || to === void 0 ? [] : [{
										name,
										ms: Math.max(0, to - from)
									}])
								};
							}
							const candidate = this.interjection;
							if (candidate && !candidate.delivered) {
								if (candidate.abort.signal.aborted || this.transcript() !== candidate.text) {
									this.cancelUnheardInterjection();
									return;
								}
								candidate.delivered = true;
								if (this.partial) this.consumedPrefix = {
									id: this.partialId,
									text: this.partial
								};
								this.discardOwnedInput();
								this.playback = "playing";
							} else {
								this.playback = this.speechActive ? "paused" : "playing";
								if (this.speechActive) source.pauseSpeech?.();
							}
						}
						this.publish(state === "connecting" ? "connecting" : void 0, detail);
					},
					onAudioInfo: (info) => {
						if (this.connection === source && this.epoch === epoch) {
							this.audioInfo = info;
							this.publish();
						}
					},
					onSpeechStart: (meta) => {
						if (this.connection !== source || this.epoch !== epoch) return;
						this.trace = {};
						this.pendingFinals.add(meta?.utteranceId);
						this.speechActive = true;
						this.speechEndedAt = void 0;
						const candidate = this.interjection;
						const continuingInterjection = candidate !== void 0 && !candidate.delivered && meta?.utteranceId !== void 0 && meta.utteranceId === candidate.utteranceId;
						if (candidate && !candidate.delivered && !continuingInterjection) this.cancelUnheardInterjection();
						if (continuingInterjection) source.resumeSpeech?.();
						else if (this.output && !this.output.muted) {
							source.pauseSpeech?.();
							this.playback = "paused";
						}
						this.invalidateDecision();
						this.publish(void 0, "正在听你说");
					},
					onSpeechEnd: (meta) => {
						if (this.connection !== source || this.epoch !== epoch) return;
						this.speechActive = false;
						this.speechEndedAt = Date.now() - (meta?.silenceMs ?? 0);
						this.trace.userEnd = this.speechEndedAt;
						this.trace.endpoint = Date.now();
						this.invalidateDecision();
						this.scheduleDecision(Math.max(0, loadPrefs().qwenMergeMs - (meta?.silenceMs ?? 0)));
						this.publish();
					},
					onPartialTranscript: (text, meta) => {
						if (this.epoch === epoch) this.receivePartial(source, text, meta);
					},
					onTranscript: async (text, meta) => {
						if (this.epoch === epoch) this.receiveFinal(source, text, meta);
					},
					onPlaybackProgress: (text) => {
						if (this.connection !== source || this.epoch !== epoch) return;
						this.heardText = `${this.heardText}${text}`.slice(-2e3);
					}
				});
				this.connection = source;
				try {
					this.stopObserving = this.bridge.observeSession(this.sessionId, {
						onTurnStart: (turn) => {
							if (this.epoch === epoch) this.beginOutput(source, turn);
						},
						onTextDelta: (turn, delta) => {
							if (this.connection !== source || this.epoch !== epoch) return;
							if (this.output?.turn === turn && !this.output.muted) {
								if (this.trace.turn === turn) this.trace.firstText ??= Date.now();
								this.output.stream.push(delta);
							}
						},
						onTextReset: (turn, reason) => {
							if (this.connection !== source || this.epoch !== epoch) return;
							const output = this.output;
							if (!output || output.turn !== turn || output.muted) return;
							if (reason === "retry") {
								output.speechRevision++;
								output.pending = [];
								source.cancelSpeech?.();
								if (this.playback !== "paused") this.playback = "idle";
							}
							output.stream = this.createSpeechStream(output);
						},
						onTurnEnd: (turn, result) => {
							if (this.connection === source && this.epoch === epoch) this.finishOutput(turn, result);
						}
					});
					await this.bridge.setVoiceMode(this.sessionId, true);
					if (this.connection !== source || this.epoch !== epoch) return;
					await source.connect();
					if (this.connection !== source || this.epoch !== epoch) {
						source.disconnect();
						return;
					}
					this.contextTimer = setInterval(() => {
						this.bridge.setVoiceMode(this.sessionId, true, void 0, {
							heardText: this.heardText,
							interrupted: this.interrupted,
							interject: !!this.interjection
						}).catch(() => {
							if (this.connection === source) this.publish(void 0, "语音上下文更新失败，请检查 Harness 连接");
						});
					}, 6e5);
					this.publish(void 0, "开始说话，完整表达后自动发送");
				} catch (error) {
					if (this.connection !== source || this.epoch !== epoch) return;
					this.stop();
					this.publish("error", error instanceof Error ? error.message : "语音连接失败");
				}
			}
			stop() {
				this.epoch++;
				this.invalidateDecision();
				this.decisionAbort?.abort();
				this.decisionAbort = void 0;
				this.interjection?.abort.abort();
				this.interjection = void 0;
				this.clearSubmitTimer();
				this.stopObserving?.();
				this.stopObserving = void 0;
				if (this.contextTimer) clearInterval(this.contextTimer);
				this.contextTimer = void 0;
				this.output = void 0;
				const source = this.connection;
				this.connection = void 0;
				source?.disconnect();
				if (source) this.bridge.setVoiceMode(this.sessionId, false).catch(() => {});
				this.speechActive = false;
				this.speechEndedAt = void 0;
				this.playback = "idle";
				this.nativePending = false;
				this.finals = [];
				this.partial = "";
				this.stablePartial = "";
				this.partialId = void 0;
				this.consumedPrefix = void 0;
				this.finalIds.clear();
				this.pendingFinals.clear();
				this.ownsDraft = false;
				this.publish("idle", "");
			}
			dispose() {
				this.stop();
				this.listeners.clear();
			}
			receivePartial(source, text, meta = {}) {
				if (this.connection !== source || meta.utteranceId && this.finalIds.has(meta.utteranceId)) return;
				if (meta.likelyEcho) return;
				text = this.unconsumed(text.trim(), meta.utteranceId);
				if (this.partial === text && this.partialId === meta.utteranceId) return;
				this.stablePartial = this.partialId === meta.utteranceId ? commonPrefix(this.partial, text) : "";
				this.partial = text;
				this.partialId = meta.utteranceId;
				this.invalidateDecision();
				if (this.interjection && !this.interjection.delivered && this.transcript() !== this.interjection.text) this.cancelUnheardInterjection();
				this.publish();
				if (this.output || loadPrefs().proactiveEnabled) this.scheduleDecision(200);
			}
			receiveFinal(source, text, meta = {}) {
				if (this.connection !== source) return;
				this.trace.final = Date.now();
				this.pendingFinals.delete(meta.utteranceId);
				if (meta.utteranceId) {
					if (this.finalIds.has(meta.utteranceId)) return;
					this.finalIds.add(meta.utteranceId);
					if (this.finalIds.size > 128) this.finalIds.delete(this.finalIds.values().next().value);
				}
				text = this.unconsumed(text.trim(), meta.utteranceId);
				if (!this.partialId || !meta.utteranceId || this.partialId === meta.utteranceId) {
					this.partial = "";
					this.stablePartial = "";
					this.partialId = void 0;
				}
				this.voiceprint = meta.voiceprint;
				if (meta.likelyEcho || !text) {
					this.invalidateDecision();
					if (!this.speechActive) this.resumeOutput();
					this.publish();
					return;
				}
				this.finals.push(text);
				this.stageDraft(text);
				this.invalidateDecision();
				if (this.interjection && !this.interjection.delivered && this.transcript() !== this.interjection.text) this.cancelUnheardInterjection();
				if (isExplicitCancel(text)) {
					this.cancelTask();
					return;
				}
				const quietFor = this.speechEndedAt === void 0 ? 0 : Date.now() - this.speechEndedAt;
				this.scheduleDecision(Math.max(0, loadPrefs().qwenMergeMs - quietFor));
				this.publish(void 0, "正在判断是否说完；继续说会合并");
			}
			transcript() {
				return [...this.finals, this.partial].filter(Boolean).join("\n");
			}
			unconsumed(text, id) {
				const prefix = this.consumedPrefix;
				if (prefix && prefix.id === id && text.startsWith(prefix.text)) return text.slice(prefix.text.length).trim();
				return text;
			}
			stageDraft(text) {
				const draft = this.draft;
				if (!draft || (draft.getPhase?.() ?? "plain") !== "plain") {
					this.ownsDraft = false;
					return;
				}
				const existing = this.writingDraft ? this.boundDraft : draft.getDraft();
				const canOwn = existing.trim() === "" || this.ownsDraft && existing === this.boundDraft;
				this.boundDraft = existing.trimEnd() ? `${existing.trimEnd()}\n${text}` : text;
				this.ownsDraft = canOwn;
				this.writingDraft = true;
				draft.setDraft(this.boundDraft);
			}
			invalidateDecision() {
				this.revision++;
				this.decisionAbort?.abort();
				if (this.decisionTimer) clearTimeout(this.decisionTimer);
				this.decisionTimer = void 0;
				this.decisionDirty = false;
			}
			scheduleDecision(delay) {
				if (!this.connection) return;
				if (this.decisionTimer) clearTimeout(this.decisionTimer);
				this.decisionTimer = setTimeout(() => {
					this.decisionTimer = void 0;
					this.evaluateTurn();
				}, delay);
			}
			async evaluateTurn() {
				const source = this.connection;
				if (!source) return;
				if (this.decisionAbort) {
					this.decisionDirty = true;
					return;
				}
				const transcript = this.transcript();
				if (!transcript) {
					if (!this.speechActive) this.resumeOutput();
					return;
				}
				const state = {
					transcript: transcript.slice(-8e3),
					stableText: [...this.finals, this.stablePartial].filter(Boolean).join("\n").slice(-8e3),
					revision: this.revision,
					isFinal: !this.partial && this.finals.length > 0 && this.pendingFinals.size === 0,
					userSpeaking: this.speechActive,
					assistantSpeaking: !!this.output && !this.output.muted,
					mainBusy: this.isMainBusy(),
					recentAssistantText: this.heardText
				};
				if (!state.userSpeaking && this.pendingFinals.size > 0 && !state.assistantSpeaking && !state.mainBusy) return;
				const prefs = loadPrefs();
				if (!state.isFinal && !state.assistantSpeaking && !state.mainBusy && (!prefs.proactiveEnabled || !state.stableText.trim())) return;
				if (!prefs.decisionEnabled) {
					if (state.isFinal && !state.userSpeaking && !state.mainBusy && !state.assistantSpeaking) await this.submitDraft(source, state.revision);
					return;
				}
				const controller = new AbortController();
				this.decisionAbort = controller;
				try {
					if (state.isFinal) this.trace.decisionStart = Date.now();
					const decision = await this.decide(state, controller.signal);
					if (this.connection !== source || controller.signal.aborted || decision.revision !== this.revision) return;
					if (state.isFinal) this.trace.decisionEnd = Date.now();
					switch (decision.action) {
						case "cancel":
							await this.cancelTask();
							break;
						case "backchannel":
							if (state.isFinal && !this.speechActive) {
								this.discardOwnedInput();
								this.resumeOutput();
							}
							break;
						case "interrupt":
							this.muteOutput();
							if (state.isFinal && !this.speechActive && !this.isMainBusy()) this.scheduleDecision(0);
							break;
						case "submit":
							if (state.isFinal && !this.speechActive && !this.isMainBusy() && !this.output) await this.submitDraft(source, state.revision);
							break;
						case "interject":
							if (prefs.proactiveEnabled && state.stableText && !this.output && !this.isMainBusy()) this.startInterjection(source, state);
							break;
						case "wait": this.publish(void 0, "继续听；已识别文字保留在输入框");
					}
				} catch (error) {
					if (this.connection === source && !controller.signal.aborted && state.revision === this.revision) this.publish(void 0, `轮次判断暂不可用，文字保留待手动发送：${error instanceof Error ? error.message : "请求失败"}`);
				} finally {
					if (this.decisionAbort === controller) this.decisionAbort = void 0;
					if (this.decisionDirty && this.connection === source) {
						this.decisionDirty = false;
						this.scheduleDecision(0);
					}
				}
			}
			draftIsOwned() {
				const draft = this.draft;
				if (!draft || !this.ownsDraft || draft.getDraft() !== this.boundDraft || (draft.getPhase?.() ?? "plain") !== "plain") return false;
				if (this.writingDraft) {
					this.writingDraft = false;
					this.draftRev = draft.getDraftRev?.();
				}
				return this.draftRev === void 0 || draft.getDraftRev?.() === this.draftRev;
			}
			async submitDraft(source, revision) {
				const prefs = loadPrefs();
				const voiceAllowed = prefs.voiceprintEnabled ? this.voiceprint === "approved" : prefs.voiceDraftAllowWithoutVoiceprint;
				if (!prefs.voiceDraftAutoSend || !voiceAllowed || this.voiceprint === "rejected" || this.voiceprint === "unavailable" || !this.draftIsOwned() || !this.draft?.submit || this.nativePending || this.speechActive || this.pendingFinals.size > 0 || this.isMainBusy() || prefs.voiceDraftSensitiveDeny && isSensitiveDraft(this.boundDraft)) return;
				this.nativePending = true;
				try {
					await this.bridge.setVoiceMode(this.sessionId, true, void 0, {
						heardText: this.heardText,
						interrupted: this.interrupted
					});
					if (this.connection !== source || revision !== this.revision || !this.draftIsOwned() || this.speechActive || this.pendingFinals.size > 0) return;
					this.trace.submit = Date.now();
					this.draft.submit();
					this.finals = [];
					this.partial = "";
					this.stablePartial = "";
					this.ownsDraft = false;
					this.invalidateDecision();
					this.publish("working", "已发送给当前主模型");
					if (this.nativePending) this.submitTimer = setTimeout(() => {
						this.nativePending = false;
						this.submitTimer = void 0;
						this.publish(void 0, "Harness 尚未确认发送，请检查输入框");
					}, 1e4);
				} catch (error) {
					this.publish(void 0, `发送失败，文字已保留：${error instanceof Error ? error.message : "Harness 不可用"}`);
				} finally {
					if (!this.submitTimer) this.nativePending = false;
				}
			}
			async startInterjection(source, state) {
				if (this.interjection || Date.now() - this.lastInterjectionAt < 8e3 || !this.draftIsOwned() && this.boundDraft.trim()) return;
				const candidate = {
					text: this.transcript(),
					utteranceId: this.partialId,
					abort: new AbortController(),
					delivered: false
				};
				this.interjection = candidate;
				this.lastInterjectionAt = Date.now();
				try {
					await this.bridge.setVoiceMode(this.sessionId, true, candidate.abort.signal, {
						heardText: this.heardText,
						interrupted: this.interrupted,
						interject: true
					});
					if (candidate.abort.signal.aborted || this.connection !== source || this.transcript() !== candidate.text || this.isMainBusy()) return;
					this.publish("working", "主模型正在准备简短澄清");
					const result = await this.bridge.delegate(this.sessionId, state.transcript, candidate.abort.signal);
					if (!result.ok && !candidate.abort.signal.aborted && this.connection === source) this.publish(void 0, result.error);
				} catch (error) {
					if (!candidate.abort.signal.aborted && this.connection === source) this.publish(void 0, `插话准备失败：${error instanceof Error ? error.message : "Harness 不可用"}`);
				} finally {
					if (this.interjection === candidate && (!this.output || this.output.muted)) this.clearInterjectionContext();
				}
			}
			cancelUnheardInterjection() {
				const candidate = this.interjection;
				if (!candidate || candidate.delivered) return;
				candidate.abort.abort();
				this.clearInterjectionContext();
				this.muteOutput();
			}
			clearInterjectionContext() {
				if (!this.interjection) return;
				this.interjection = void 0;
				const source = this.connection;
				const epoch = this.epoch;
				if (!source) return;
				this.bridge.setVoiceMode(this.sessionId, true, void 0, {
					heardText: this.heardText,
					interrupted: this.interrupted
				}).catch(() => {
					if (this.connection === source && this.epoch === epoch) this.publish(void 0, "插话上下文恢复失败，请检查 Harness 连接");
				});
			}
			beginOutput(source, turn) {
				if (this.connection !== source) return;
				this.clearSubmitTimer();
				this.nativePending = false;
				if (this.output) source.cancelSpeech?.();
				const output = {
					turn,
					source,
					stream: void 0,
					pending: [],
					draining: false,
					speechRevision: 0,
					muted: false,
					done: false
				};
				output.stream = this.createSpeechStream(output);
				this.output = output;
				if (this.trace.submit !== void 0) this.trace.turn = turn;
				this.heardText = "";
				this.interrupted = false;
				this.playback = "idle";
				this.invalidateDecision();
				source.setInputPhase?.("harness");
				this.publish("working", "当前主模型正在回答");
			}
			createSpeechStream(output) {
				return new VoiceSummaryStream((sentence) => {
					if (this.output !== output || output.muted) return;
					output.pending.push(sentence);
					this.drainOutput(output);
				});
			}
			async drainOutput(output) {
				const candidate = this.interjection;
				const interjecting = candidate !== void 0 && !candidate.abort.signal.aborted;
				if (output.draining || output.muted || this.output !== output || this.speechActive && !interjecting || this.playback === "paused") return;
				if (candidate && !candidate.delivered) {
					if (this.transcript() !== candidate.text) {
						this.cancelUnheardInterjection();
						return;
					}
					output.source.resumeSpeech?.();
				}
				const speechRevision = output.speechRevision;
				output.draining = true;
				try {
					while (this.output === output && output.speechRevision === speechRevision && !output.muted && this.playback !== "paused" && (!this.speechActive || this.interjection === candidate && interjecting) && output.pending.length) {
						const sentence = output.pending.shift();
						output.source.setInputPhase?.("tts-pending");
						if (this.trace.turn === output.turn) this.trace.tts ??= Date.now();
						await output.source.speak?.(sentence);
					}
					if (this.output !== output || output.speechRevision !== speechRevision || output.muted) return;
					if (!output.pending.length) {
						await output.source.waitForSpeechIdle?.();
						if (this.output !== output || output.speechRevision !== speechRevision || output.muted) return;
						this.playback = "idle";
						if (output.done && !output.pending.length) this.releaseOutput(output);
					}
				} catch (error) {
					if (this.output === output && output.speechRevision === speechRevision && !output.muted) {
						this.muteOutput();
						this.publish(void 0, `播报失败：${error instanceof Error ? error.message : "TTS 不可用"}`);
					}
				} finally {
					output.draining = false;
					if (this.output === output && !output.muted && output.pending.length && (!this.speechActive || this.interjection === candidate && interjecting)) this.drainOutput(output);
				}
			}
			finishOutput(turn, result) {
				const output = this.output;
				if (!output || output.turn !== turn) return;
				output.done = true;
				if (result.ok && !output.muted) output.stream.finish(result.text);
				else if (!result.ok) {
					this.muteOutput();
					if (!result.cancelled) this.publish(void 0, result.error);
				}
				if (output.muted || !output.draining && !output.pending.length && this.playback === "idle") this.releaseOutput(output);
				else this.drainOutput(output);
			}
			releaseOutput(output) {
				if (this.output !== output) return;
				this.output = void 0;
				this.clearInterjectionContext();
				this.playback = "idle";
				output.source.setInputPhase?.("listening");
				this.invalidateDecision();
				this.publish(void 0, "继续说话");
				if (this.transcript()) this.scheduleDecision(loadPrefs().voiceDraftDwellMs);
			}
			muteOutput() {
				const output = this.output;
				if (!output || output.muted) return;
				output.muted = true;
				output.pending = [];
				output.source.cancelSpeech?.();
				this.interrupted = true;
				this.playback = "idle";
				this.invalidateDecision();
				if (output.done) this.releaseOutput(output);
				this.publish(void 0, "已停播，继续听你说；后台任务仍由 Harness 管理");
			}
			resumeOutput() {
				const output = this.output;
				if (!output || output.muted || this.speechActive) return;
				output.source.resumeSpeech?.();
				this.playback = "playing";
				this.drainOutput(output);
				this.publish();
			}
			discardOwnedInput() {
				if (this.draftIsOwned()) {
					this.boundDraft = "";
					this.writingDraft = true;
					this.draft.setDraft("");
				}
				this.ownsDraft = false;
				this.finals = [];
				this.partial = "";
				this.stablePartial = "";
				this.invalidateDecision();
			}
			async cancelTask() {
				const source = this.connection;
				this.cancelUnheardInterjection();
				this.muteOutput();
				this.discardOwnedInput();
				try {
					const cancelled = await this.bridge.cancel(this.sessionId);
					if (this.connection === source) this.publish(void 0, cancelled ? "已请求停止当前任务" : "已停止播报");
				} catch {
					if (this.connection === source) this.publish(void 0, "播报已停止；Harness 任务取消失败");
				}
			}
			isMainBusy() {
				return this.nativePending || !!this.output && !this.output.done || this.bridge.isBusy?.(this.sessionId) === true;
			}
			clearSubmitTimer() {
				if (this.submitTimer) clearTimeout(this.submitTimer);
				this.submitTimer = void 0;
			}
			publish(state, detail = this.snapshot.detail) {
				const busy = this.isMainBusy();
				this.snapshot = {
					state: state ?? (this.playback === "playing" ? "speaking" : busy ? "working" : this.connection ? "listening" : "idle"),
					latency: this.latency,
					audioInfo: this.audioInfo,
					detail,
					provider: "qwen",
					userSpeaking: this.speechActive,
					mainBusy: busy,
					playback: this.playback,
					transcript: this.transcript()
				};
				this.listeners.forEach((listener) => listener());
			}
		};
		async function requestTurnDecision(state, signal) {
			const response = await fetch("/dsh-realtime-voice/decide", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(state),
				signal: AbortSignal.any([signal, AbortSignal.timeout(loadPrefs().decisionTimeoutMs + 500)])
			});
			if (!response.ok) throw new Error(`决策服务 HTTP ${response.status}`);
			const result = await response.json();
			if (!TURN_ACTIONS.includes(result.action) || result.revision !== state.revision) throw new Error("决策响应无效");
			return result;
		}
		function commonPrefix(left, right) {
			let index = 0;
			while (index < left.length && left[index] === right[index]) index++;
			return right.slice(0, index);
		}
		function isExplicitCancel(text) {
			return /^(停|停止|停下|别说了|取消|取消任务|停止任务|取消这次任务|不要了|算了)$/.test(text.replace(/[\s，。！？,.!?、]/g, ""));
		}
		function isSensitiveDraft(text) {
			return /(转账|汇款|付款|支付|购买|下单|发送验证码|验证码|密码|删除|清空|卸载|格式化|关机|重启|抹掉|永久)/.test(text);
		}
		//#endregion
		//#region src/client/components.tsx
		const styles = {
			button: {
				width: 32,
				height: 32,
				border: 0,
				borderRadius: 999,
				cursor: "pointer",
				display: "grid",
				placeItems: "center",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent"
			},
			active: {
				color: "#fff",
				background: "#2563eb"
			},
			dock: {
				margin: "0 auto 4px",
				maxWidth: 760,
				padding: "8px 12px",
				borderRadius: "10px 10px 0 0",
				fontSize: 12,
				color: "var(--dsw-alias-label-secondary)",
				background: "var(--dsw-specific-tip)"
			},
			card: { padding: "14px 16px" },
			row: {
				display: "grid",
				gridTemplateColumns: "170px 1fr",
				gap: 12,
				alignItems: "center",
				marginTop: 10
			},
			input: {
				minWidth: 0,
				padding: "7px 9px",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 7,
				background: "var(--dsw-alias-bg-base)",
				color: "inherit"
			}
		};
		function MicButton({ controller }) {
			const active = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot).state !== "idle";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				"aria-label": active ? "停止实时语音" : "开始实时语音",
				"aria-pressed": active,
				title: active ? "停止实时语音" : "开始实时语音",
				style: {
					...styles.button,
					...active ? styles.active : {}
				},
				onClick: () => {
					controller.toggle();
				},
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
					width: "19",
					height: "19",
					viewBox: "0 0 24 24",
					"aria-hidden": "true",
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
						fill: "currentColor",
						d: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm6-3a6 6 0 0 1-12 0H4a8 8 0 0 0 7 7.94V22h2v-2.06A8 8 0 0 0 20 12h-2Z"
					})
				})
			});
		}
		function VoiceStatus({ controller, input, inputActions }) {
			const snapshot = (0, react.useSyncExternalStore)(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
			(0, react.useEffect)(() => controller.bindDraft({
				getDraft: () => input.draft,
				getDraftRev: () => input.draftRev,
				getPhase: () => input.phase,
				setDraft: (text) => inputActions.setDraft(text),
				submit: () => inputActions.submit()
			}), [
				controller,
				input.draft,
				input.draftRev,
				input.phase,
				inputActions
			]);
			if (snapshot.state === "idle") return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				role: snapshot.state === "error" ? "alert" : "status",
				style: styles.dock,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
						{
							connecting: "正在连接",
							listening: "正在聆听",
							speaking: "正在说话",
							working: "主模型正在处理",
							error: "语音不可用"
						}[snapshot.state],
						snapshot.playback === "paused" ? " · 播放已暂停" : "",
						snapshot.detail ? `：${snapshot.detail}` : ""
					] }),
					snapshot.latency && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						style: { marginTop: 4 },
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
								"上轮说完至首音频 ",
								(snapshot.latency.totalMs / 1e3).toFixed(2),
								" 秒"
							] }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: snapshot.latency.stages.map((stage) => `${stage.name} ${stage.ms} ms`).join(" · ") }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: ["以 ASR 断句和音频到达时间估算，不含设备实际出声延迟。", snapshot.audioInfo?.echoCancellation === true ? "浏览器回声消除已启用。" : snapshot.audioInfo?.echoCancellation === false ? "浏览器未启用回声消除，建议使用耳机。" : ""] })
						]
					}),
					snapshot.transcript && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							marginTop: 4,
							whiteSpace: "pre-wrap",
							opacity: .8
						},
						children: snapshot.transcript
					})
				]
			});
		}
		function SettingsCard() {
			const prefs = (0, react.useSyncExternalStore)(subscribePrefs, loadPrefs, loadPrefs);
			const [advanced, setAdvanced] = (0, react.useState)(false);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: styles.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "实时语音与轮次判断" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "使用当前会话的主模型回答。说完自动发送，你可以随时开口打断。" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "语音服务",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: styles.input,
							value: prefs.speechService,
							onChange: (e) => updatePrefs({ speechService: e.currentTarget.value === "dashscope" ? "dashscope" : "token-plan" }),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "token-plan",
								children: "百炼 Token Plan"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "dashscope",
								children: "百炼按量服务"
							})]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "语音识别",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							style: styles.input,
							value: prefs.asrEngine,
							onChange: (e) => updatePrefs({ asrEngine: e.currentTarget.value === "local-sensevoice" ? "local-sensevoice" : "cloud" }),
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "cloud",
								children: "云端 ASR"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "local-sensevoice",
								children: "本地 SenseVoice"
							})]
						})
					}),
					prefs.asrEngine === "local-sensevoice" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: { opacity: .7 },
						children: "需在运行 DSH 的电脑上准备模型。切换后重新开启麦克风。"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "语音自动发送",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: prefs.voiceDraftAutoSend,
							onChange: (e) => updatePrefs({ voiceDraftAutoSend: e.currentTarget.checked })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "语义轮次判断",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: prefs.decisionEnabled,
							onChange: (e) => updatePrefs({ decisionEnabled: e.currentTarget.checked })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "允许主动澄清",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: prefs.proactiveEnabled,
							disabled: !prefs.decisionEnabled,
							onChange: (e) => updatePrefs({ proactiveEnabled: e.currentTarget.checked })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
						label: "TTS 音色",
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: styles.input,
							value: prefs.qwenTtsVoice,
							onChange: (e) => updatePrefs({ qwenTtsVoice: e.currentTarget.value })
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						"aria-expanded": advanced,
						style: {
							...styles.input,
							marginTop: 14,
							cursor: "pointer"
						},
						onClick: () => setAdvanced(!advanced),
						children: "高级设置"
					}),
					advanced && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						prefs.speechService === "dashscope" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "Workspace ID",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenWorkspaceId,
								onChange: (e) => updatePrefs({ qwenWorkspaceId: e.currentTarget.value })
							})
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "区域",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								style: styles.input,
								value: prefs.qwenRegion,
								onChange: (e) => updatePrefs({ qwenRegion: e.currentTarget.value === "ap-southeast-1" ? "ap-southeast-1" : "cn-beijing" }),
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "cn-beijing",
									children: "北京"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "ap-southeast-1",
									children: "新加坡"
								})]
							})
						})] }),
						prefs.asrEngine === "cloud" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "ASR 模型",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenAsrModel,
								onChange: (e) => updatePrefs({ qwenAsrModel: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "TTS 模型",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.qwenTtsModel,
								onChange: (e) => updatePrefs({ qwenTtsModel: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "决策模型",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								value: prefs.decisionModel,
								onChange: (e) => updatePrefs({ decisionModel: e.currentTarget.value })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "决策超时（毫秒）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: 250,
								max: 1e4,
								step: 250,
								value: prefs.decisionTimeoutMs,
								onChange: (e) => updatePrefs({ decisionTimeoutMs: e.currentTarget.valueAsNumber })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "续说等待（毫秒）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: 100,
								max: 5e3,
								step: 100,
								value: prefs.qwenMergeMs,
								onChange: (e) => updatePrefs({ qwenMergeMs: e.currentTarget.valueAsNumber })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "尾静音（毫秒）",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: 200,
								max: 6e3,
								step: 100,
								value: prefs.qwenSilenceMs,
								onChange: (e) => updatePrefs({ qwenSilenceMs: e.currentTarget.valueAsNumber })
							})
						}),
						prefs.asrEngine === "cloud" && prefs.speechService === "dashscope" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "人声阈值",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								style: styles.input,
								type: "number",
								min: -1,
								max: 1,
								step: .05,
								value: prefs.qwenVadThreshold,
								onChange: (e) => updatePrefs({ qwenVadThreshold: e.currentTarget.valueAsNumber })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							label: "敏感指令手动发送",
							children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: prefs.voiceDraftSensitiveDeny,
								onChange: (e) => updatePrefs({ voiceDraftSensitiveDeny: e.currentTarget.checked })
							})
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: { opacity: .7 },
							children: "Token Plan 凭据由 Harness Host 的 BAILIAN_TOKEN_PLAN_API_KEY 提供；主模型在会话的模型选择器中配置。"
						})
					] })
				]
			});
		}
		function Field({ label, children }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				style: styles.row,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: label }), children]
			});
		}
		//#endregion
		//#region src/client/index.ts
		const name = "dsh-realtime-voice-client";
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			const bridge = new HarnessBridge(ctx.sessions);
			const controllers = /* @__PURE__ */ new Map();
			hydrateFromHost();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === void 0) {
					controller = new VoiceController(sessionId, bridge);
					controllers.set(sessionId, controller);
				}
				return controller;
			};
			ctx.effect(() => () => {
				controllers.forEach((controller) => controller.dispose());
				controllers.clear();
				bridge.dispose();
			}, "dsh-realtime-voice: controller lifecycle");
			ctx.effect(() => ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "realtime-voice-mic",
				order: 30,
				inject: (sessionId) => ({ controller: controllerFor(sessionId) })
			}, MicButton)), "dsh-realtime-voice: mic button");
			ctx.effect(() => ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "realtime-voice-status",
				order: 80,
				inject: (sessionId) => ({ controller: controllerFor(sessionId) })
			}, VoiceStatus)), "dsh-realtime-voice: status dock");
			ctx.effect(() => ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "realtime-voice-settings",
				label: "实时语音",
				order: 25,
				inject: () => ({})
			}, SettingsCard)), "dsh-realtime-voice: settings");
		}
		//#endregion
		exports.HarnessBridge = HarnessBridge;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map