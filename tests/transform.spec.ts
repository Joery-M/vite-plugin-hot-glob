import { join, posix } from 'path';
import { createServer, ViteDevServer } from 'vite';
import { afterAll, beforeAll, expect, test } from 'vitest';
import HotGlob from '..';

let server: ViteDevServer;

beforeAll(async () => {
    server = await createServer({
        root: join(import.meta.dirname, './files/'),
        optimizeDeps: {
            include: ['./files/*.ts']
        },
        plugins: [HotGlob()]
    });

    await server.listen(7000);
});

test('3 files matched', async () => {
    const result = (await server.transformRequest('test1.ts'))?.code?.replaceAll(
        posix.resolve('.'),
        ''
    );
    expect(result).toBeDefined();
    expect(result).length.above(1);

    expect(Array.from(result!.matchAll(/\/globbable\//g))).toHaveLength(3);

    await expect(result).toMatchFileSnapshot('__snapshots__/test1');
});

test('4 files matched', async () => {
    const result = (await server.transformRequest('test2.ts'))?.code?.replaceAll(
        posix.resolve('.'),
        ''
    );
    expect(result).toBeDefined();
    expect(result).length.above(1);

    expect(Array.from(result!.matchAll(/\/globbable\//g))).toHaveLength(4);

    await expect(result).toMatchFileSnapshot('__snapshots__/test2');
});

afterAll(async () => {
    await server.close();
});
