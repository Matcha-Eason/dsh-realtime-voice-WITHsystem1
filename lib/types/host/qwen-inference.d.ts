import { WindowedAsr } from './windowed-asr.ts';
type Event = Record<string, unknown>;
export declare const TOKEN_PLAN_ASR_ENDPOINT = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
/** Token Plan HTTP transport; windowing and local recognition share one scheduler. */
export declare class QwenHttpAsr extends WindowedAsr {
    constructor(model: string, key: string, emit: (event: Event) => void, request?: typeof fetch);
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
