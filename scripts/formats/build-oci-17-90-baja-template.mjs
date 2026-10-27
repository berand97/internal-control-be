import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { clearAuthorMetadata, escape, generateClean, PizZip, replaceTextOrFail, templateTags } from './template-builder.mjs';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const SHEET = 'Solicitud baja de activos';

const BASE_TITLE = 'ACTA DE PRÉSTAMO TEMPORAL DE ACTIVOS FIJOS';

export const SAMPLE = {
  names: ['MONICA', 'MÓNICA', 'ELIANA', 'PEÑA', 'MOSQUERA', 'ANNY', 'JISETH', 'JOSEPH', 'TREJOS'],
  documents: [],
  numbers: ['00019', '18502', '18513', '4410', '4330', '5310', '030-2026', '38.267.493', '4169000'],
  text: [
    'Silla Gris 101',
    'MONITORES SALA 101',
    'GRANDSTREAM',
    'OPTIPLEX',
    'PELADORA DE PAPAS',
    'DEPARTAMENTO DE SISTEMAS',
    'Autorizado dar de baja',
    'La depreciación varió',
    'IBV - 00015',
    'Jefe Control Interno',
    'Jefe Contabilidad',
    '28 de julio de 2026',
  ],
};

export const COLUMNS = [
  { cell: 'B11', header: '#', tag: '{{indice}}', width: 500, align: 'center' },
  { cell: 'C11', header: 'Id', tag: '{{idOrigen}}', width: 900, align: 'center' },
  { cell: 'D11', header: 'Código de barras', tag: '{{codigo}}', width: 1100, align: 'center' },
  { cell: 'E11', header: 'Descripción del activo', tag: '{{descripcion}}', width: 2900 },
  { cell: 'F11', header: 'Cantidad', tag: '{{campos.cantidad}}', width: 800, align: 'center' },
  { cell: 'G11', header: 'Documento', tag: '{{campos.documento}}', width: 1200 },
  { cell: 'H11', header: 'Centro', tag: '{{campos.centro}}', width: 2000 },
  { cell: 'I11', header: 'Fecha Compra', tag: '{{campos.fechaCompra}}', width: 1100, align: 'center' },
  { cell: 'J11', header: 'Precio compra', tag: '{{campos.precioCompra}}', width: 1300, align: 'right' },
  { cell: 'K11', header: 'Estado', tag: '{{campos.estado}}', width: 900, align: 'center' },
  { cell: 'L11', header: 'Observaciones', tag: '{{campos.observaciones}}', width: 1700 },
];

const TOTAL_WIDTH = 14400;

const FONT = '<w:rFonts w:ascii="Metropolis" w:eastAsia="Metropolis" w:hAnsi="Metropolis" w:cs="Metropolis"/>';

const run = (text, { bold = false, size = 18 } = {}) =>
  `<w:r><w:rPr>${FONT}${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
  `<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;

const para = (runs, { align = 'left', after = 60, before = 0, keepNext = false } = {}) =>
  `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}` +
  `<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/>` +
  `<w:jc w:val="${align}"/></w:pPr>${runs.join('')}</w:p>`;

const cell = (width, paragraphs, { shade = false } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>` +
  `${shade ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${paragraphs.join('')}</w:tc>`;

const table = (widths, rows) =>
  `<w:tbl><w:tblPr><w:tblStyle w:val="Tablaconcuadrcula"/><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
  `<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
  `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;

const row = (cells, { header = false } = {}) =>
  `<w:tr><w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.join('')}</w:tr>`;

const loopRow = (columns, loop, size) =>
  row(
    columns.map((column, index) => {
      const tag =
        index === 0 ? `{{#${loop}}}${column.tag}` : index === columns.length - 1 ? `${column.tag}{{/${loop}}}` : column.tag;
      return cell(column.width, [para([run(tag, { size })], { align: column.align ?? 'left', after: 0 })]);
    }),
  );

const headerRow = (columns, size) =>
  row(
    columns.map((column) =>
      cell(column.width, [para([run(column.label ?? column.header, { bold: true, size })], { align: 'center', after: 0 })], { shade: true }),
    ),
    { header: true },
  );

const text = (value) => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object' && Array.isArray(value.richText)) {
    return value.richText.map((part) => part.text).join('');
  }
  if (typeof value === 'object' && 'result' in value) {
    return String(value.result ?? '');
  }
  return String(value);
};

export const readFormat = async (xlsx) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx);
  const sheet = book.getWorksheet(SHEET);
  if (!sheet) {
    throw new Error(`El Excel no tiene la hoja ${SHEET}`);
  }
  const expect = (address, value) => {
    const actual = text(sheet.getCell(address).value).trim().replace(/\s+/g, ' ');
    if (actual !== value) {
      throw new Error(`La celda ${address} dice ${actual}, esperaba ${value}. El formato cambió`);
    }
    return actual;
  };
  for (const column of COLUMNS) {
    expect(column.cell, column.header);
  }
  const note = text(sheet.getCell('B115').value).trim();
  if (!note.startsWith('Nota:')) {
    throw new Error('No encontré la nota en B115');
  }
  return {
    area: expect('G2', 'CONTROL INTERNO'),
    code: expect('J2', 'Código: OCI-17-90'),
    version: expect('J4', 'Versión: 1'),
    title: expect('G4', 'BAJA DE ACTIVOS'),
    numberTitle: expect('K8', 'BAJA DE ACTIVOS'),
    date: expect('B9', 'Fecha de la Baja Activos Fijos:'),
    reportTotal: expect('H115', 'Total Informe Baja:'),
    authorizedTotal: expect('H116', 'Total Autorizado Baja:'),
    difference: expect('H117', 'Diferencia'),
    review: expect('C117', 'REVISAN:'),
    control: expect('C119', 'CONTROL INTERNO'),
    accounting: expect('G119', 'CONTABILIDAD'),
    council: expect('C125', 'VOTO CONSEJO UNIVERSITARIO:'),
    reports: expect('C126', 'INFORMES DE VICEFINANCIERA'),
    note: 'Nota:',
  };
};

const body = (format) => {
  const label = (value, size = 18) => run(value, { bold: true, size });
  const value = (tag, size = 18) => run(tag, { size });
  const small = 14;
  const left = 3600;
  const pair = (title, runs) =>
    row([cell(left, [para([label(title)], { after: 0 })], { shade: true }), cell(TOTAL_WIDTH - left, [para(runs, { after: 0 })])]);

  const header = table(
    [left, TOTAL_WIDTH - left],
    [pair(`${format.numberTitle} No.`, [value('{{documento.numero}}')]), pair(format.date, [value('{{documento.fecha}}')])],
  );

  const assets = table(
    COLUMNS.map((column) => column.width),
    [headerRow(COLUMNS, small), loopRow(COLUMNS, 'activos', small)],
  );

  const totalLeft = TOTAL_WIDTH - 3200;
  const totalRow = (title, tag) =>
    row([
      cell(totalLeft, [para([label(title, 16)], { align: 'right', after: 0 })], { shade: true }),
      cell(3200, [para([value(tag, 16)], { align: 'right', after: 0 })]),
    ]);
  const totals = table(
    [totalLeft, 3200],
    [
      totalRow(format.reportTotal, '{{campos.totalInforme}}'),
      totalRow(format.authorizedTotal, '{{campos.totalAutorizado}}'),
      totalRow(format.difference, '{{campos.diferencia}}'),
    ],
  );

  const note = [
    para([run('{{#campos.nota}}', { size: small })], { after: 0 }),
    para([label(`${format.note} `, small), value('{{campos.nota}}', small)], { after: 60 }),
    para([run('{{/campos.nota}}', { size: small })], { after: 0 }),
  ];

  const substitutions = [
    para([run('{{#tablas.sustituciones}}', { size: small })], { after: 0 }),
    para(
      [
        label('Sustitución de firmante: ', small),
        value('firma por {{rol}} {{sustituto}} en lugar de {{sustituido}}, que firma el acta como {{conflicto}}. Motivo: {{motivo}}', small),
      ],
      { after: 60 },
    ),
    para([run('{{/tablas.sustituciones}}', { size: small })], { after: 0 }),
  ];

  const signerColumns = [
    { header: 'Firma por', tag: '{{etiqueta}}', width: 3000 },
    { header: 'Nombre', tag: '{{nombre}}', width: 4400 },
    { header: 'Cargo', tag: '{{cargo}}', width: 3600 },
    { header: 'Firma', tag: ' ', width: 3400 },
  ];
  const signatures = table(
    signerColumns.map((column) => column.width),
    [headerRow(signerColumns, 16), loopRow(signerColumns, 'firmantes', 16)],
  );

  const footer = table(
    [left, TOTAL_WIDTH - left],
    [
      pair(format.council, [value('{{campos.acuerdoConsejo}}'), run(' '), value('{{campos.fechaAcuerdo}}')]),
      pair(format.reports, [value('{{campos.informesVicefinanciera}}')]),
    ],
  );

  return [
    header,
    para([run(' ')], { after: 120 }),
    assets,
    para([run(' ')], { after: 60 }),
    totals,
    ...note,
    ...substitutions,
    para([label(format.review)], { before: 120, after: 60, keepNext: true }),
    signatures,
    para([run(' ')], { after: 120 }),
    footer,
  ].join('');
};

const landscapeHeader = (xml) => {
  const widths = { 3225: 3225, 4636: TOTAL_WIDTH - 3225 - 2779, 2779: 2779 };
  const result = xml
    .replace('<w:tblW w:w="10640" w:type="dxa"/>', `<w:tblW w:w="${TOTAL_WIDTH}" w:type="dxa"/>`)
    .replace('<w:tblInd w:w="-289" w:type="dxa"/>', '<w:tblInd w:w="0" w:type="dxa"/>')
    .replace(/<w:(gridCol|tcW) w:w="(3225|4636|2779)"/g, (_, tag, width) => `<w:${tag} w:w="${widths[width]}"`);
  if (!result.includes(`<w:tblW w:w="${TOTAL_WIDTH}"`)) {
    throw new Error('El encabezado de la base cambió. No encontré su tabla de 10 640 twips');
  }
  return result;
};

export const build = async (base, xlsx) => {
  const format = await readFormat(xlsx);
  const zip = new PizZip(base);
  const document = zip.file('word/document.xml').asText();
  const sectPr = document.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>/)?.[0];
  if (!sectPr) {
    throw new Error('La plantilla base no tiene sectPr');
  }
  const landscape = sectPr
    .replace(/<w:pgSz [^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
    .replace(/<w:pgMar [^>]*\/>/, '<w:pgMar w:top="1080" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>');
  const start = document.indexOf('<w:body>') + '<w:body>'.length;
  const end = document.indexOf('</w:body>');
  zip.file('word/document.xml', `${document.slice(0, start)}${body(format)}${landscape}${document.slice(end)}`);
  const header = zip.file('word/header1.xml').asText();
  zip.file('word/header1.xml', landscapeHeader(replaceTextOrFail(header, BASE_TITLE, format.title)));
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, xlsx, target] = process.argv.slice(2);
  if (!base || !xlsx || !target) {
    throw new Error('Uso: build-oci-17-90-baja-template.mjs <base.docx> <formato.xlsx> <destino.docx>');
  }
  const { output, tags } = await build(await readFile(base), await readFile(xlsx));
  await writeFile(target, output);
  console.log(`Plantilla escrita en ${target}`);
  console.log(tags.join(' '));
}
