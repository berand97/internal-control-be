import { clearAuthorMetadata, escape, generateClean, PizZip, replaceTextOrFail, runCli, templateTags } from './template-builder.mjs';
import { SAMPLE as BASE_SAMPLE } from './build-oci-01-65-template.mjs';

export const SAMPLE = BASE_SAMPLE;

export const TITLE = 'ACTA DE BAJA DE ACTIVOS FIJOS';

const BASE_TITLE = 'ACTA DE PRÉSTAMO TEMPORAL DE ACTIVOS FIJOS';

export const COLUMNS = [
  { header: '#', tag: '{{indice}}', width: 600, align: 'center' },
  { header: 'Código', tag: '{{codigo}}', width: 1500 },
  { header: 'Descripción', tag: '{{descripcion}}', width: 3700 },
  { header: 'Serial', tag: '{{campos.serial}}', width: 1700 },
  { header: 'Fecha de adquisición', tag: '{{campos.fechaAdquisicion}}', width: 1400, align: 'center' },
  { header: 'Costo', tag: '{{campos.costo}}', width: 1700, align: 'right' },
  { header: 'Valor en libros', tag: '{{campos.valorLibros}}', width: 2200, align: 'right' },
  { header: 'Condición', tag: '{{estado}}', width: 1600, align: 'center' },
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
      cell(column.width, [para([run(column.header, { bold: true, size })], { align: 'center', after: 0 })], { shade: true }),
    ),
    { header: true },
  );

const body = () => {
  const label = (text) => run(text, { bold: true });
  const value = (tag) => run(tag);
  const small = 14;
  const left = 3600;
  const pair = (title, runs) =>
    row([cell(left, [para([label(title)], { after: 0 })], { shade: true }), cell(TOTAL_WIDTH - left, [para(runs, { after: 0 })])]);

  const header = table(
    [left, TOTAL_WIDTH - left],
    [
      pair('Acta de baja No.', [value('{{documento.numero}}')]),
      pair('Fecha del acta', [value('{{documento.fecha}}')]),
      pair('Centro de costo', [value('{{centroCosto.codigo}}'), run(' '), value('{{centroCosto.nombre}}')]),
      pair('Dependencia', [value('{{centroCosto.unidad.nombre}}')]),
    ],
  );

  const data = table(
    [left, TOTAL_WIDTH - left],
    [
      pair('Motivo de la baja', [value('{{campos.motivo}}')]),
      pair('Concepto técnico o estado físico', [value('{{campos.conceptoTecnico}}')]),
      pair('Disposición final del bien', [value('{{campos.disposicionFinal}}')]),
      pair('Observaciones', [value('{{campos.observaciones}}')]),
    ],
  );

  const assets = table(
    COLUMNS.map((column) => column.width),
    [headerRow(COLUMNS, small), loopRow(COLUMNS, 'activos', small)],
  );

  const totals = para(
    [
      run('Total de activos: ', { bold: true, size: 16 }),
      run('{{totalElementos}}', { size: 16 }),
      run('   Costo total: ', { bold: true, size: 16 }),
      run('{{campos.totalCosto}}', { size: 16 }),
      run('   Valor en libros total: ', { bold: true, size: 16 }),
      run('{{campos.totalValorLibros}}', { size: 16 }),
    ],
    { before: 60, after: 40 },
  );

  const valuationNote = para(
    [
      run('Valor en libros con la depreciación registrada al ', { size: small }),
      run('{{campos.fechaValor}}', { size: small }),
      run('. Si un activo no tiene depreciación se muestra su costo.', { size: small }),
    ],
    { after: 120 },
  );

  const substitutions = [
    para([run('{{#tablas.sustituciones}}', { size: small })], { after: 0 }),
    para(
      [
        run('Sustitución de firmante: ', { bold: true, size: small }),
        run('firma por {{rol}} {{sustituto}} en lugar de {{sustituido}}, que firma el acta como {{conflicto}}. Motivo: {{motivo}}', {
          size: small,
        }),
      ],
      { after: 60 },
    ),
    para([run('{{/tablas.sustituciones}}', { size: small })], { after: 0 }),
  ];

  const signerColumns = [
    { header: 'Firma como', tag: '{{etiqueta}}', width: 3000 },
    { header: 'Nombre', tag: '{{nombre}}', width: 4000 },
    { header: 'Documento', tag: '{{tipoDocumento}} {{documento}}', width: 2400 },
    { header: 'Cargo', tag: '{{cargo}}', width: 2600 },
    { header: 'Firma', tag: ' ', width: 2400 },
  ];
  const signatures = table(
    signerColumns.map((column) => column.width),
    [headerRow(signerColumns, 16), loopRow(signerColumns, 'firmantes', 16)],
  );

  return [
    header,
    para([label('Datos de la baja')], { before: 120, after: 40, keepNext: true }),
    data,
    para([label('Activos dados de baja')], { before: 120, after: 40, keepNext: true }),
    assets,
    totals,
    valuationNote,
    ...substitutions,
    para([label('Firmas')], { before: 120, after: 40, keepNext: true }),
    signatures,
  ].join('');
};

const landscapeHeader = (xml) => {
  const widths = { 3225: 3225, 4636: TOTAL_WIDTH - 3225 - 2779, 2779: 2779 };
  const result = xml
    .replace('<w:tblW w:w="10640" w:type="dxa"/>', `<w:tblW w:w="${TOTAL_WIDTH}" w:type="dxa"/>`)
    .replace('<w:tblInd w:w="-289" w:type="dxa"/>', '<w:tblInd w:w="0" w:type="dxa"/>')
    .replace(/<w:(gridCol|tcW) w:w="(3225|4636|2779)"/g, (_, tag, width) => `<w:${tag} w:w="${widths[width]}"`);
  if (!result.includes(`<w:tblW w:w="${TOTAL_WIDTH}"`)) {
    throw new Error('El encabezado de la base cambió: no encontré su tabla de 10 640 twips');
  }
  return result;
};

export const build = (base) => {
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
  zip.file('word/document.xml', `${document.slice(0, start)}${body()}${landscape}${document.slice(end)}`);
  const header = zip.file('word/header1.xml').asText();
  zip.file('word/header1.xml', landscapeHeader(replaceTextOrFail(header, BASE_TITLE, TITLE)));
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

await runCli(import.meta.url, 'build-oci-17-90-baja-template.mjs', build);
