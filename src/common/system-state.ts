/**
 * system-state.ts — Lightweight system readiness flag
 *
 * Breaks the circular dependency:
 *   AppModule → V43Module → V43SchedulerService → AppModule
 *
 * AppModule sets _ready = true in onModuleInit().
 * V43SchedulerService (and any other scheduler) polls isSystemReady()
 * without importing AppModule.
 *
 * This file has ZERO NestJS imports — it is plain TypeScript so it
 * cannot introduce a circular dependency through the DI container.
 */

let _ready = false;

/** Called by AppModule.onModuleInit() after all systems are up. */
export function markSystemReady(): void {
  _ready = true;
}

/** Returns true once AppModule has completed its onModuleInit hook. */
export function isSystemReady(): boolean {
  return _ready;
}
