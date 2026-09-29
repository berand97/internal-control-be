// Construye la plantilla del motor para el formato institucional OCI-21-37 (Acta de toma física de inventario de
// activos fijos). El formato existe solo como Excel (docs/acta de toma física de inventario de activos fijos mdf.xlsx,
// diligenciado con una toma real: 1110 OFICINA JURÍDICA, informe 00005) y el motor solo renderiza Word: el cuerpo se
// arma con los textos leídos de sus celdas sobre el paquete de una plantilla Word ya limpia del repositorio
// (OCI-01-65-v2.docx: encabezado SGC con logo, estilos, fuentes y pie con número de página), en hoja horizontal.
//
// Hoja «Tabla de informacion »: el acta (encabezado, resumen de hallazgos, notas y firmas).
// Hoja «Total Activos .»: el detalle por activo, que aquí va como anexo. Sus columnas AU/ANE/AOD/ANI (una por
// categoría) no se copian: la categoría es una columna, y el resumen recorre las categorías que el catálogo tenga
// activas y definidas (tablas.hallazgos), sin fijar cuántas ni qué significan.
//
// Uso:
//   node scripts/formats/build-oci-21-37-template.mjs templates/formats/OCI-01-65-v2.docx "docs/acta de toma física de inventario de activos fijos mdf.xlsx" templates/formats/OCI-21-37-v2.docx
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

import { clearAuthorMetadata, escape, generateClean, PizZip, replaceTextOrFail, templateTags } from './template-builder.mjs';

const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');

const ACT_SHEET = 'Tabla de informacion ';
const ITEMS_SHEET = 'Total Activos .';

// Datos de la toma diligenciada en el Excel (y de las hojas ocultas). Si cualquiera sobrevive en la plantilla, el
// constructor y el test fallan. Los rótulos de las categorías (Activos en uso, …) no están: son del formato y el
// catálogo del sistema puede usarlos legítimamente.
export const SAMPLE = {
  names: ['FABIÁN', 'FABIAN', 'JAIMES', 'FLÓREZ', 'FLOREZ', 'MONICA', 'MÓNICA', 'ELIANA', 'PEÑA', 'MOSQUERA'],
  documents: [],
  numbers: [
    '00005',
    '1110',
    '9.384.580',
    '6.974.967',
    '2.409.613',
    '74,32',
    '25,68',
    '15763',
    '15885',
    '15888',
    '17567',
    '20619',
    '23878',
    '26604',
    '26605',
    '26716',
    '31486',
    '31522',
    '31644',
    '00883',
    '00035',
    '02003',
    '01361',
    '26334',
    '26268',
    '26401',
    '27741',
    '27789',
    '27898',
  ],
  text: [
    'OFICINA JURÍDICA',
    'OFICINA JURIDICA',
    'Oficina de Juridica',
    'SECRETARÍA GENERAL',
    'Secretario General',
    'No ubicado en oficinas',
    'Sillas Paño Gris',
    'Archivador 4 Gavetas',
    'GRANDSTREAM',
    'EXPERTBOOK',
    'VOSTRO',
    'WF-6590',
    'CO-71002',
    'IC-73083',
    'IC-091948',
    'IC-094250',
    '431ch',
    '2025-02-11',
    '2025-02-28',
    '11 de febrero de 2025',
    '28 de febrero de 2025',
    'Servicios Generales',
    'PREHOSPITALARIA',
    'MASCARA LARINGEA',
    'Asistente Control Interno',
    'sharepoint',
    'adventistacol',
    '192.168.4.60',
    'Base activos UNAC',
    'Epson (Central)',
  ],
};

// Encabezados del resumen de hallazgos (fila 17 de la hoja del acta).
const FINDINGS_HEADERS = [
  { cell: 'C17', header: 'Hallazgo' },
  { cell: 'D17', header: '# de bienes' },
  { cell: 'F17', header: 'Precio de compra' },
  { cell: 'H17', header: 'Porcentaje' },
  { cell: 'J17', header: 'Valor en libros' },
];

// Columnas del anexo por activo. `cell` es el encabezado en la hoja «Total Activos .» cuando el formato lo trae; las
// demás las introduce la plantilla porque el sistema las registra en la verificación (resultado, condición, causa…).
// Anchos en twips para una hoja carta horizontal con márgenes de 0,5" (14 400 útiles); Id y código caben en una línea
// con códigos internos de 12 caracteres (A2026-000123).
export const COLUMNS = [
  { cell: 'A1', header: '#', tag: '{{indice}}', width: 350, align: 'center' },
  { cell: 'B1', header: 'Id', tag: '{{idOrigen}}', width: 1150 },
  { cell: 'C1', header: 'Código de barras', tag: '{{codigo}}', width: 1150 },
  { cell: 'D1', header: 'Descripción del activo', tag: '{{descripcion}}', width: 2300 },
  { header: 'Resultado', tag: '{{campos.resultado}}', width: 1100 },
  { header: 'Condición observada', tag: '{{campos.condicionObservada}}', width: 1000 },
  { cell: 'L1', header: 'Categorizacion', label: 'Categoría', tag: '{{campos.categoriaCodigo}}', width: 1050, align: 'center' },
  { cell: 'I1', header: 'Precio compra', tag: '{{campos.valorCompra}}', width: 1300, align: 'right' },
  { cell: 'J1', header: 'Valor en libros', tag: '{{campos.valorLibros}}', width: 1300, align: 'right' },
  { header: 'Código temporal', tag: '{{campos.codigoTemporal}}', width: 950, align: 'center' },
  { header: 'Causa del faltante', tag: '{{campos.causa}}', width: 1400 },
  { cell: 'R1', header: 'Observaciones', tag: '{{observacion}}', width: 1350 },
];

const TOTAL_WIDTH = 14400;

const FONT = '<w:rFonts w:ascii="Metropolis" w:eastAsia="Metropolis" w:hAnsi="Metropolis" w:cs="Metropolis"/>';

const run = (text, { bold = false, size = 18 } = {}) =>
  `<w:r><w:rPr>${FONT}${bold ? '<w:b/><w:bCs/>' : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
  `<w:t xml:space="preserve">${escape(text)}</w:t></w:r>`;

const para = (runs, { align = 'left', after = 60, before = 0, keepNext = false, pageBreakBefore = false } = {}) =>
  `<w:p><w:pPr>${keepNext ? '<w:keepNext/>' : ''}${pageBreakBefore ? '<w:pageBreakBefore/>' : ''}` +
  `<w:spacing w:before="${before}" w:after="${after}" w:line="240" w:lineRule="auto"/>` +
  `<w:jc w:val="${align}"/></w:pPr>${runs.join('')}</w:p>`;

const cell = (width, paragraphs, { shade = false, span = 1 } = {}) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}` +
  `${shade ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${paragraphs.join('')}</w:tc>`;

const table = (widths, rows, { borders = true } = {}) =>
  `<w:tbl><w:tblPr>${borders ? '<w:tblStyle w:val="Tablaconcuadrcula"/>' : ''}<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
  `${borders ? '' : '<w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders>'}` +
  `<w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
  `<w:tblGrid>${widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows.join('')}</w:tbl>`;

const row = (cells, { header = false, cantSplit = true } = {}) =>
  `<w:tr><w:trPr>${cantSplit ? '<w:cantSplit/>' : ''}${header ? '<w:tblHeader/>' : ''}</w:trPr>${cells.join('')}</w:tr>`;

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
  const act = book.getWorksheet(ACT_SHEET);
  const items = book.getWorksheet(ITEMS_SHEET);
  if (!act || !items) {
    throw new Error(`El Excel no tiene las hojas «${ACT_SHEET}» y «${ITEMS_SHEET}»`);
  }
  const expectIn = (sheet) => (address, value) => {
    const actual = text(sheet.getCell(address).value).trim().replace(/\s+/g, ' ');
    if (actual !== value) {
      throw new Error(`La celda ${sheet.name}!${address} dice «${actual}», esperaba «${value}»: el formato cambió`);
    }
    return actual;
  };
  const expect = expectIn(act);
  const expectItem = expectIn(items);
  for (const header of FINDINGS_HEADERS) {
    expect(header.cell, header.header);
  }
  for (const column of COLUMNS.filter((item) => item.cell)) {
    expectItem(column.cell, column.header);
  }
  return {
    area: expect('F2', 'CONTROL INTERNO'),
    code: expect('I2', 'Código: OCI-21-37'),
    version: expect('I4', 'Versión: 2'),
    title: expect('F6', 'ACTA DE TOMA FISICA DE INVENTARIO DE ACTIVOS FIJOS'),
    report: expect('J8', 'Informe de Hallazgos'),
    center: expect('C10', 'Centro de Costos'),
    takeDate: expect('C11', 'Fecha Toma física'),
    cutDate: expect('C12', 'Fecha de corte de base de datos'),
    responsible: expect('C13', 'Responsable'),
    baseTotal: expect('C18', 'Total de activos en base de datos'),
    notes: expect('C28', 'NOTAS IMPORTANTES:'),
    keeper: expect('C37', 'ENCARGADO:'),
    review: expect('H37', 'REVISA:'),
    control: expect('H39', 'CONTROL INTERNO'),
  };
};

const body = (format) => {
  const label = (value, size = 18) => run(value, { bold: true, size });
  const value = (tag, size = 18) => run(tag, { size });
  const small = 14;

  // Encabezado del acta: número del informe y datos de la toma (filas 8 a 13 del Excel).
  const left = 3600;
  const headerRow = (title, runs) =>
    row([cell(left, [para([label(title)], { after: 0 })], { shade: true }), cell(TOTAL_WIDTH - left, [para(runs, { after: 0 })])]);
  const header = table(
    [left, TOTAL_WIDTH - left],
    [
      headerRow(`${format.report} No.`, [value('{{documento.numero}}')]),
      headerRow('Fecha del acta', [value('{{documento.fecha}}')]),
      headerRow(format.center, [value('{{centroCosto.codigo}}'), run(' '), value('{{centroCosto.nombre}}')]),
      headerRow('Toma física', [value('{{campos.tomaCodigo}}'), run(' — '), value('{{campos.tomaNombre}}')]),
      headerRow('Alcance de la toma', [value('{{campos.alcance}}')]),
      headerRow(format.takeDate, [run('Del '), value('{{campos.fechaInicio}}'), run(' al '), value('{{campos.fechaCierre}}')]),
      headerRow(format.cutDate, [value('{{campos.corteContable}}')]),
      headerRow(format.responsible, [value('{{firmante.responsable.nombre}}')]),
    ],
  );

  // Conteos de la toma: el equivalente del «Total de activos en base de datos» y de la diferencia del Excel.
  const countWidths = [3000, 1800, 3000, 1800, 3000, 1800];
  const count = (title, tag) => [
    cell(countWidths[0], [para([label(title, 16)], { after: 0 })], { shade: true }),
    cell(countWidths[1], [para([value(tag, 16)], { align: 'center', after: 0 })]),
  ];
  const counts = table(
    countWidths,
    [
      row([
        ...count(format.baseTotal, '{{campos.totalEsperados}}'),
        ...count('Verificados', '{{campos.totalVerificados}}'),
        ...count('Porcentaje verificado', '{{campos.porcentajeVerificado}}'),
      ]),
      row([
        ...count('Encontrados', '{{campos.totalEncontrados}}'),
        ...count('En otra ubicación', '{{campos.totalOtraUbicacion}}'),
        ...count('No encontrados', '{{campos.totalFaltantes}}'),
      ]),
      row([
        ...count('No verificados', '{{campos.totalNoVerificados}}'),
        ...count('Sobrantes', '{{campos.totalSobrantes}}'),
        ...count('Sin categoría de hallazgo', '{{campos.totalSinCategoria}}'),
      ]),
    ],
  );

  // Resumen de hallazgos (filas 17 a 22): una fila por categoría activa y definida del catálogo, y la fila TOTAL.
  const findingWidths = [5600, 1800, 2600, 1800, 2600];
  const findings = table(findingWidths, [
    row(
      FINDINGS_HEADERS.map((item, index) =>
        cell(findingWidths[index], [para([label(item.header, 16)], { align: 'center', after: 0 })], { shade: true }),
      ),
      { header: true },
    ),
    row([
      cell(findingWidths[0], [
        para(
          [
            run('{{#tablas.hallazgos}}{{#esTotal}}', { size: 16 }),
            run('{{nombre}}', { bold: true, size: 16 }),
            run('{{/esTotal}}{{^esTotal}}{{codigo}} — {{nombre}}{{/esTotal}}', { size: 16 }),
          ],
          { after: 0 },
        ),
      ]),
      cell(findingWidths[1], [para([value('{{cantidad}}', 16)], { align: 'center', after: 0 })]),
      cell(findingWidths[2], [para([value('{{valorCompra}}', 16)], { align: 'right', after: 0 })]),
      cell(findingWidths[3], [para([value('{{porcentaje}}', 16)], { align: 'center', after: 0 })]),
      cell(findingWidths[4], [para([value('{{valorLibros}}{{/tablas.hallazgos}}', 16)], { align: 'right', after: 0 })]),
    ]),
  ]);
  const findingsNote = para(
    [
      run(
        'Porcentaje sobre el número de bienes con categoría de hallazgo. «Sin dato»: el sistema no tiene el valor de al menos uno de los bienes de la fila; no equivale a cero.',
        { size: 14 },
      ),
    ],
    { after: 120 },
  );

  // Sustituciones de firmante por separación de funciones (no están en el Excel: las exige el motor).
  const substitutions = [
    para([run('{{#tablas.sustituciones}}', { size: small })], { after: 0 }),
    para(
      [
        run('Sustitución de firmante (separación de funciones): ', { bold: true, size: small }),
        run('firma por {{rol}} {{sustituto}} en lugar de {{sustituido}}, que firma el acta como {{conflicto}}. Motivo: {{motivo}}', { size: small }),
      ],
      { after: 0 },
    ),
    para([run('{{/tablas.sustituciones}}', { size: small })], { after: 0 }),
  ];

  // Firmas (filas 37 a 44): primero el encargado (responsable), luego Control Interno.
  const half = TOTAL_WIDTH / 2;
  const signatureBlock = (roleTitle, subtitleRuns, nameTag, cargoTag) => [
    para([label(roleTitle)], { after: 0, keepNext: true }),
    para(subtitleRuns, { after: 300, keepNext: true }),
    para([run('_______________________________________')], { after: 0, keepNext: true }),
    para([value(nameTag)], { after: 0, keepNext: true }),
    para([value(cargoTag)], { after: 0 }),
  ];
  const signatures = table(
    [half, half],
    [
      row([
        cell(half, signatureBlock(format.keeper, [value('{{centroCosto.codigo}}'), run(' '), value('{{centroCosto.nombre}}')], '{{firmante.responsable.nombre}}', '{{firmante.responsable.cargo}}')),
        cell(half, signatureBlock(format.review, [label(format.control)], '{{firmante.audita.nombre}}', '{{firmante.audita.cargo}}')),
      ]),
    ],
    { borders: false },
  );

  // Anexo 1: detalle por activo (hoja «Total Activos .»).
  const widths = COLUMNS.map((column) => column.width);
  const assets = table(widths, [
    row(
      COLUMNS.map((column) => cell(column.width, [para([run(column.label ?? column.header, { bold: true, size: small })], { align: 'center', after: 0 })], { shade: true })),
      { header: true },
    ),
    row(
      COLUMNS.map((column, index) => {
        const tag = index === 0 ? `{{#activos}}${column.tag}` : index === COLUMNS.length - 1 ? `${column.tag}{{/activos}}` : column.tag;
        return cell(column.width, [para([run(tag, { size: small })], { align: column.align ?? 'left', after: 0 })]);
      }),
    ),
  ]);

  // Anexo 2: sobrantes sin activo registrado (no está en el Excel). Solo se imprime si hay alguno.
  const surplusColumns = [
    { header: '#', tag: '{{indice}}', width: 400, align: 'center' },
    { header: 'Descripción', tag: '{{descripcion}}', width: 4000 },
    { header: 'Ubicación', tag: '{{ubicacion}}', width: 2200 },
    { header: 'Condición', tag: '{{condicion}}', width: 1500 },
    { header: 'Resolución', tag: '{{resolucion}}', width: 1900 },
    { header: 'Motivo', tag: '{{motivoResolucion}}', width: 2900 },
    { header: 'Activo creado', tag: '{{activoCreado}}', width: 1500 },
  ];
  const surplus = table(
    surplusColumns.map((column) => column.width),
    [
      row(
        surplusColumns.map((column) => cell(column.width, [para([run(column.header, { bold: true, size: small })], { align: 'center', after: 0 })], { shade: true })),
        { header: true },
      ),
      row(
        surplusColumns.map((column, index) => {
          const tag =
            index === 0 ? `{{#tablas.sobrantes}}${column.tag}` : index === surplusColumns.length - 1 ? `${column.tag}{{/tablas.sobrantes}}` : column.tag;
          return cell(column.width, [para([run(tag, { size: small })], { align: column.align ?? 'left', after: 0 })]);
        }),
      ),
    ],
  );

  return [
    header,
    para([label('Resumen de la toma', 18)], { before: 80, after: 40, keepNext: true }),
    counts,
    para([label(format.report, 18)], { before: 80, after: 40, keepNext: true }),
    findings,
    findingsNote,
    ...substitutions,
    signatures,
    para([label('ANEXO 1. Detalle de los activos de la toma', 18)], { after: 60, keepNext: true, pageBreakBefore: true }),
    assets,
    para([run('Total de activos en el acta: ', { bold: true, size: 16 }), run('{{totalElementos}}', { size: 16 })], { after: 120 }),
    para([run('{{#tablas.sobrantes.length}}', { size: small })], { after: 0, keepNext: true }),
    para([label('ANEXO 2. Sobrantes sin activo registrado', 18)], { after: 60, keepNext: true }),
    surplus,
    para([run('{{/tablas.sobrantes.length}}', { size: small })], { after: 0 }),
  ].join('');
};

// El encabezado de la base es de hoja vertical (10 640 twips): en horizontal se ensancha la columna del título para
// que ocupe el ancho útil (14 400), y «Versión:» recupera el espacio que el Excel trae («Versión: 2»).
const landscapeHeader = (xml) => {
  const widths = { 3225: 3225, 4636: TOTAL_WIDTH - 3225 - 2779, 2779: 2779 };
  let result = xml
    .replace('<w:tblW w:w="10640" w:type="dxa"/>', `<w:tblW w:w="${TOTAL_WIDTH}" w:type="dxa"/>`)
    .replace('<w:tblInd w:w="-289" w:type="dxa"/>', '<w:tblInd w:w="0" w:type="dxa"/>')
    .replace(/<w:(gridCol|tcW) w:w="(3225|4636|2779)"/g, (_, tag, width) => `<w:${tag} w:w="${widths[width]}"`);
  if (!result.includes(`<w:tblW w:w="${TOTAL_WIDTH}"`)) {
    throw new Error('El encabezado de la base cambió: no encontré su tabla de 10 640 twips');
  }
  result = replaceTextOrFail(result, 'Versión:', 'Versión: ').replace('<w:t>Versión: </w:t>', '<w:t xml:space="preserve">Versión: </w:t>');
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
  // Hoja carta horizontal, márgenes de 0,5" (720 twips): 14 400 twips útiles para las 12 columnas del anexo.
  const landscape = sectPr
    .replace(/<w:pgSz [^>]*\/>/, '<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/>')
    .replace(/<w:pgMar [^>]*\/>/, '<w:pgMar w:top="1080" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/>');
  const start = document.indexOf('<w:body>') + '<w:body>'.length;
  const end = document.indexOf('</w:body>');
  zip.file('word/document.xml', `${document.slice(0, start)}${body(format)}${landscape}${document.slice(end)}`);

  // Encabezado SGC de la base: ya trae {{formato.codigo}}, {{formato.version}} y {{formato.fechaVigencia}};
  // cambia el título del formato por el del Excel (F6).
  const header = zip.file('word/header1.xml').asText();
  zip.file('word/header1.xml', landscapeHeader(replaceTextOrFail(header, 'ACTA DE PRÉSTAMO TEMPORAL DE ACTIVOS FIJOS', format.title)));
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, xlsx, target] = process.argv.slice(2);
  if (!base || !xlsx || !target) {
    throw new Error('Uso: build-oci-21-37-template.mjs <base.docx> <formato.xlsx> <destino.docx>');
  }
  const { output, tags } = await build(await readFile(base), await readFile(xlsx));
  await writeFile(target, output);
  console.log(`Plantilla escrita en ${target}`);
  console.log(tags.join(' '));
}
