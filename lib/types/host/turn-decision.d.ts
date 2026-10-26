import { type TurnDecision, type TurnDecisionState } from '../turn-decision.ts';
export declare const TURN_DECISION_ENDPOINT = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone";
export declare function parseTurnDecisionState(value: unknown): TurnDecisionState;
export declare function decideTurn(input: unknown, key: string, signal: AbortSignal, options?: {
    model?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
}): Promise<TurnDecision>;
