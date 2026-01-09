/**
 * Basic tests for Reseolio SDK
 */

import { describe, it, expect, vi } from 'vitest';
import { Reseolio } from '../src/client';
import { JobHandle } from '../src/job';

describe('Reseolio', () => {
    it('should create instance with default config', () => {
        const reseolio = new Reseolio();
        expect(reseolio).toBeInstanceOf(Reseolio);
    });

    it('should create instance with custom config', () => {
        const reseolio = new Reseolio({
            storage: 'sqlite://./test.db',
            address: '127.0.0.1:50052',
            workerConcurrency: 5,
            autoStart: false,
        });
        expect(reseolio).toBeInstanceOf(Reseolio);
    });

    it('should register durable functions', () => {
        const reseolio = new Reseolio({ autoStart: false });

        const myFunc = reseolio.durable('my-function', async (x: number) => {
            return x * 2;
        }, {
            maxAttempts: 3,
            backoff: 'exponential',
        });

        expect(myFunc.functionName).toBe('my-function');
        expect(myFunc.options.maxAttempts).toBe(3);
        expect(myFunc.options.backoff).toBe('exponential');
    });
});

describe('JobHandle', () => {
    it('should store job id', () => {
        const mockClient = {} as Reseolio;
        const handle = new JobHandle('job-123', mockClient);
        expect(handle.jobId).toBe('job-123');
    });
});

describe('Types', () => {
    it('should export correct types', async () => {
        const { protoToStatus } = await import('../src/types');

        expect(protoToStatus(1)).toBe('pending');
        expect(protoToStatus(2)).toBe('running');
        expect(protoToStatus(3)).toBe('success');
        expect(protoToStatus(4)).toBe('failed');
        expect(protoToStatus(5)).toBe('dead');
        expect(protoToStatus(6)).toBe('cancelled');
        expect(protoToStatus(99)).toBe('pending');
    });
});
