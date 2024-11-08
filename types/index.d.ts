import type { Plugin } from 'vite';
import type { ModuleNamespace } from 'vite/types/hot.d.ts';

export default function hotGlobPlugin(): Plugin;

export type HotGlobModules = Record<string, ModuleNamespace | undefined>;
