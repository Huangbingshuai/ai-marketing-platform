DO $$
BEGIN
  CREATE TYPE "EffectPromptShardPhase" AS ENUM ('BLUEPRINT', 'PROMPT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "effect_prompt_shard_outputs"
ADD COLUMN IF NOT EXISTS "phase" "EffectPromptShardPhase" NOT NULL DEFAULT 'PROMPT';

DROP INDEX IF EXISTS "effect_prompt_shard_outputs_projectId_runId_round_shardIndex_key";
DROP INDEX IF EXISTS "effect_prompt_shard_outputs_projectId_runId_round_shardIndex_idx";
-- PostgreSQL truncates identifiers to 63 bytes. The original generated names for
-- the unique and lookup indexes collided after truncation, so keep them short.
DROP INDEX IF EXISTS "effect_prompt_shard_outputs_projectId_runId_phase_round_shardIn";

CREATE UNIQUE INDEX IF NOT EXISTS "effect_prompt_shard_phase_round_key"
ON "effect_prompt_shard_outputs"("projectId", "runId", "phase", "round", "shardIndex");

CREATE INDEX IF NOT EXISTS "effect_prompt_shard_phase_round_idx"
ON "effect_prompt_shard_outputs"("projectId", "runId", "phase", "round", "shardIndex");
