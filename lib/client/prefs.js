const KEY = 'dsh-realtime-voice:prefs:v1';
const PREFS_URL = '/dsh-realtime-voice/prefs';
const DEFAULTS = {
    provider: 'qwen',
    speechService: 'token-plan',
    decisionEnabled: true,
    decisionModel: 'decision-model-preview',
    decisionTimeoutMs: 2000,
    proactiveEnabled: true,
    qwenWorkspaceId: 'token-plan',
    qwenRegion: 'cn-beijing',
    qwenAsrModel: 'qwen-audio-3.0-asr-flash',
    qwenTtsModel: 'qwen-audio-3.0-tts-plus',
    qwenTtsVoice: 'longanlingxin',
    qwenVadThreshold: 0.85,
    qwenSilenceMs: 700,
    qwenMergeMs: 400,
    voiceDraftAutoSend: true,
    voiceDraftDwellMs: 700,
    voiceDraftAllowWithoutVoiceprint: true,
    voiceDraftSensitiveDeny: true,
    voiceprintEnabled: false,
    voiceprintThreshold: 75,
    instructions: '请用自然、简洁、适合口语播报的中文表达，并允许用户随时打断。',
};
let cache;
const listeners = new Set();
export function loadPrefs() {
    if (cache !== undefined)
        return cache;
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}');
        cache = sanitize({ ...DEFAULTS, ...parsed });
    }
    catch {
        cache = { ...DEFAULTS };
    }
    return cache;
}
export function updatePrefs(patch) {
    cache = sanitize({ ...loadPrefs(), ...patch });
    localStorage.setItem(KEY, JSON.stringify(cache));
    persistPrefs(cache);
    listeners.forEach(listener => listener());
    return cache;
}
/** Push the current prefs to the host bridge so they survive browser switches and port changes. */
export function persistPrefs(prefs) {
    try {
        fetch(PREFS_URL, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(prefs),
            cache: 'no-store',
        }).catch(() => { });
    }
    catch {
        // fetch unavailable; localStorage remains the cache
    }
}
function hasCustomPrefs(prefs) {
    return Object.keys(DEFAULTS).some(key => prefs[key] !== DEFAULTS[key]);
}
/**
 * One-shot hydration: pull prefs persisted on the host (settings document) and
 * merge them over localStorage. When the host has nothing yet but this browser
 * already has custom values (pre-fix state), push them up so they are saved.
 */
export function hydrateFromHost() {
    fetch(PREFS_URL, { cache: 'no-store', headers: { accept: 'application/json' } })
        .then(response => response.ok ? response.json() : null)
        .then((data) => {
        const local = loadPrefs();
        if (data && data.hasUserData && typeof data.prefs === 'object' && data.prefs !== null) {
            cache = sanitize({ ...local, ...data.prefs });
            localStorage.setItem(KEY, JSON.stringify(cache));
            listeners.forEach(listener => listener());
        }
        else if (hasCustomPrefs(local)) {
            persistPrefs(local);
        }
    })
        .catch(() => {
        // host bridge unavailable; keep localStorage
    });
}
export function subscribePrefs(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
function sanitize(value) {
    const qwenMergeMs = numberInRange(value.qwenMergeMs, 100, 5000, DEFAULTS.qwenMergeMs);
    return {
        provider: 'qwen',
        speechService: value.speechService === 'dashscope' ? 'dashscope' : 'token-plan',
        decisionEnabled: value.decisionEnabled !== false,
        decisionModel: text(value.decisionModel, 128) || DEFAULTS.decisionModel,
        decisionTimeoutMs: numberInRange(value.decisionTimeoutMs, 250, 10000, DEFAULTS.decisionTimeoutMs),
        proactiveEnabled: value.proactiveEnabled !== false,
        qwenWorkspaceId: text(value.qwenWorkspaceId, 128),
        qwenRegion: value.qwenRegion === 'ap-southeast-1' ? 'ap-southeast-1' : 'cn-beijing',
        qwenAsrModel: text(value.qwenAsrModel, 128) || DEFAULTS.qwenAsrModel,
        qwenTtsModel: text(value.qwenTtsModel, 128) || DEFAULTS.qwenTtsModel,
        qwenTtsVoice: text(value.qwenTtsVoice, 128) || DEFAULTS.qwenTtsVoice,
        qwenVadThreshold: numberInRange(value.qwenVadThreshold, -1, 1, DEFAULTS.qwenVadThreshold),
        qwenSilenceMs: numberInRange(value.qwenSilenceMs, 200, 6000, DEFAULTS.qwenSilenceMs),
        qwenMergeMs,
        voiceDraftAutoSend: value.voiceDraftAutoSend !== false,
        voiceDraftDwellMs: Math.max(qwenMergeMs, numberInRange(value.voiceDraftDwellMs, 500, 6000, DEFAULTS.voiceDraftDwellMs)),
        voiceDraftAllowWithoutVoiceprint: value.voiceDraftAllowWithoutVoiceprint !== false,
        voiceDraftSensitiveDeny: value.voiceDraftSensitiveDeny !== false,
        voiceprintEnabled: value.voiceprintEnabled === true,
        voiceprintThreshold: numberInRange(value.voiceprintThreshold, 0, 100, DEFAULTS.voiceprintThreshold),
        instructions: text(value.instructions, 12_000) || DEFAULTS.instructions,
    };
}
function numberInRange(value, min, max, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
function text(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : '';
}
