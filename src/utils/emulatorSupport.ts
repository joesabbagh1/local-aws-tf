import type { AwsServiceMetadata } from '../types/cloud';
import results from '../data/emulatorSupport.json';

export type SupportLevel = 'verified' | 'second-apply' | 'fails' | 'untested';

export interface ServiceSupport {
  level: SupportLevel;
  errors: string[];
  testedAt: string | null;
}

const byType = (results as { byType?: Record<string, { status: Exclude<SupportLevel, 'untested'>; errors: string[] }> }).byType || {};

/**
 * How a service's main resource fared on the emulator in the last `npm run test:emulator`:
 * applied and destroyed cleanly, needed a second Apply (a known emulator gap LocalCloud works
 * around), failed, or was not exercised by any test canvas.
 */
export function emulatorSupport(svc: Pick<AwsServiceMetadata, 'terraformResourceType'> | undefined): ServiceSupport {
  const entry = svc ? byType[svc.terraformResourceType] : undefined;
  return {
    level: entry ? entry.status : 'untested',
    errors: entry?.errors || [],
    testedAt: (results as { generatedAt?: string | null }).generatedAt || null,
  };
}
