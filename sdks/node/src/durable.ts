/**
 * Durable function wrapper
 */

import type { JobOptions, DurableHandler, ScheduleOptions } from './types';
import type { JobHandle } from './job';
import type { ScheduleHandle } from './schedule';

/**
 * Options for durable function registration (no idempotencyKey)
 * 
 * Idempotency keys are per-execution, not per-registration.
 * Pass idempotencyKey when calling the durable function, not when defining it.
 */
export interface DurableOptions extends Omit<JobOptions, 'idempotencyKey'> { }

/**
 * A durable function that returns a JobHandle when called
 * 
 * The last parameter can optionally be JobOptions for per-execution configuration
 */
export interface DurableFunction<TArgs extends unknown[], TResult> {
    (...args: [...TArgs, JobOptions?]): Promise<JobHandle<TResult>>;
    /** The registered function name */
    functionName: string;
    /** The default function options (can be overridden per execution) */
    options: DurableOptions;
    /** Schedule this function */
    schedule(options: ScheduleOptions, ...args: TArgs): Promise<ScheduleHandle>;
    /** Schedule every minute */
    everyMinute(handlerOptions?: JobOptions, ...args: TArgs): Promise<ScheduleHandle>;
    /** Schedule hourly at minute 0 */
    hourly(handlerOptions?: JobOptions, ...args: TArgs): Promise<ScheduleHandle>;
    /** Schedule daily at specific hour (0-23) */
    daily(hour?: number, handlerOptions?: JobOptions, ...args: TArgs): Promise<ScheduleHandle>;
    /** Schedule weekly on specific day and hour */
    weekly(dayOfWeek?: number, hour?: number, handlerOptions?: JobOptions, ...args: TArgs): Promise<ScheduleHandle>;
}

/**
 * Standalone durable decorator (for use without Reseolio instance)
 * 
 * Note: This requires a global Reseolio instance to be set
 */
export function durable<TArgs extends unknown[], TResult>(
    name: string,
    options: DurableOptions = {}
) {
    return function (
        target: any,
        propertyKey: string,
        descriptor: PropertyDescriptor
    ) {
        const originalMethod = descriptor.value;

        descriptor.value = async function (...args: TArgs): Promise<JobHandle<TResult>> {
            // This would use a global instance - for now just call the method
            throw new Error(
                'Standalone @durable decorator requires a global Reseolio instance. ' +
                'Use reseolio.durable() instead.'
            );
        };

        // Preserve function metadata
        (descriptor.value as DurableFunction<TArgs, TResult>).functionName = name;
        (descriptor.value as DurableFunction<TArgs, TResult>).options = options;

        return descriptor;
    };
}

export { DurableOptions as DurableOptionsType };
