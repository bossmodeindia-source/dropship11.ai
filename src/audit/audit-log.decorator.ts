/**
 * AuditLog — Method decorator for automatic audit trail recording.
 *
 * Usage:
 *   @AuditLog('admin.update_user')
 *   async updateUser(...) { ... }
 *
 * The decorator stores metadata that AuditInterceptor (or any future
 * interceptor/aspect) can read via Reflector to automatically log
 * the operation, user, timestamp, and request payload to the audit_logs table.
 *
 * The decorator itself does NOT write to the database — it is a pure
 * metadata marker. Writing is done by AuditService.log() called explicitly
 * inside protected handlers, or via a global AuditInterceptor.
 */

import { SetMetadata } from '@nestjs/common';

export const AUDIT_LOG_KEY = 'audit_log_action';

/**
 * @AuditLog(action)
 *
 * Tags a controller method with an audit action identifier string.
 * Action strings follow the pattern: '<domain>.<operation>'
 * e.g. 'admin.update_user', 'admin.approve_withdrawal'
 */
export const AuditLog = (action: string) => SetMetadata(AUDIT_LOG_KEY, action);
