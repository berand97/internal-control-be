// Construye la plantilla del motor para el formato institucional OCI-17-89
// (Traslado de activos). El formato existe solo como Excel
// (docs/acta de traslado de activos fijos mdf.xlsx, hoja «Solicitud traslado
// de activos», con un caso real diligenciado) y el motor solo renderiza Word:
// el cuerpo se arma a partir del contenido del Excel (textos leídos de sus
// celdas) sobre el paquete de una plantilla Word ya limpia del repositorio
// (OCI-01-65-v2.docx: encabezado SGC con logo, estilos, fuentes y pie con
// número de página), en hoja horizontal por las 17 columnas de la tabla.
// Uso:
//   node scripts/formats/build-oci-17-89-template.mjs templates/formats/OCI-01-65-v2.docx "docs/acta de traslado de activos fijos mdf.xlsx" templates/formats/OCI-17-89-v1.docx
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { clearAuthorMetadata, escape, generateClean, PizZip, replaceTextOrFail, templateTags } from './template-builder.mjs';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const SHEET = 'Solicitud traslado de activos';

// Datos del caso diligenciado en el Excel. Si cualquiera sobrevive en la
// plantilla, el constructor y el test fallan. «Reubicacion» (Q14:Q26) no está:
// es el motivo sembrado en el catálogo y aparece legítimamente en actas reales.
export const SAMPLE = {
  names: ['SARA', 'ELISA', 'VILLAMIZAR', 'MERCADO', 'VELASQUEZ', 'BERRIO', 'MONICA', 'MÓNICA', 'ELIANA', 'PEÑA', 'MOSQUERA', 'ANNY', 'JISETH', 'JOSEPH', 'TREJOS'],
  documents: ['091430', '092688', '85315', '106659'],
  numbers: ['00143', '143', '31453', '27705', '31552', '27806', '4350', '4352', '213,000', '950,000'],
  text: [
    'TESORER',
    'DEPARTAMENTO DE COMPRAS',
    'GRANDSTREAM',
    'OPTIPLEX',
    'VENTILADOR',
    'Cambio de asociada',
    'Asistente de compras',
    '30 abril',
    'fotografía del activo',
    'CO-71002',
    'ESTACIÒN',
  ],
};

// Columnas de la tabla (fila 13 del Excel, B13:R13) y su marcador por activo.
// Anchos en twips para una hoja carta horizontal con márgenes de 0,5".
export const COLUMNS = [
  { cell: 'B13', header: '#', tag: '{{indice}}', width: 300 },
  { cell: 'C13', header: 'Id', tag: '{{idOrigen}}', width: 650 },
  { cell: 'D13', header: 'Código de barras', tag: '{{codigo}}', width: 800 },
  { cell: 'E13', header: 'Descripción del activo', tag: '{{descripcion}}', width: 1650 },
  { cell: 'F13', header: 'Cantidad', tag: '{{unidades}}', width: 550 },
  { cell: 'G13', header: 'Modelo', tag: '{{campos.modelo}}', width: 850 },
  { cell: 'H13', header: 'Nº de Documento', tag: '{{campos.numeroDocumento}}', width: 850 },
  { cell: 'I13', header: 'Nº de serie', tag: '{{campos.serie}}', width: 850 },
  { cell: 'J13', header: 'Centro', tag: '{{campos.centro}}', width: 1000 },
  { cell: 'K13', header: 'Fecha Compra', tag: '{{campos.fechaCompra}}', width: 800 },
  { cell: 'L13', header: 'Precio compra', tag: '{{campos.precioCompra}}', width: 950 },
  { cell: 'M13', header: 'Fisico', label: 'Físico', tag: '{{campos.fisico}}', width: 550 },
  { cell: 'N13', header: 'Estado', tag: '{{campos.estado}}', width: 700 },
  { cell: 'O13', header: 'Numeracion', label: 'Numeración', tag: '{{campos.numeracion}}', width: 750 },
  { cell: 'P13', header: 'Observaciones', tag: '{{campos.observaciones}}', width: 1100 },
  { cell: 'Q13', header: 'Razon', label: 'Razón', tag: '{{campos.motivo}}', width: 750 },
  { cell: 'R13', header: 'Traslado', tag: '{{campos.traslado}}', width: 1000 },
];

const FONT = '<w:rFonts w:ascii="Metropolis" w:eastAsia="Metropolis" w:hAnsi="Metropolis" w:cs="Metropolis"/>';

const run = (text, { bold = false, size = 18 } = {}) =>
  `<w:r><w:rPr>${FONT}${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
  `<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;

const para = (runs, { align = 'left', after = 60, keepNext = false } = {}) =>
  `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}<w:spacing w:before="0" w:after="${after}" w:line="240" w:lineRule="auto"/>` +
  `<w:jc w:val="${align}"/></w:pPr>${runs.join('')}</w:p>`;

const cell = (width, paragraphs, { shade = false, span = 1 } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}` +
  `${shade ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${paragraphs.join('')}</w:tc>`;

const table = (widths, rows, { borders = true } = {}) =>
  `<w:tbl><w:tblPr>${borders ? '<w:tblStyle w:val="Tablaconcuadrcula"/>' : ''}<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
  `${borders ? '' : '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>'}` +
  `<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
  `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;

const row = (cells, { header = false } = {}) =>
  `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.join('')}</w:tr>`;

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

// Lee del Excel los textos fijos del formato; falla si el formato cambió.
export const readFormat = async (xlsx) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx);
  const sheet = book.getWorksheet(SHEET);
  if (!sheet) {
    throw new Error(`El Excel no tiene la hoja «${SHEET}»`);
  }
  const at = (address) => text(sheet.getCell(address).value).trim();
  const expect = (address, value) => {
    const actual = at(address).replace(/\s+/g, ' ');
    if (actual !== value) {
      throw new Error(`La celda ${address} dice «${actual}», esperaba «${value}»: el formato cambió`);
    }
    return actual;
  };
  for (const column of COLUMNS) {
    expect(column.cell, column.header);
  }
  const clause = at('B44');
  if (!clause.startsWith('CLÁUSULA DE COMPROMISO')) {
    throw new Error('No encontré la cláusula de compromiso en B44');
  }
  return {
    area: expect('H2', 'CONTROL INTERNO'),
    code: expect('L2', 'Código: OCI-17-89'),
    version: expect('L4', 'Versión: 1'),
    title: expect('H6', 'TRASLADO DE ACTIVOS'),
    numberTitle: expect('O8', 'TRASLADO DE ACTIVOS'),
    date: expect('B9', 'Fecha traslado'),
    from: expect('B10', 'Centro que entrega:'),
    to: expect('B11', 'Centro que recibe:'),
    signature: expect('C35', 'Firma encargado (a)'),
    review: expect('C36', 'REVISAN:'),
    control: expect('C38', 'CONTROL INTERNO'),
    accounting: expect('H38', 'CONTABILIDAD'),
    clause,
  };
};

const body = (format) => {
  const widths = COLUMNS.map((column) => column.width);
  const total = widths.reduce((a, b) => a + b, 0);
  const half = Math.floor(total / 2);
  const label = (value) => run(value, { bold: true, size: 18 });
  const value = (tag) => run(tag, { size: 18 });
  const small = { size: 12 };
  const [clauseTitle, ...clauseRest] = format.clause.split(':');

  const header = table(
    [2200, total - 2200],
    [
      row([cell(2200, [para([label(`${format.numberTitle} No.`)], { after: 0 })], { shade: true }), cell(total - 2200, [para([value('{{documento.numero}}')], { after: 0 })])]),
      row([cell(2200, [para([label(format.date)], { after: 0 })], { shade: true }), cell(total - 2200, [para([value('{{documento.fecha}}')], { after: 0 })])]),
      row([cell(2200, [para([label(format.from)], { after: 0 })], { shade: true }), cell(total - 2200, [para([value('{{campos.centroOrigen}}')], { after: 0 })])]),
      row([cell(2200, [para([label(format.to)], { after: 0 })], { shade: true }), cell(total - 2200, [para([value('{{campos.centroDestino}}')], { after: 0 })])]),
    ],
  );

  const assets = table(widths, [
    row(
      COLUMNS.map((column) => cell(column.width, [para([run(column.label ?? column.header, { bold: true, ...small })], { align: 'center', after: 0 })], { shade: true })),
      { header: true },
    ),
    row(
      COLUMNS.map((column, index) => {
        const tag = index === 0 ? `{{#activos}}${column.tag}` : index === COLUMNS.length - 1 ? `${column.tag}{{/activos}}` : column.tag;
        return cell(column.width, [para([run(tag, small)], { align: index === 0 || index === 4 ? 'center' : 'left', after: 0 })]);
      }),
    ),
  ]);

  // Sustituciones de firmante por separación de funciones (no están en el Excel: las exige el motor).
  const substitutions = [
    para([run('{{#tablas.sustituciones}}', small)], { after: 0 }),
    para(
      [
        run('Sustitución de firmante (separación de funciones): ', { bold: true, size: 14 }),
        run('firma por {{rol}} {{sustituto}} en lugar de {{sustituido}}, que firma el acta como {{conflicto}}. Motivo: {{motivo}}', { size: 14 }),
      ],
      { after: 0 },
    ),
    para([run('{{/tablas.sustituciones}}', small)], { after: 0 }),
  ];

  const signatureBlock = (roleTitle, centerTag, nameTag, cargoLine) => [
    para([label(roleTitle)], { after: 0, keepNext: true }),
    ...(centerTag ? [para([value(centerTag)], { after: 400, keepNext: true })] : [para([run(' ')], { after: 400, keepNext: true })]),
    para([run('_______________________________________', { size: 18 })], { after: 0, keepNext: true }),
    para([value(nameTag)], { after: 0, keepNext: true }),
    para([run(cargoLine, { size: 18 })], { after: 120 }),
  ];
  const signatures = table(
    [half, total - half],
    [
      row([
        cell(half, signatureBlock(format.from, '{{campos.centroOrigen}}', '{{firmante.entrega.nombre}}', format.signature)),
        cell(total - half, signatureBlock(format.to, '{{campos.centroDestino}}', '{{firmante.recibe.nombre}}', format.signature)),
      ]),
      row([cell(total, [para([label(format.review)], { after: 120, keepNext: true })], { span: 2 })]),
      row([
        cell(half, signatureBlock(format.control, null, '{{firmante.control_interno.nombre}}', '{{firmante.control_interno.cargo}}')),
        cell(total - half, signatureBlock(format.accounting, null, '{{firmante.contabilidad.nombre}}', '{{firmante.contabilidad.cargo}}')),
      ]),
    ],
    { borders: false },
  );

  return [
    header,
    para([run(' ')], { after: 120 }),
    assets,
    para([run('Total elementos: ', { bold: true, size: 16 }), run('{{totalElementos}}', { size: 16 })], { after: 120 }),
    ...substitutions,
    para([run(' ')], { after: 120 }),
    signatures,
    para([run(`${clauseTitle}:`, { bold: true, size: 14 }), run(clauseRest.join(':'), { size: 14 })], { align: 'both', after: 0 }),
  ].join('');
};

export const build = async (base, xlsx) => {
  const format = await readFormat(xlsx);
  const zip = new PizZip(base);
  const document = zip.file('word/document.xml').asText();
  const sectPr = document.match(/<w:sectPr\b[\s\S]*<\/w:sectPr>/)?.[0];
  if (!sectPr) {
    throw new Error('La plantilla base no tiene sectPr');
  }
  // Hoja carta horizontal, márgenes de 0,5" (720 twips) para las 17 columnas.
  const landscape = sectPr
    .replace(/<w:pgSz [^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
    .replace(/<w:pgMar [^>]*\/>/, '<w:pgMar w:top="1080" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>');
  const start = document.indexOf('<w:body>') + '<w:body>'.length;
  const end = document.indexOf('</w:body>');
  zip.file('word/document.xml', `${document.slice(0, start)}${body(format)}${landscape}${document.slice(end)}`);

  // Encabezado SGC de la base: ya trae {{formato.codigo}}, {{formato.version}} y {{formato.fechaVigencia}};
  // cambia el título del formato por el del Excel (H6).
  const header = zip.file('word/header1.xml').asText();
  zip.file('word/header1.xml', replaceTextOrFail(header, 'ACTA DE PRÉSTAMO TEMPORAL DE ACTIVOS FIJOS', format.title));
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, xlsx, target] = process.argv.slice(2);
  if (!base || !xlsx || !target) {
    throw new Error('Uso: build-oci-17-89-template.mjs <base.docx> <formato.xlsx> <destino.docx>');
  }
  const { output, tags } = await build(await readFile(base), await readFile(xlsx));
  await writeFile(target, output);
  console.log(`Plantilla escrita en ${target}`);
  console.log(tags.join(' '));
}
