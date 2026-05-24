/**
 * Chain-of-Responsibility validator pipeline.
 *
 * - Runs validators in order, **short-circuits** on the first reject by default.
 * - Configurable to collect-all-failures if we ever want a "show every reason
 *   the image was rejected" UX.
 *
 * The pipeline itself owns no domain knowledge — every rule lives in its own
 * validator. Adding a rule = one new class + one entry in the factory.
 */
import type { IValidator, ValidationContext, ValidatorResult } from '../validators/validator.interface';
import type { RejectionReason } from '../../shared/rejection-codes';
import { logger } from '../../shared/logger';

export interface PipelineOptions {
  /**
   * If true, run *every* validator even after a rejection and report all
   * failed reasons. Default `false` (fail fast = cheaper).
   */
  collectAll?: boolean;
}

export interface PipelineResult {
  passed: boolean;
  reasons: RejectionReason[];
}

export class ValidationPipeline {
  constructor(
    private readonly validators: IValidator[],
    private readonly options: PipelineOptions = {},
  ) {}

  async run(ctx: ValidationContext): Promise<PipelineResult> {
    const reasons: RejectionReason[] = [];

    for (const v of this.validators) {
      const start = Date.now();
      let result: ValidatorResult;
      try {
        result = await v.validate(ctx);
      } catch (err) {
        // A validator threw — treat as a hard failure of *that* rule rather
        // than blowing up the whole job. The worker layer decides whether
        // to retry on infra errors.
        logger.error({ err, validator: v.name, imageId: ctx.imageId }, 'validator.threw');
        throw err;
      }
      const ms = Date.now() - start;
      logger.debug(
        { validator: v.name, passed: result.passed, ms, imageId: ctx.imageId },
        'validator.done',
      );

      if (!result.passed && result.reason) {
        reasons.push(result.reason);
        if (!this.options.collectAll) break;
      }
    }

    return { passed: reasons.length === 0, reasons };
  }
}
