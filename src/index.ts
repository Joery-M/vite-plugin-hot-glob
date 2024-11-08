import type { Expression, Literal, SpreadElement } from 'estree';
import MagicString from 'magic-string';
import { isAbsolute, posix } from 'node:path';
import picomatch from 'picomatch';
import type { CustomPluginOptions } from 'rollup';
import { stripLiteral } from 'strip-literal';
import { escapePath, glob } from 'tinyglobby';
import {
    normalizePath,
    parseAstAsync,
    type Plugin,
    type ResolvedConfig,
    type TransformResult
} from 'vite';

interface ParsedImportGlob {
    globsResolved: string[];
    isRelative: boolean;
    globStart: number;
    globEnd: number;
    callback?: {
        start: number;
        end: number;
        spreadStart?: number;
    };
}

export default function hotGlobPlugin(): Plugin {
    let config: ResolvedConfig;

    return {
        name: 'vite-plugin-hot-glob',
        configResolved(resolvedConfig) {
            config = resolvedConfig;
        },
        async transform(code, id) {
            if (id.includes('node_modules')) return;
            if (!code.includes('import.meta.hot')) return;

            const result = await transformGlobAccept(code, id, config.root, (im, _, options) =>
                this.resolve(im, id, options).then((i) => i?.id ?? im)
            );

            if (result) {
                return transformStableResult(result, id, config);
            }
        }
    } as Plugin;
}

const importGlobRE = /\bimport\??\.meta\??\.hot\??\.accept\s*\(/g;

async function parseAcceptGlob(
    code: string,
    importer: string | undefined,
    root: string,
    resolveId: IdResolver
): Promise<ParsedImportGlob[]> {
    let cleanCode: string;
    try {
        cleanCode = stripLiteral(code);
    } catch {
        // skip invalid js code
        return [];
    }
    const matches = Array.from(cleanCode.matchAll(importGlobRE));

    const tasks = matches.map(async (match) => {
        const start = match.index;

        const err = (msg: string) => {
            const e = new Error(`Invalid glob import syntax: ${msg}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
            (e as any).pos = start;
            return e;
        };

        const end =
            findCorrespondingCloseParenthesisPosition(cleanCode, start + match[0].length) + 1;
        if (end <= 0) {
            throw err('Close parenthesis not found');
        }

        const statementCode = code.slice(start, end);

        const signal = AbortSignal.timeout(5000);
        const rootAst = (await parseAstAsync(statementCode, { signal })).body[0];

        if (rootAst.type !== 'ExpressionStatement') {
            throw err(`Expect CallExpression, got ${rootAst.type}`);
        }
        const ast =
            rootAst.expression.type == 'ChainExpression'
                ? rootAst.expression.expression
                : rootAst.expression;

        if (ast.type !== 'CallExpression') {
            throw err(`Expect CallExpression, got ${ast.type}`);
        }

        const arg1 = ast.arguments[0];
        const arg2 = ast.arguments[1];

        const globs: string[] = [];

        const validateLiteral = (element: Expression | Literal | SpreadElement | null) => {
            if (!element) return;
            if (element.type === 'Literal') {
                if (typeof element.value !== 'string')
                    throw err(`Expected glob to be a string, but got "${typeof element.value}"`);
                globs.push(element.value);
            } else if (element.type === 'TemplateLiteral') {
                if (element.expressions.length !== 0) {
                    throw err(`Expected glob to be a string, but got dynamic template literal`);
                }
                globs.push(element.quasis[0].value.raw);
            }
        };

        if (arg1?.type !== 'ObjectExpression') return;

        const globProp = arg1.properties.find(
            (p) => p.type == 'Property' && p.key.type == 'Identifier' && p.key.name == 'glob'
        );

        if (!globProp || globProp.type == 'SpreadElement' || globProp.key.type !== 'Identifier')
            return;

        const globArg = globProp.value;

        if (globArg.type === 'ArrayExpression') {
            for (const element of globArg.elements) {
                validateLiteral(element);
            }
        } else if (globArg.type == 'Literal') {
            validateLiteral(globArg);
        }

        if (!globs.length) return;

        let callback: ParsedImportGlob['callback'];
        if (arg2) {
            if (arg2.type == 'SpreadElement') {
                callback = {
                    start: arg2.argument.start + start,
                    end: arg2.argument.end + start,
                    spreadStart: arg2.start + start
                };
            } else {
                callback = {
                    start: arg2.start + start,
                    end: arg2.end + start
                };
            }
        }

        const globsResolved = await Promise.all(
            globs.map((glob) => toAbsoluteGlob(glob, root, importer, resolveId))
        );
        const isRelative = globs.every((i) => '.!'.includes(i[0]));

        return {
            globsResolved,
            isRelative,
            globStart: arg1.start + start,
            globEnd: arg1.end + start,
            callback
        } as ParsedImportGlob;
    });

    return (await Promise.all(tasks)).filter((v) => !!v);
}

/**
 * @param optimizeExport for dynamicImportVar plugin don't need to optimize export.
 */
async function transformGlobAccept(
    code: string,
    id: string,
    root: string,
    resolveId: IdResolver
): Promise<MagicString | null> {
    id = slash(id);
    root = slash(root);
    const isVirtual = isVirtualModule(id);
    const dir = isVirtual ? undefined : posix.dirname(id);
    const matches = await parseAcceptGlob(code, isVirtual ? undefined : id, root, resolveId);

    if (!matches.length) return null;

    const s = new MagicString(code);

    await Promise.all(
        matches.map(async ({ globsResolved, isRelative, globStart, globEnd, callback }) => {
            const cwd = getCommonBase(globsResolved) ?? root;
            const files = (
                await glob(globsResolved, {
                    absolute: true,
                    cwd,
                    expandDirectories: false,
                    ignore: ['**/node_modules/**']
                })
            )
                .filter((file) => file !== id)
                .sort();

            const resolvePaths = (file: string) => {
                if (!dir) {
                    if (isRelative)
                        throw new Error("In virtual modules, all globs must start with '/'");
                    const filePath = `/${posix.relative(root, file)}`;
                    return { filePath };
                }

                let importPath = posix.relative(dir, file);
                if (!importPath.startsWith('.')) importPath = `./${importPath}`;

                let filePath: string;
                if (isRelative) {
                    filePath = importPath;
                } else {
                    filePath = posix.relative(root, file);
                    if (!filePath.startsWith('.')) filePath = `/${filePath}`;
                }

                return { filePath };
            };

            const objectProps = files.map((file) => {
                const paths = resolvePaths(file);

                return `${JSON.stringify(paths.filePath)}`;
            });

            s.overwrite(globStart, globEnd, `[${objectProps.join(', ')}]`);

            // Transform the callback to structure the data differently
            /* 
                From:
                    [undefined, Module, undefined]
                To:
                    {
                        "./file1.js": undefined,
                        "./file2.js": Module,
                        "./file3.js": undefined,
                    }
             */
            if (callback) {
                const callbackString = s.slice(callback.start, callback.end);

                if (callback.spreadStart) {
                    // If its a spread argument, just take the first item
                    s.overwrite(
                        callback.spreadStart,
                        callback.end,
                        `function (m) {\n` + `const [cb] = ${callbackString};\n`
                    );
                } else {
                    s.overwrite(
                        callback.start,
                        callback.end,
                        `function (m) {\n` + `const cb = (${callbackString});\n`
                    );
                }

                let paramTransformer = 'const mn = {';
                for (let i = 0; i < objectProps.length; i++) {
                    paramTransformer += `${objectProps[i]}: m[${i}], `;
                }
                paramTransformer += '};\n';

                // Add transformed parameter
                s.appendRight(callback.end, paramTransformer);

                // Call new callback
                s.appendRight(callback.end, 'cb?.call(this, mn);\n');

                // Close function
                s.appendRight(callback.end, '}');
            }
        })
    );

    return s;
}

type IdResolver = (
    id: string,
    importer?: string,
    options?: {
        attributes?: Record<string, string>;
        custom?: CustomPluginOptions;
        isEntry?: boolean;
        skipSelf?: boolean;
    }
) => Promise<string | undefined> | string | undefined;

function globSafePath(path: string) {
    // slash path to ensure \ is converted to / as \ could lead to a double escape scenario
    return escapePath(normalizePath(path));
}

function lastNthChar(str: string, n: number) {
    return str.charAt(str.length - 1 - n);
}

function globSafeResolvedPath(resolved: string, glob: string) {
    // we have to escape special glob characters in the resolved path, but keep the user specified globby suffix
    // walk back both strings until a character difference is found
    // then slice up the resolved path at that pos and escape the first part
    let numEqual = 0;
    const maxEqual = Math.min(resolved.length, glob.length);
    while (numEqual < maxEqual && lastNthChar(resolved, numEqual) === lastNthChar(glob, numEqual)) {
        numEqual += 1;
    }
    const staticPartEnd = resolved.length - numEqual;
    const staticPart = resolved.slice(0, staticPartEnd);
    const dynamicPart = resolved.slice(staticPartEnd);
    return globSafePath(staticPart) + dynamicPart;
}

async function toAbsoluteGlob(
    glob: string,
    root: string,
    importer: string | undefined,
    resolveId: IdResolver
): Promise<string> {
    let pre = '';
    if (glob.startsWith('!')) {
        pre = '!';
        glob = glob.slice(1);
    }
    root = globSafePath(root);
    const dir = importer ? globSafePath(posix.dirname(importer)) : root;
    if (glob.startsWith('/')) return pre + posix.join(root, glob.slice(1));
    if (glob.startsWith('./')) return pre + posix.join(dir, glob.slice(2));
    if (glob.startsWith('../')) return pre + posix.join(dir, glob);
    if (glob.startsWith('**')) return pre + glob;

    const isSubImportsPattern = glob.startsWith('#') && glob.includes('*');

    const resolved = normalizePath(
        (await resolveId(glob, importer, {
            custom: { 'vite:import-glob': { isSubImportsPattern } }
        })) ?? glob
    );
    if (isAbsolute(resolved)) {
        return pre + globSafeResolvedPath(resolved, glob);
    }

    throw new Error(
        `Invalid glob: "${glob}" (resolved: "${resolved}"). It must start with '/' or './'`
    );
}

function getCommonBase(globsResolved: string[]): null | string {
    const bases = globsResolved
        .filter((g) => !g.startsWith('!'))
        .map((glob) => {
            let { base } = picomatch.scan(glob);
            // `scan('a/foo.js')` returns `base: 'a/foo.js'`
            if (posix.basename(base).includes('.')) base = posix.dirname(base);

            return base;
        });

    if (!bases.length) return null;

    let commonAncestor = '';
    const dirS = bases[0].split('/');
    for (let i = 0; i < dirS.length; i++) {
        const candidate = dirS.slice(0, i + 1).join('/');
        if (bases.every((base) => base.startsWith(candidate))) commonAncestor = candidate;
        else break;
    }
    if (!commonAncestor) commonAncestor = '/';

    return commonAncestor;
}

const windowsSlashRE = /\\/g;
function slash(p: string): string {
    return p.replace(windowsSlashRE, '/');
}
function isVirtualModule(id: string): boolean {
    // https://vite.dev/guide/api-plugin.html#virtual-modules-convention
    return id.startsWith('virtual:') || id.startsWith('\0') || !id.includes('/');
}

function findCorrespondingCloseParenthesisPosition(cleanCode: string, openPos: number) {
    const closePos = cleanCode.indexOf(')', openPos);
    if (closePos < 0) return -1;

    if (!cleanCode.slice(openPos, closePos).includes('(')) return closePos;

    let remainingParenthesisCount = 1;
    const cleanCodeLen = cleanCode.length;
    for (let pos = openPos; pos < cleanCodeLen; pos++) {
        switch (cleanCode[pos]) {
            case '(': {
                remainingParenthesisCount++;
                break;
            }
            case '{': {
                remainingParenthesisCount++;
                break;
            }
            case '}': {
                remainingParenthesisCount--;
                if (remainingParenthesisCount <= 0) {
                    return pos;
                }
                break;
            }
            case ')': {
                remainingParenthesisCount--;
                if (remainingParenthesisCount <= 0) {
                    return pos;
                }
            }
        }
    }
    return -1;
}

function transformStableResult(
    s: MagicString,
    id: string,
    config: ResolvedConfig
): TransformResult {
    return {
        code: s.toString(),
        map:
            config.command === 'build' && config.build.sourcemap
                ? s.generateMap({ hires: 'boundary', source: id })
                : null
    };
}
