import { Plugin } from 'vite';
import { ModuleNamespace } from 'vite/types/hot.d.ts';

export default function HotGlob(): Plugin;

export type HotGlobModules = Record<string, ModuleNamespace | undefined>;
