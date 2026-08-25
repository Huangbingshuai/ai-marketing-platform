export const EFFECT_EXTRACTION_QUEUE = 'effect.extraction.requested' as const;
export const EFFECT_EXTRACTION_JOB_TYPE = 'EFFECT_EXTRACTION' as const;
export const EFFECT_PROMPT_QUEUE = 'effect.prompt-generation.requested' as const;
export const EFFECT_PROMPT_JOB_TYPE = 'EFFECT_PROMPT_GENERATION' as const;

export const JOB_PUBLISHER = Symbol('JobPublisher');
export const JOB_PROGRESS_STORE = Symbol('JobProgressStore');

export const JOB_OUTBOX_BATCH_SIZE = 20;
export const JOB_OUTBOX_CLAIM_SECONDS = 30;
export const JOB_PROGRESS_TTL_SECONDS = 24 * 60 * 60;
