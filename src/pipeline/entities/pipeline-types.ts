/**
 * pipeline-types.ts — V67 Drizzle type aliases
 *
 * Provides TypeScript type aliases matching the old TypeORM entity class names.
 * Services that previously used `Creative`, `CreativePerformance`, etc.
 * as TypeORM entity types now use these inferred Drizzle types.
 */

import {
  creatives,
  creativePerformance,
  learningData,
  banditSessions,
  pipelineRuns,
} from '../../common/database/schema';

export type Creative            = typeof creatives.$inferSelect;
export type NewCreative         = typeof creatives.$inferInsert;

export type CreativePerformance = typeof creativePerformance.$inferSelect;
export type NewCreativePerformance = typeof creativePerformance.$inferInsert;

export type LearningData        = typeof learningData.$inferSelect;
export type NewLearningData     = typeof learningData.$inferInsert;

export type BanditSession       = typeof banditSessions.$inferSelect;
export type NewBanditSession    = typeof banditSessions.$inferInsert;

export type PipelineRun         = typeof pipelineRuns.$inferSelect;
export type NewPipelineRun      = typeof pipelineRuns.$inferInsert;

// Status enums (previously TypeORM enum columns)
export enum CreativeStatus {
  TESTING  = 'testing',
  ACTIVE   = 'active',
  KILLED   = 'killed',
  PAUSED   = 'paused',
  WINNER   = 'winner',
}

export enum CreativeType {
  VIDEO = 'video',
  IMAGE = 'image',
}
