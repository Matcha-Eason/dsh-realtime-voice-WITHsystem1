export declare const TURN_ACTIONS: readonly ["wait", "submit", "backchannel", "interrupt", "interject", "cancel"];
export type TurnAction = typeof TURN_ACTIONS[number];
/** A snapshot of speech and playback, never an instruction to the answering model. */
export interface TurnDecisionState {
    transcript: string;
    stableText: string;
    revision: number;
    isFinal: boolean;
    userSpeaking: boolean;
    assistantSpeaking: boolean;
    mainBusy: boolean;
    recentAssistantText: string;
}
export interface TurnDecision {
    action: TurnAction;
    revision: number;
}
export declare const DEFAULT_TURN_DECISION_MODEL = "decision-model-preview";
