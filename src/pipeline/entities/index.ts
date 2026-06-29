/**
 * Pipeline Entities — V67 Enterprise Certified
 *
 * V67 CRITICAL FIX #2: TypeORM REMOVED — Drizzle ONLY
 *
 * TypeORM @Entity classes have been replaced by Drizzle table definitions
 * in src/common/database/schema.ts (single source of truth).
 *
 * This file re-exports from the canonical schema for backward compatibility
 * within the pipeline module. All new code imports from schema.ts directly.
 *
 * TypeORM status: REMOVED from package.json, all @Entity / @InjectRepository
 * decorators eliminated, TypeOrmModule.forFeature() removed from pipeline.module.ts.
 */

// Re-export Drizzle table definitions from canonical schema
export {
  creatives,
  creativePerformance,
  learningData,
  banditSessions,
  pipelineRuns,
} from '../../common/database/schema';

// Re-export type aliases for service code that uses these names
export type {
  Creative,
  CreativePerformance,
  LearningData,
  BanditSession,
  PipelineRun,
} from './pipeline-types';
