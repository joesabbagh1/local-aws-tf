/**
 * Where the Terraform LocalCloud runs on the emulator differs from the AWS export, and why. Each
 * entry works around a gap in aws/aws-emulator that would otherwise make apply or destroy fail;
 * the export always keeps exactly what was designed.
 *
 * The notes are shown in the inspector (through the emulator test results, which record a type as
 * `adjusted`) and written as comments into the generated Terraform at each spot.
 */

export const EMULATOR_ADJUSTMENTS: Record<string, { issue?: number; note: string }> = {
  aws_instance: {
    issue: 422,
    note: "Burstable instance types (t2, t3, t4g) run as m6i.large or m7g.medium on the emulator, which can't read their CPU credit settings. It also ignores root volume settings, so the emulator run doesn't compare them. The AWS export keeps your instance type and volume.",
  },
  aws_kinesis_stream: {
    issue: 327,
    note: 'A 24-hour retention period runs as 25 hours on the emulator, which rejects 24. The AWS export keeps your value.',
  },
  aws_elasticache_replication_group: {
    issue: 355,
    note: "The emulator can't delete Redis replication groups, so destroy removes them from Terraform state instead (restarting the emulator clears them). It also picks the port itself, so the emulator run ignores port changes. The AWS export is unchanged.",
  },
  aws_elasticache_cluster: {
    issue: 471,
    note: 'The emulator serves the cache on a port of its own choosing, so the emulator run ignores port changes instead of replacing the cluster. The AWS export keeps the designed port.',
  },
};

const issueUrl = (issue: number) => `https://github.com/aws/aws-emulator/issues/${issue}`;

/** A Terraform comment explaining an adjustment, for the generated file. */
export function adjustmentComment(type: keyof typeof EMULATOR_ADJUSTMENTS | string, detail: string): string {
  const adjustment = EMULATOR_ADJUSTMENTS[type];
  return `# Emulator only: ${detail}${adjustment?.issue ? ` (${issueUrl(adjustment.issue)})` : ''}. The AWS export keeps the designed value.`;
}

/** T-family instances have CPU credits; the emulator can't describe them (apply and destroy both fail). */
export function isBurstableInstanceType(instanceType: string): boolean {
  return /^t\d[a-z]*\./.test(instanceType);
}

/** The non-burstable type with the same CPU architecture that a burstable type runs as on the emulator. */
export function emulatorInstanceType(instanceType: string): string {
  if (!isBurstableInstanceType(instanceType)) return instanceType;
  const suffix = instanceType.match(/^t\d([a-z]*)\./)?.[1] || '';
  return suffix.includes('g') ? 'm7g.medium' : 'm6i.large';
}

/** The emulator refuses to "increase" a stream's retention to the 24 hours it already has. */
export function emulatorKinesisRetention(hours: number): number {
  return hours <= 24 ? 25 : hours;
}
