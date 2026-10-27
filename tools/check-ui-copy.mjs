import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const EXCEPTIONS_FILE = 'tools/ui-copy-exceptions.json';
const MODE = { blocking: true };

const CATALOG_FILE = 'src/common/constants/error-catalog.ts';
const MODULES_DIR = 'src/modules';
const SPEC_FILE = /\.spec\.ts$/;
const SOURCE_FILE = /\.ts$/;
const EXCEPTION_CLASS = /Exception$/;
const MESSAGE_PROPERTY = 'message';

const WORD_START = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';
const SECOND_PERSON_ANYWHERE = [
  'tienes',
  'puedes',
  'debes',
  'quieres',
  'necesitas',
  'sabes',
  'estás',
  'eres',
  'tú',
  'te',
  'contigo',
  'pídele',
  'pídelo',
  'pídela',
  'inténtalo',
  'revísalo',
  'revísala',
  'escríbenos',
  'contáctanos',
  'asegúrate',
  'recuérdalo',
  'hazlo',
  'avísanos',
];
const IMPERATIVES_AT_SENTENCE_START = [
  'revisa',
  'vuelve',
  'intenta',
  'escribe',
  'elige',
  'verifica',
  'corrige',
  'sube',
  'pide',
  'selecciona',
  'ingresa',
  'agrega',
  'añade',
  'haz',
  'recuerda',
  'contacta',
  'introduce',
  'abre',
  'cierra',
  'cambia',
  'usa',
  'guarda',
  'indica',
  'adjunta',
  'asigna',
  'crea',
  'edita',
  'elimina',
  'borra',
  'actualiza',
  'recarga',
  'busca',
  'confirma',
];

const capitalize = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const RULES = [
  { name: 'guillemets', pattern: /[«»]/u },
  { name: 'dash in prose', pattern: /\p{L}[.,)]?\s+[—–]\s+[¿¡(]?\p{L}/u },
  { name: 'semicolon in a sentence', pattern: /\p{L}[)"']?;\s+\p{L}/u },
  { name: 'p. ej.', pattern: /(?<!\p{L})p\.\s?ej\./iu },
  {
    name: 'tú form',
    pattern: new RegExp(`${WORD_START}(${SECOND_PERSON_ANYWHERE.join('|')}|tus?(?=\\s+\\p{L}))${WORD_END}`, 'iu'),
  },
  {
    name: 'tú imperative',
    pattern: new RegExp(
      `(^|[.!?:¡¿]\\s*)(${IMPERATIVES_AT_SENTENCE_START.map(capitalize).join('|')})${WORD_END}`,
      'u',
    ),
  },
];

const walkFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });

const normalize = (text) => text.replace(/\s+/g, ' ').trim();

const literalText = (node) => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => `X${span.literal.text}`)].join('');
  }
  return undefined;
};

const isCopyRoot = (node, source, wholeFile) => {
  if (wholeFile) return ts.isSourceFile(node);
  if (ts.isNewExpression(node) && EXCEPTION_CLASS.test(node.expression.getText(source))) return true;
  return (
    ts.isPropertyAssignment(node) &&
    !ts.isComputedPropertyName(node.name) &&
    node.name.getText(source).replace(/^['"]|['"]$/g, '') === MESSAGE_PROPERTY
  );
};

const snippetsOf = (file) => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wholeFile = file === CATALOG_FILE;
  const snippets = [];
  const collect = (node) => {
    if (ts.isImportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    const literal = literalText(node);
    if (literal !== undefined) {
      const normalized = normalize(literal);
      if (/\p{L}/u.test(normalized)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        snippets.push({ file, line: line + 1, text: normalized });
      }
      return;
    }
    node.forEachChild(collect);
  };
  const find = (node) => {
    if (isCopyRoot(node, source, wholeFile)) {
      node.forEachChild(collect);
      return;
    }
    node.forEachChild(find);
  };
  find(source);
  return snippets;
};

const loadExceptions = () => {
  const path = join(ROOT, EXCEPTIONS_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
};

const exceptions = loadExceptions();
const files = [
  CATALOG_FILE,
  ...walkFiles(join(ROOT, MODULES_DIR))
    .map((path) => relative(ROOT, path).split(sep).join('/'))
    .filter((file) => SOURCE_FILE.test(file) && !SPEC_FILE.test(file))
    .sort(),
];

const infractions = files
  .flatMap(snippetsOf)
  .flatMap((snippet) =>
    RULES.filter((rule) => rule.pattern.test(snippet.text)).map((rule) => ({ ...snippet, rule: rule.name })),
  )
  .filter(
    (infraction) =>
      !exceptions.some((exception) => exception.file === infraction.file && exception.text === infraction.text),
  );

for (const { file, line, rule, text } of infractions) {
  console.log(`${file}:${line} [${rule}] ${text.length > 140 ? `${text.slice(0, 140)}...` : text}`);
}

const scanned = `${files.length} files scanned, ${exceptions.length} exceptions`;
if (infractions.length === 0) {
  console.log(`UI copy ok: ${scanned}.`);
} else if (MODE.blocking) {
  console.error(`UI copy check failed: ${infractions.length} infractions (${scanned}).`);
  console.error('Fix the text following .claude/rules/ui-copy.md or add an entry to tools/ui-copy-exceptions.json.');
  process.exit(1);
} else {
  console.log(`UI copy report: ${infractions.length} infractions (${scanned}). Report mode, not blocking.`);
}
