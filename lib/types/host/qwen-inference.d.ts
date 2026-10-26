type Event = Record<string, unknown>;
export declare const TOKEN_PLAN_ASR_ENDPOINT = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
/** Token Plan's ASR model accepts complete audio, not a realtime input stream.
 * This adapter produces explicitly provisional rolling-window transcriptions.
 * Local energy VAD controls pauses independently of the HTTP round trip.
 * https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
 */
export declare class QwenHttpAsr {
    private readonly model;
    private readonly key;
    private readonly emit;
    private readonly request;
    private readonly abort;
    private configured;
    private closed;
    private silenceSamples;
    private preRoll;
    private onsetSamples;
    private quietSamples;
    private current;
    private pending;
    private inFlight;
    constructor(model: string, key: string, emit: (event: Event) => void, request?: typeof fetch);
    client(event: Event): void;
    close(): void;
    private enqueue;
    private drain;
    private fail;
}
/** Converts the browser's TTS buffer events to Qwen-Audio's task protocol.
 * Each committed chunk owns one task; only the caller's text is synthesized.
 * https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events
 */
export declare class QwenInferenceTts {
    private readonly model;
    private readonly send;
    private readonly emit;
    private voice;
    private configured;
    private text;
    private task;
    constructor(model: string, send: (event: Event) => void, emit: (event: Event) => void);
    open(): void;
    client(event: Event): void;
    upstream(data: Buffer, binary: boolean): void;
    private fail;
}
export {};
