export { GMI_LLM_BASE_URL, GMI_QUEUE_BASE_URL, GmiApiError, gmiFetchJson, requireGmiKey, unwrapGmiErrorMessage } from "./client";
export { buildMusicPayload, generateMusic, MUSIC_MODEL_ID } from "./music";
export type { MusicRequest, MusicResult } from "./music";
export {
  describeFailure,
  downloadToBuffer,
  downloadToFile,
  firstMediaUrl,
  getRequest,
  GmiContentFilterError,
  GmiRequestFailedError,
  isTerminalStatus,
  runQueued,
  submitRequest,
  tmpDir,
  tmpPath,
  waitForRequest,
} from "./queue";
export type { GmiOutcome, GmiRequestRecord, GmiRequestStatus } from "./queue";
export {
  buildSpeechPayload,
  cloneVoiceAndSpeak,
  SPEECH_EMOTIONS,
  SPEECH_MODEL_ID,
  synthesizeSpeech,
  synthesizeSpeechWav,
  VOICE_CLONE_MODEL_ID,
} from "./speech";
export type { SpeechEmotion, SpeechRequest, SpeechResult, VoiceCloneRequest } from "./speech";
export {
  assertH3Budget,
  BudgetExceededError,
  getH3SpendSummary,
  H3_COST_CENTS,
  H3_MODEL_ID,
  recordH3Request,
} from "./spend";
export { extractJsonValue, generateJson, generateText, MINIMAX_TEXT_MODEL, stripThinking } from "./text";
export type { ChatTurn, GenerateJsonOptions, GenerateTextOptions } from "./text";
export { fileTypeFromPath, uploadFileToGmi, uploadToGmi } from "./upload";
export type { GmiUploadFileType } from "./upload";
export {
  buildClipPrompt,
  buildH3Payload,
  clampDuration,
  defaultResolution,
  generateH3Clip,
  H3_MAX_DURATION,
  H3_MIN_DURATION,
  referencePortraitUrls,
  sanitizeVisualPrompt,
} from "./video";
export type { ClipPromptContext, ClipPromptInput, H3ClipRequest, H3ClipResult, H3Ratio, H3Resolution } from "./video";
export {
  DEFAULT_VOICE_ID,
  FALLBACK_VOICE_IDS,
  FEMININE_VOICE_IDS,
  isKnownVoiceId,
  LEGACY_VOICE_ALIASES,
  MASCULINE_VOICE_IDS,
  MINIMAX_VOICES,
  resolveVoiceId,
  voiceProfile,
} from "./voices";
export type { VoiceGender, VoiceProfile } from "./voices";
