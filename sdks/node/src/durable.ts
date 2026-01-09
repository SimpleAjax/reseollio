/**
 * Durable function wrapper
 */

import type { JobOptions, DurableHandler } from './types';
import type { JobHandle } from './job';

export interface DurableOptions extends JobOptions { }

/**
 * A durable function that returns a JobHandle when called
 */
export interface DurableFunction<TArgs extends unknown[], TResult> {
    (...args: TArgs): Promise<JobHandle<TResult>>;
    /** The registered function name */
    functionName: string;
    /** The function options */
    options: DurableOptions;
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
