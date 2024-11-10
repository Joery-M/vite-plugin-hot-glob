import { defineConfig } from 'rolldown';
import copy from 'rollup-plugin-copy';

export default defineConfig([
    {
        input: 'src/index.ts',
        external: /.*/,
        output: {
            format: 'esm',
            entryFileNames: 'index.mjs',
            minify: true
        },
        plugins: [
            copy({
                targets: [
                    {
                        src: './types/{index,types}.d.ts',
                        dest: './dist/'
                    }
                ]
            })
        ]
    },
    {
        input: 'src/index.ts',
        external: /.*/,
        output: {
            format: 'cjs',
            entryFileNames: 'index.js',
            minify: true
        }
    }
]);
