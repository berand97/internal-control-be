// Convierte el formato institucional OCI-01-55 (Word con campos MERGEFIELD y un
// caso real diligenciado) en una plantilla del motor de documentos, sin datos
// personales. Uso: node scripts/formats/build-oci-01-55-template.mjs <origen.docx> <destino.docx>
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');

const [source, target] = process.argv.slice(2);
if (!source || !target) {
  throw new Error('Uso: build-oci-01-55-template.mjs <origen.docx> <destino.docx>');
}

const FIELDS = {
  ACTA: '{{documento.numero}}',
  FECHA: '{{documento.fecha}}',
  RESPONSABLE: '{{responsable.nombre}}',
  DOCUMENTO: '{{responsable.documento}}',
  CARGO: '{{responsable.cargo}}',
  CENTRO_DE_COSTOS_: '{{centroCosto.codigo}} {{centroCosto.nombre}}',
  TACTIVOS: '{{totalElementos}}',
};

const ROW_TAGS = [
  '{{#activos}}{{indice}}',
  '{{idOrigen}}',
  '{{codigo}}',
  '{{descripcion}}',
  '{{unidades}}',
  '{{observacion}}',
  '{{estado}}{{/activos}}',
];

const FORBIDDEN = ['LEIZ', 'PADILLA', 'MONICA', '1006799678', '1.037.595.676', '0092', '16762', 'docs.google.com', 'MERGEFIELD'];

const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const replaceMergeFields = (xml) => {
  let result = xml;
  let begin = result.lastIndexOf('w:fldCharType="begin"');
  while (begin >= 0) {
    const runStart = Math.max(result.lastIndexOf('<w:r>', begin), result.lastIndexOf('<w:r ', begin));
    const endMark = result.indexOf('w:fldCharType="end"', begin);
    const runEnd = result.indexOf('</w:r>', endMark) + '</w:r>'.length;
    const segment = result.slice(runStart, runEnd);
    const name = segment.match(/MERGEFIELD\s+([A-Z_]+)/)?.[1];
    if (name) {
      const tag = FIELDS[name];
      if (!tag) {
        throw new Error(`Campo sin equivalencia: ${name}`);
      }
      const rPr = segment.match(/<w:rPr>.*?<\/w:rPr>/s)?.[0] ?? '';
      result = `${result.slice(0, runStart)}<w:r>${rPr}<w:t xml:space="preserve">${tag}</w:t></w:r>${result.slice(runEnd)}`;
    }
    begin = result.lastIndexOf('w:fldCharType="begin"', runStart - 1);
  }
  return result;
};

const topLevel = (xml, open, close) => {
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

const replaceAssetTable = (xml) => {
  const tables = topLevel(xml, 'w:tbl', 'w:tbl');
  const table = tables.find(([start, end]) => xml.slice(start, end).includes('CODIGO DEL ACTIVO'));
  if (!table) {
    throw new Error('No encontré la tabla de activos');
  }
  const tableXml = xml.slice(table[0], table[1]);
  const rows = topLevel(tableXml, 'w:tr', 'w:tr');
  const [header, template] = rows;
  let row = tableXml.slice(template[0], template[1]);
  const cells = topLevel(row, 'w:tc', 'w:tc');
  if (cells.length !== ROW_TAGS.length) {
    throw new Error(`La fila de activos tiene ${cells.length} celdas, esperaba ${ROW_TAGS.length}`);
  }
  for (let index = cells.length - 1; index >= 0; index -= 1) {
    const [start, end] = cells[index];
    row = row.slice(0, start) + setCellText(row.slice(start, end), ROW_TAGS[index]) + row.slice(end);
  }
  const rebuilt =
    tableXml.slice(0, header[1]) + row + tableXml.slice(rows.at(-1)[1]);
  return xml.slice(0, table[0]) + rebuilt + xml.slice(table[1]);
};

const replaceInParagraphs = (xml, predicate, transform) =>
  topLevel(xml, 'w:p', 'w:p')
    .reverse()
    .reduce((acc, [start, end]) => {
      const paragraph = acc.slice(start, end);
      return predicate(paragraph) ? acc.slice(0, start) + transform(paragraph) + acc.slice(end) : acc;
    }, xml);

const replaceText = (xml, from, to) => {
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

let document = replaceMergeFields((await readFile(source)) && new PizZip(await readFile(source)).file('word/document.xml').asText());
document = replaceAssetTable(document);
document = replaceInParagraphs(document, (p) => p.includes('Link de activos'), () => '');
document = replaceInParagraphs(
  document,
  (p) => p.includes('docs.google.com') || p.includes('nk de fotograf'),
  (p) =>
    p
      .replace(/<w:hyperlink\b.*?<\/w:hyperlink>/gs, '')
      .replace(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g, (match, open, text, close) =>
        /docs\.google\.com|nk de fotograf|Link de/.test(text) ? `${open}${close}` : match,
      ),
);
document = replaceText(document, 'MONICA ELIANA PEÑA', '{{auditor.nombre}}');
document = replaceText(document, '1.037.595.676', '{{auditor.documento}}');
document = replaceInParagraphs(
  document,
  (p) => {
    const text = p.replace(/<[^>]+>/g, '');
    return text.includes('{{responsable.cargo}}') && text.includes('Control Interno');
  },
  (p) => replaceText(p, 'Control Interno', '{{auditor.cargo}}'),
);

const zip = new PizZip(await readFile(source));
zip.file('word/document.xml', document);

let header = zip.file('word/header1.xml').asText();
header = replaceText(header, 'Código: OCI-01-55', 'Código: {{formato.codigo}}');
const runs = [...header.matchAll(/(<w:t(?: [^>]*)?>)([^<]*)(<\/w:t>)/g)];
const versionIndex = runs.findIndex((run) => run[2] === 'Versión:');
const dateIndex = runs.findIndex((run) => run[2] === 'Fecha: 202');
if (versionIndex < 0 || dateIndex < 0) {
  throw new Error('No encontré versión o fecha en el encabezado');
}
const edits = new Map([[versionIndex + 1, '{{formato.version}}'], [dateIndex, 'Fecha: {{formato.fechaVigencia}}']]);
for (let offset = 1; offset <= 5; offset += 1) {
  edits.set(dateIndex + offset, '');
}
let rebuilt = '';
let cursor = 0;
runs.forEach((run, index) => {
  if (edits.has(index)) {
    rebuilt += header.slice(cursor, run.index) + `${run[1]}${edits.get(index)}${run[3]}`;
    cursor = run.index + run[0].length;
  }
});
header = rebuilt + header.slice(cursor);
zip.file('word/header1.xml', header);

const settings = zip.file('word/settings.xml').asText().replace(/<w:mailMerge>.*?<\/w:mailMerge>/s, '');
zip.file('word/settings.xml', settings);

const plain = ['word/document.xml', 'word/header1.xml']
  .map((name) => zip.file(name).asText().replace(/<[^>]+>/g, ''))
  .join('\n');
const leaked = FORBIDDEN.filter((value) => plain.includes(value));
if (leaked.length > 0) {
  throw new Error(`La plantilla aún contiene datos del ejemplo: ${leaked.join(', ')}`);
}
await writeFile(target, zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Plantilla escrita en ${target}`);
console.log([...plain.matchAll(/\{\{[^}]+\}\}/g)].map((match) => match[0]).join(' '));
