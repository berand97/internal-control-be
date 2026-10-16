import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const SCANNED_DIRS = ['src', 'test', 'scripts'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '__snapshots__']);
const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const DIRECTIVES = [
  /^\/\/\/\s*<(reference|amd)\b/,
  /\b(eslint|oxlint)-(disable|enable)/,
  /\bprettier-ignore\b/,
  /\bbiome-ignore\b/,
  /\b(istanbul|c8|v8) ignore\b/,
  /@ts-(expect-error|ignore|nocheck|check)\b/,
  /@vitest-environment\b/,
  /\bwebpack(ChunkName|Ignore|Mode|Prefetch|Preload)\b/,
  /[@#]__(PURE|NO_SIDE_EFFECTS)__/,
];

const listSources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIPPED_DIRS.has(name) ? [] : listSources(path);
    return SOURCE_FILE.test(name) ? [path] : [];
  });

const rootConfigs = (): string[] =>
  readdirSync(ROOT)
    .filter((name) => SOURCE_FILE.test(name))
    .map((name) => join(ROOT, name))
    .filter((path) => statSync(path).isFile());

const scriptKind = (path: string): ts.ScriptKind => (/\.(js|mjs|cjs)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS);

const commentsIn = (path: string): string[] => {
  const text = readFileSync(path, 'utf8');
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const found = new Map<number, string>();
  const collect = (pos: number): void => {
    const ranges = [...(ts.getLeadingCommentRanges(text, pos) ?? []), ...(ts.getTrailingCommentRanges(text, pos) ?? [])];
    for (const range of ranges) found.set(range.pos, text.slice(range.pos, range.end));
  };
  const visit = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    collect(node.pos);
    collect(node.end);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found.entries()]
    .filter(([, comment]) => !DIRECTIVES.some((directive) => directive.test(comment)))
    .map(([pos, comment]) => {
      const { line } = source.getLineAndCharacterOfPosition(pos);
      return `${relative(ROOT, path).replaceAll('\\', '/')}:${line + 1} ${comment.split(/\r?\n/)[0]}`;
    });
};

describe('código sin comentarios', () => {
  it('no hay comentarios fuera de las directivas de herramientas', () => {
    const files = [...SCANNED_DIRS.flatMap((dir) => listSources(join(ROOT, dir))), ...rootConfigs()];
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(commentsIn)).toEqual([]);
  });
});
