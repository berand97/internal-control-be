import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const ROOT = resolve(import.meta.dirname, '..');
const EXCEPTIONS_FILE = 'tools/ui-copy-exceptions.json';
const ZONES = {
  user: { blocking: true, skippedRules: new Set() },
  swagger: { blocking: false, skippedRules: new Set(['tú imperative']) },
};

const SOURCE_DIR = 'src';
const MODULES_DIR = 'src/modules';
const WHOLE_FILE_SCOPE = /^src\/(common\/constants\/error-catalog\.ts$|modules\/staging\/)/;
const SWAGGER_DECORATOR = /^Api[A-Z]\w*$/;
const MACHINE_CALL = /(^|\.)(logger\.\w+|query|setHeader|header|createQueryBuilder|where|andWhere|select|addSelect)$/;
const SQL_TEXT = /^(SELECT|INSERT|UPDATE|DELETE|WITH)\b/;
const SWAGGER_PROPERTIES = new Set(['description', 'summary', 'example']);
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

const propertyName = (node, source) =>
  ts.isPropertyAssignment(node) && !ts.isComputedPropertyName(node.name)
    ? node.name.getText(source).replace(/^['"]|['"]$/g, '')
    : undefined;

const isSwaggerDecorator = (node, source) =>
  ts.isDecorator(node) &&
  ts.isCallExpression(node.expression) &&
  SWAGGER_DECORATOR.test(node.expression.expression.getText(source));

const isMachineCall = (node, source) =>
  ts.isCallExpression(node) && MACHINE_CALL.test(node.expression.getText(source));

const isCopyRoot = (node, source) =>
  (ts.isNewExpression(node) && EXCEPTION_CLASS.test(node.expression.getText(source))) ||
  propertyName(node, source) === MESSAGE_PROPERTY;

const snippetsOf = (file) => {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const wholeFile = WHOLE_FILE_SCOPE.test(file);
  const inModules = file.startsWith(`${MODULES_DIR}/`);
  const found = new Map();
  let zone = wholeFile ? 'user' : 'swagger';
  const collect = (node) => {
    if (ts.isImportDeclaration(node) || ts.isLiteralTypeNode(node)) return;
    const literal = literalText(node);
    if (literal !== undefined) {
      const normalized = normalize(literal);
      const start = node.getStart(source);
      if (/\p{L}/u.test(normalized) && !SQL_TEXT.test(normalized)) {
        const { line } = source.getLineAndCharacterOfPosition(start);
        found.set(start, { file, line: line + 1, text: normalized, zone });
      }
      return;
    }
    node.forEachChild(collect);
  };
  const findSwaggerTexts = (node) => {
    if (SWAGGER_PROPERTIES.has(propertyName(node, source))) {
      collect(node.initializer);
      return;
    }
    node.forEachChild(findSwaggerTexts);
  };
  const find = (node) => {
    if (isSwaggerDecorator(node, source)) {
      zone = 'swagger';
      findSwaggerTexts(node);
      return;
    }
    if (wholeFile && (ts.isDecorator(node) || isMachineCall(node, source))) {
      return;
    }
    if (wholeFile || (inModules && isCopyRoot(node, source))) {
      zone = 'user';
      if (literalText(node) !== undefined) {
        collect(node);
        return;
      }
      if (!wholeFile) {
        node.forEachChild(collect);
        return;
      }
    }
    node.forEachChild(find);
  };
  find(source);
  return [...found.values()];
};

const loadExceptions = () => {
  const path = join(ROOT, EXCEPTIONS_FILE);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
};

const exceptions = loadExceptions();
const files = walkFiles(join(ROOT, SOURCE_DIR))
  .map((path) => relative(ROOT, path).split(sep).join('/'))
  .filter((file) => SOURCE_FILE.test(file) && !SPEC_FILE.test(file))
  .sort();

const infractions = files
  .flatMap(snippetsOf)
  .flatMap((snippet) =>
    RULES.filter((rule) => !ZONES[snippet.zone].skippedRules.has(rule.name) && rule.pattern.test(snippet.text)).map(
      (rule) => ({ ...snippet, rule: rule.name }),
    ),
  )
  .filter(
    (infraction) =>
      !exceptions.some((exception) => exception.file === infraction.file && exception.text === infraction.text),
  );

for (const { file, line, rule, text, zone } of infractions) {
  console.log(`${file}:${line} [${zone}] [${rule}] ${text.length > 140 ? `${text.slice(0, 140)}...` : text}`);
}

console.log(`${files.length} files scanned, ${exceptions.length} exceptions.`);
let failed = false;
for (const [zone, { blocking }] of Object.entries(ZONES)) {
  const count = infractions.filter((infraction) => infraction.zone === zone).length;
  const mode = blocking ? 'blocking' : 'report only';
  console.log(`UI copy ${zone}: ${count} infractions (${mode}).`);
  failed ||= blocking && count > 0;
}
if (failed) {
  console.error('Fix the text following .claude/rules/ui-copy.md or add an entry to tools/ui-copy-exceptions.json.');
  process.exit(1);
}
