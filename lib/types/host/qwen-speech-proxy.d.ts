import { LocalSenseVoice } from './local-asr.ts';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket from 'ws';
export type QwenSpeechKind = 'asr' | 'tts';
export type QwenSpeechService = 'token-plan' | 'dashscope';
/** Validates the billing boundary and selects only the protocol this proxy carries. */
export declare function resolveQwenSpeechRoute(kind: QwenSpeechKind, params: URLSearchParams): {
    service: QwenSpeechService;
    workspaceId: string;
    endpoint: string;
    model: string;
    protocol: 'realtime' | 'inference' | 'http';
};
export declare class QwenSpeechProxy {
    private readonly resolveKey;
    private readonly connectUpstream;
    private readonly requestAsr;
    private readonly localAsr;
    private readonly server;
    private readonly sockets;
    constructor(resolveKey: (service: QwenSpeechService) => Promise<string | undefined>, connectUpstream?: (endpoint: string, options: WebSocket.ClientOptions) => WebSocket, requestAsr?: typeof fetch, localAsr?: Pick<LocalSenseVoice, 'prepare' | 'recognize'>);
    handle: (kind: QwenSpeechKind, req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
    private acceptAsr;
    close(): void;
}
