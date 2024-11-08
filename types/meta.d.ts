import 'vite/types/hot.d.ts';
import type { HotGlobModules } from '.';

declare module 'vite/types/hot.d.ts' {
    export interface ViteHotContext {
        accept(glob: { glob: string | readonly string[] }): void;
        accept(
            glob: { glob: string | readonly string[] },
            cb: (mods: HotGlobModules) => void
        ): void;
    }
}
export {};
