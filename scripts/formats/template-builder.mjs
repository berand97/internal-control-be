// Piezas compartidas para convertir un formato institucional de Word (con campos
// MERGEFIELD y un caso real diligenciado) en una plantilla del motor de
// documentos. Cada formato tiene su script (build-<formato>-template.mjs) con su
// mapa de campos y la muestra de datos del ejemplo que no puede sobrevivir.
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { assertTemplateClean, removeOrphanExternalRelationships } from './template-leftovers.mjs';

const require = createRequire(import.meta.url);
export const PizZip = require('pizzip');

export const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export const plainText = (xml) => xml.replace(/<[^>]+>/g, '');

// Recorre los campos complejos (fldChar begin … end) de atrás hacia adelante y
// reemplaza cada uno por un run con el texto que devuelva `resolve(instr, n)`,
// donde `n` es el número de aparición (0, 1, …) de esa misma instrucción en
// orden de documento. `undefined` deja el campo; '' lo elimina sin dejar run.
export const replaceFields = (xml, resolve) => {
  const instructionOf = (segment) =>
    [...segment.matchAll(/<w:instrText(?: [^>]*)?>([^<]*)<\/w:instrText>/g)]
      .map((match) => match[1])
      .join('')
      .trim();
  const seen = new Map();
  const segments = [];
  let result = xml;
  let begin = result.lastIndexOf('w:fldCharType="begin"');
  while (begin >= 0) {
    const runStart = Math.max(result.lastIndexOf('<w:r>', begin), result.lastIndexOf('<w:r ', begin));
    const endMark = result.indexOf('w:fldCharType="end"', begin);
    const runEnd = result.indexOf('</w:r>', endMark) + '</w:r>'.length;
    segments.push(instructionOf(result.slice(runStart, runEnd)));
    begin = result.lastIndexOf('w:fldCharType="begin"', runStart - 1);
  }
  const totals = new Map();
  for (const instr of segments) {
    totals.set(instr, (totals.get(instr) ?? 0) + 1);
  }
  begin = result.lastIndexOf('w:fldCharType="begin"');
  while (begin >= 0) {
    const runStart = Math.max(result.lastIndexOf('<w:r>', begin), result.lastIndexOf('<w:r ', begin));
    const endMark = result.indexOf('w:fldCharType="end"', begin);
    const runEnd = result.indexOf('</w:r>', endMark) + '</w:r>'.length;
    const segment = result.slice(runStart, runEnd);
    const instr = instructionOf(segment);
    const fromEnd = seen.get(instr) ?? 0;
    seen.set(instr, fromEnd + 1);
    const text = resolve(instr, totals.get(instr) - 1 - fromEnd);
    if (text !== undefined) {
      const rPr = segment.match(/<w:rPr>.*?<\/w:rPr>/s)?.[0] ?? '';
      const run = text === '' ? '' : `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
      result = `${result.slice(0, runStart)}${run}${result.slice(runEnd)}`;
    }
    begin = result.lastIndexOf('w:fldCharType="begin"', runStart - 1);
  }
  return result;
};

// `fields` asocia cada MERGEFIELD con su marcador. Si el mismo campo aparece
// varias veces con significados distintos, el valor es una lista en orden de
// documento. Un MERGEFIELD sin equivalencia es un error.
export const replaceMergeFields = (xml, fields) =>
  replaceFields(xml, (instr, occurrence) => {
    const name = instr.match(/^MERGEFIELD\s+([A-Z0-9_]+)/)?.[1];
    if (!name) {
      return undefined;
    }
    const tag = Array.isArray(fields[name]) ? fields[name][occurrence] : fields[name];
    if (!tag) {
      throw new Error(`Campo sin equivalencia: ${name} (aparición ${occurrence + 1})`);
    }
    return tag;
  });

export const topLevel = (xml, open, close) => {
  const items = [];
  let depth = 0;
  let start = -1;
  const pattern = new RegExp(`<${open}[ >]|</${close}>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) {
        items.push([start, match.index + match[0].length]);
      }
    } else {
      if (depth === 0) {
        start = match.index;
      }
      depth += 1;
    }
  }
  return items;
};

const setCellText = (cell, text) => {
  let first = true;
  const replaced = cell.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
    const value = first ? escape(text) : '';
    first = false;
    return `<w:t xml:space="preserve">${value}</w:t>`;
  });
  if (first) {
    throw new Error('Celda sin texto donde poner el marcador');
  }
  return replaced;
};

// Deja la tabla de activos con su encabezado y una sola fila con el loop; las
// demás filas del ejemplo se descartan.
export const replaceAssetTable = (xml, { headerText, rowTags }) => {
  const tables = topLevel(xml, 'w:tbl', 'w:tbl');
  const table = tables.find(([start, end]) => plainText(xml.slice(start, end)).includes(headerText));
  if (!table) {
    throw new Error('No encontré la tabla de activos');
  }
  const tableXml = xml.slice(table[0], table[1]);
  const rows = topLevel(tableXml, 'w:tr', 'w:tr');
  const [header, template] = rows;
  let row = tableXml.slice(template[0], template[1]);
  const cells = topLevel(row, 'w:tc', 'w:tc');
  if (cells.length !== rowTags.length) {
    throw new Error(`La fila de activos tiene ${cells.length} celdas, esperaba ${rowTags.length}`);
  }
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const [start, end] = cells[index];
    row = row.slice(0, start) + setCellText(row.slice(start, end), rowTags[index]) + row.slice(end);
  }
  const rebuilt = tableXml.slice(0, header[1]) + row + tableXml.slice(rows.at(-1)[1]);
  return xml.slice(0, table[0]) + rebuilt + xml.slice(table[1]);
};

export const replaceInParagraphs = (xml, predicate, transform) =>
  topLevel(xml, 'w:p', 'w:p')
    .reverse()
    .reduce((acc, [start, end]) => {
      const paragraph = acc.slice(start, end);
      return predicate(paragraph) ? acc.slice(0, start) + transform(paragraph) + acc.slice(end) : acc;
    }, xml);

// Reemplaza la primera aparición de `from` aunque Word la haya partido en varios
// runs: el reemplazo queda en el primer run tocado y los demás pierden ese texto.
export const replaceText = (xml, from, to) => {
  const runs = [...xml.matchAll(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g)];
  const texts = runs.map((run) => run[2]);
  const joined = texts.join('');
  const at = joined.indexOf(escape(from));
  if (at < 0) {
    return xml;
  }
  const until = at + escape(from).length;
  const next = [...texts];
  let offset = 0;
  let placed = false;
  texts.forEach((text, index) => {
    const start = offset;
    const end = offset + text.length;
    offset = end;
    if (end <= at || start >= until) {
      return;
    }
    const before = start < at ? text.slice(0, at - start) : '';
    const after = end > until ? text.slice(until - start) : '';
    next[index] = `${before}${placed ? '' : to}${after}`;
    placed = true;
  });
  let result = '';
  let cursor = 0;
  runs.forEach((run, index) => {
    result += xml.slice(cursor, run.index) + `${run[1]}${next[index]}${run[3]}`;
    cursor = run.index + run[0].length;
  });
  return result + xml.slice(cursor);
};

// Como replaceText, pero falla si el texto no está: un formato que cambió no
// debe producir una plantilla a medias sin avisar.
export const replaceTextOrFail = (xml, from, to) => {
  const result = replaceText(xml, from, to);
  if (result === xml) {
    throw new Error(`No encontré «${from}» para reemplazarlo por «${to}»`);
  }
  return result;
};

// Encabezado SGC: código, versión (el run que sigue a la etiqueta) y fecha de
// vigencia (etiqueta + fecha del ejemplo, aunque esté partida en runs).
export const replaceSgcHeader = (header, { code, versionLabel = 'Versión:', date }) => {
  let result = replaceTextOrFail(header, `Código: ${code}`, 'Código: {{formato.codigo}}');
  const runs = [...result.matchAll(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g)];
  const versionIndex = runs.findIndex((run) => run[2] === versionLabel);
  if (versionIndex < 0 || !runs[versionIndex + 1]) {
    throw new Error('No encontré la versión en el encabezado');
  }
  const value = runs[versionIndex + 1];
  result =
    result.slice(0, value.index) + `${value[1]}{{formato.version}}${value[3]}` + result.slice(value.index + value[0].length);
  const [label] = date.split(/(?<=:) /);
  return replaceTextOrFail(result, date, `${label} {{formato.fechaVigencia}}`);
};

// Quita la combinación de correspondencia (y con ella la ruta a la hoja de
// datos) y las relaciones externas que ya nadie referencia.
export const cleanPackage = (zip) => {
  const settings = zip.file('word/settings.xml').asText().replace(/<w:mailMerge>.*?<\/w:mailMerge>/s, '');
  zip.file('word/settings.xml', settings);
  for (const rels of Object.keys(zip.files).filter((name) => /^word\/_rels\/.+\.xml\.rels$/.test(name))) {
    const owner = zip.file(rels.replace('_rels/', '').replace(/\.rels$/, ''));
    zip.file(rels, removeOrphanExternalRelationships(zip.file(rels).asText(), owner ? owner.asText() : ''));
  }
};

// El formato imprime «C.C» fijo antes de cada número de documento. El tipo es
// un dato de la persona (tipoDocumento: abreviatura del catálogo, o vacío si se
// desconoce), así que cada «C.C <marcador del número>» pasa a
// «<marcador del tipo> <marcador del número>». `parties` son las rutas del
// firmante (responsable, auditor, firmante.recibe, …). Falla si alguna no está
// o si queda un «C.C» literal en el cuerpo.
export const replaceDocumentTypeLabels = (xml, parties) => {
  let result = xml;
  for (const party of parties) {
    result = replaceTextOrFail(result, `C.C {{${party}.documento}}`, `{{${party}.tipoDocumento}} {{${party}.documento}}`);
  }
  if (/C\.C\b/.test(plainText(result))) {
    throw new Error('Queda un «C.C» literal en la plantilla');
  }
  return result;
};

// Autor y último editor del .docx son datos de una persona del ejemplo.
export const clearAuthorMetadata = (zip) => {
  const core = zip.file('docProps/core.xml');
  if (core) {
    zip.file(
      'docProps/core.xml',
      core
        .asText()
        .replace(/<dc:creator>[^<]*<\/dc:creator>/, '<dc:creator></dc:creator>')
        .replace(/<cp:lastModifiedBy>[^<]*<\/cp:lastModifiedBy>/, '<cp:lastModifiedBy></cp:lastModifiedBy>'),
    );
  }
};

export const generateClean = (zip, sample, options) => {
  const output = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  assertTemplateClean(output, sample, options);
  return output;
};

export const templateTags = (zip, parts = ['word/document.xml', 'word/header1.xml']) =>
  [...parts.map((name) => plainText(zip.file(name).asText())).join('\n').matchAll(/\{\{[^}]+\}\}/g)].map(
    (match) => match[0],
  );

// Punto de entrada común: `node build-<formato>-template.mjs <origen.docx> <destino.docx>`.
export const runCli = async (moduleUrl, name, build) => {
  if (!process.argv[1] || moduleUrl !== pathToFileURL(process.argv[1]).href) {
    return;
  }
  const [source, target] = process.argv.slice(2);
  if (!source || !target) {
    throw new Error(`Uso: ${name} <origen.docx> <destino.docx>`);
  }
  const { output, tags } = build(await readFile(source));
  await writeFile(target, output);
  console.log(`Plantilla escrita en ${target}`);
  console.log(tags.join(' '));
};
