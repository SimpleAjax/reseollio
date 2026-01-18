/**
 * E2E Test 21: Schedule with Complex Arguments
 * 
 * Tests that schedules can correctly serialize and deserialize various argument types:
 * - Primitive types (numbers, booleans)
 * - Complex objects (nested)
 * - Arrays
 * - Null/Undefined (if supported, though JSON might convert undefined to null)
 */

import { Reseolio } from '../../src/client';

interface TestResult {
    name: string;
    passed: boolean;
    error?: string;
}

const results: TestResult[] = [];

function logTest(name: string, passed: boolean, error?: string) {
    results.push({ name, passed, error });
    if (passed) {
        console.log(`  ✅ ${name}`);
    } else {
        console.log(`  ❌ ${name}: ${error}`);
    }
}

function generateUniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function runTests() {
    console.log('🧪 E2E Test 21: Schedule with Complex Arguments\n');
    console.log('='.repeat(50));

    const reseolio = new Reseolio({
        storage: 'localhost:50051',
        autoStart: false,
    });

    try {
        await reseolio.start();
        console.log('✅ Connected to Reseolio\n');

        const runId = generateUniqueId();
        const schedulesToCleanup: any[] = [];

        // ========== TEST 1: Primitives (Number, Boolean) ==========
        console.log('Test 1: Primitives (Number, Boolean)');
        console.log('-'.repeat(40));

        const primitiveHandler = reseolio.durable(
            `e2e:args:prim-${runId}`,
            async (count: number, isValid: boolean) => { return { count, isValid }; }
        );

        const primSchedule = await primitiveHandler.schedule(
            { cron: '0 0 * * *' },
            42,
            true
        );
        schedulesToCleanup.push(primSchedule);

        const primDetails = await primSchedule.details();
        console.log(`    Args: ${JSON.stringify(primDetails.args)}`);

        logTest('Number and Boolean args preserved',
            Array.isArray(primDetails.args) &&
            primDetails.args[0] === 42 &&
            primDetails.args[1] === true
        );

        // ========== TEST 2: Complex Objects ==========
        console.log('\nTest 2: Complex Objects');
        console.log('-'.repeat(40));

        interface UserProfile {
            id: number;
            meta: {
                roles: string[];
                settings: { theme: string; notifications: boolean };
            };
        }

        const objectHandler = reseolio.durable(
            `e2e:args:obj-${runId}`,
            async (profile: UserProfile) => { return profile; }
        );

        const testObj: UserProfile = {
            id: 101,
            meta: {
                roles: ['admin', 'editor'],
                settings: { theme: 'dark', notifications: true }
            }
        };

        const objSchedule = await objectHandler.schedule(
            { cron: '0 0 * * *' },
            testObj
        );
        schedulesToCleanup.push(objSchedule);

        const objDetails = await objSchedule.details();
        const retrievedObj = objDetails.args[0] as UserProfile;

        console.log(`    Original keys: ${Object.keys(testObj.meta).join(', ')}`);
        console.log(`    Retrieved keys: ${Object.keys(retrievedObj.meta).join(', ')}`);

        logTest('Deep nested object structure preserved',
            retrievedObj.id === 101 &&
            retrievedObj.meta.roles.length === 2 &&
            retrievedObj.meta.settings.theme === 'dark'
        );

        // ========== TEST 3: Mixed Arrays ==========
        console.log('\nTest 3: Mixed Arrays');
        console.log('-'.repeat(40));

        const arrayHandler = reseolio.durable(
            `e2e:args:arr-${runId}`,
            async (items: any[]) => { return items; }
        );

        const testArray = [1, "string", { key: "value" }, [10, 20]];

        const arrSchedule = await arrayHandler.schedule(
            { cron: '0 0 * * *' },
            testArray
        );
        schedulesToCleanup.push(arrSchedule);

        const arrDetails = await arrSchedule.details();
        const retrievedArr = arrDetails.args[0] as any[];

        logTest('Mixed array content preserved',
            retrievedArr.length === 4 &&
            retrievedArr[0] === 1 &&
            retrievedArr[2].key === "value" &&
            Array.isArray(retrievedArr[3])
        );

        // ========== TEST 4: No Arguments ==========
        console.log('\nTest 4: No Arguments');
        console.log('-'.repeat(40));

        const noArgHandler = reseolio.durable(
            `e2e:args:none-${runId}`,
            async () => { return "done"; }
        );

        const noArgSchedule = await noArgHandler.schedule(
            { cron: '0 0 * * *' }
        );
        schedulesToCleanup.push(noArgSchedule);

        const noArgDetails = await noArgSchedule.details();
        console.log(`    Args: ${JSON.stringify(noArgDetails.args)}`);

        logTest('Empty args array returned for no-arg schedule',
            Array.isArray(noArgDetails.args) &&
            noArgDetails.args.length === 0
        );

        // ========== CLEANUP ==========
        console.log('\n🗑️  Cleaning up schedules...');

        for (const schedule of schedulesToCleanup) {
            await schedule.delete().catch(() => { });
        }
        console.log(`Deleted ${schedulesToCleanup.length} schedules`);

        // ========== SUMMARY ==========
        console.log('\n' + '='.repeat(50));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(50));

        const passed = results.filter(r => r.passed).length;
        const failed = results.filter(r => !r.passed).length;

        console.log(`  Total:  ${results.length}`);
        console.log(`  Passed: ${passed}`);
        console.log(`  Failed: ${failed}`);

        if (failed > 0) {
            console.log('\n❌ Failed tests:');
            results.filter(r => !r.passed).forEach(r => {
                console.log(`    - ${r.name}: ${r.error}`);
            });
        }

        await reseolio.stop();

        process.exit(failed === 0 ? 0 : 1);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        await reseolio.stop().catch(() => { });
        process.exit(1);
    }
}

runTests();
