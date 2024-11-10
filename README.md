<h1 align="center">vite-plugin-hot-glob</h1>
<p align="center">A simple vite plugin to accept HMR on glob patterns</p>

## Install

```bash
npm i -D vite-plugin-hot-glob

yarn add -D vite-plugin-hot-glob

pnpm i -D vite-plugin-hot-glob
```

## Usage

Add the plugin in your vite config:

```ts
import { defineConfig } from 'vite';
import HotGlob from 'vite-plugin-hot-glob';

export default defineConfig({
    plugins: [HotGlob()]
});
```

Enter a glob pattern as a single string or as an array of strings.

```ts
import.meta.hot.accept({ glob: './locales/*.json' }, (modules) => {
    console.log(modules);
    /* 
        {
            "./locales/en-US.json": undefined, // Undefined means no change
            "./locales/nl-NL.json": ModuleNamespace, // Means this one was changed
            "./locales/zh-CN.json": undefined,
        }
     */
});
```

```ts
import.meta.hot.accept({ glob: ['./components/**/*.tsx', './views/**/*.vue'] }, (modules) => {
    console.log(modules);
});
```

### Features:

-   Same glob features as [`import.meta.glob`](https://vite.dev/guide/features.html#glob-import)\*
-   Callbacks as variables
-   Passing `this` parameter

\*Most of the code is actually 'inspired' by the code of `import.meta.glob`

### Types

`tsconfig.json`:

```json
{
    // ...
    "compilerOptions": {
        // ...
        "types": ["vite-plugin-hot-glob/types"]
    }
    // ...
}
```

Global `.d.ts` file

```ts
import 'vite-plugin-hot-glob/types';

---

/// <reference path="vite-plugin-hot-glob/types" />
```

## How it works

The plugin transforms the call expression to list all the files matched by the glob patterns:

### Before plugin:

```ts
import.meta.hot.accept({ glob: './i18n/*.json' }, (mod) => {
    for (const [path, file] of Object.entries(mod)) {
        const localeFile = file?.default;
        if (!localeFile) continue;
        const locale = path.split('i18n/')[1].split('.json')[0];
        LocaleManager.registerLocale(locale, async () => localeFile);
    }
    LocaleManager.switchLocale(LocaleManager.activeLocale);
});
```

### After plugin:

```ts
import.meta.hot.accept(['./i18n/en-US.json', './i18n/nl-NL.json'], function (m) {
    const cb = (mod) => {
        for (const [path, file] of Object.entries(mod)) {
            const localeFile = file?.default;
            if (!localeFile) continue;
            const locale = path.split('i18n/')[1].split('.json')[0];
            LocaleManager.registerLocale(locale, async () => localeFile);
        }
        LocaleManager.switchLocale(LocaleManager.activeLocale);
    };

    const mn = { './i18n/en-US.json': m[0], './i18n/nl-NL.json': m[1] };
    cb?.call(this, mn);
});
```

The rest is handled by the vite, which means all other path-altering plugins and settings should still work.
