import { Reseolio } from '../src/client';

const r = new Reseolio({ autoStart: false, address: 'localhost:50051' });

r.on('job:completion', (c: any) => console.log('COMPLETION EVENT:', c.jobId));

async function test() {
    await r.start();
    console.log('Started');

    const f = r.durable('debug:simple', async (x: number) => {
        console.log('Handler called with:', x);
        return x * 2;
    });

    console.log('Enqueueing...');
    const handle = await f(5);
    console.log('Enqueued:', handle.jobId);

    console.log('Waiting for result...');
    const result = await handle.result();
    console.log('RESULT:', result);

    await r.stop();
    console.log('SUCCESS!');
}

test().catch(e => { console.error('ERROR:', e); r.stop().then(() => process.exit(1)); });
