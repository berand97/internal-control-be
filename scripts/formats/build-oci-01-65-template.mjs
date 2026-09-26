// Convierte el formato institucional OCI-01-65 (Acta de préstamo temporal de
// activos fijos: Word con campos MERGEFIELD y un caso real diligenciado) en una
// plantilla del motor de documentos, sin datos personales.
// Uso: node scripts/formats/build-oci-01-65-template.mjs <origen.docx> <destino.docx>
import {
  cleanPackage,
  clearAuthorMetadata,
  generateClean,
  PizZip,
  plainText,
  replaceAssetTable,
  replaceFields,
  replaceInParagraphs,
  replaceDocumentTypeLabels,
  replaceMergeFields,
  replaceSgcHeader,
  replaceTextOrFail,
  runCli,
  templateTags,
} from './template-builder.mjs';

// Datos del caso diligenciado en el Word de origen. Si cualquiera sobrevive en
// la plantilla, el constructor y el test fallan.
export const SAMPLE = {
  names: ['MAYRIM', 'DENISSE', 'CRUZ', 'LEAL', 'IVONNE', 'ELIANA', 'ROA', 'PERDOMO', 'MONICA', 'MÓNICA', 'PEÑA'],
  documents: ['1234089865', '1152442792'],
  numbers: ['0001', '31614', '27868', '3030', '3420'],
  text: [
    'CENTRO DE IDIOMAS',
    'PORTATIL',
    'LATITUDE',
    'CORE i5',
    'DOCENTE AULA',
    'JEFE CENTRO',
    'Buen estado',
    '27 de marzo',
    '11 de diciembre',
    '9 de septiembre',
    '8 meses',
    '14 días',
    'Link de Imágenes',
    'Buscador por activo',
    '14AEPNzpQUmzh34pgION8AhRR7LhMEIBegaF0qpYPqaQ',
    '1222339576',
    '192.168.4.60',
    'Base prestamos',
  ],
};

// Contrato de marcadores fijado por el orquestador. Los campos que aparecen
// varias veces con significados distintos van en orden de documento.
export const FIELDS = {
  ACTA: '{{documento.numero}}',
  RESPONSABLE: ['{{responsable.nombre}}', '{{firmante.recibe.nombre}}'],
  CENTRO_DE_COSTOS_: '{{centroCosto.codigo}} {{centroCosto.nombre}}',
  // Fila de activos: la tabla se reescribe celda por celda con ROW_TAGS; estos
  // valores solo evitan que queden campos sin equivalencia.
  COD_ACTIVO: '{{idOrigen}} - {{codigo}}',
  NOMBRE_: '{{descripcion}}',
  OBSERVACIONES_: '{{observacion}}',
  ESTADO_: '{{estado}}',
  // La primera aparición es la columna UNDS de la fila; la segunda, el total.
  TACTIVOS: ['{{unidades}}', '{{totalElementos}}'],
  FECHA_DE_ENTREGA1: '{{campos.fechaEntrega}}',
  FECHA_PRESTAMO1: '{{campos.fechaEstimadaDevolucion}}',
  TIEMPO_DE_PRESTAMO: '{{campos.tiempoUso}}',
  JEFE_AREA: '{{firmante.entrega.nombre}}',
  DOCUMENTO: '{{firmante.recibe.documento}}',
  DOCUMENTO_JEFE: '{{firmante.entrega.documento}}',
  CARGO: '{{firmante.recibe.cargo}}',
};

// Columnas: #, CÓDIGO Y DESCRIPCIÓN DEL ACTIVO, UNDS, OBSERVACION, ESTADO. El
// ejemplo imprime «31614 - 27868 PORTATIL …»: 31614 es el ID de origen
// (asset_import_origin.legacy_asset_id) y 27868 el código (LEGACY_CODE), igual
// que las columnas ID y CODIGO del OCI-01-55.
const ROW_TAGS = [
  '{{#activos}}{{indice}}',
  '{{idOrigen}} - {{codigo}} {{descripcion}}',
  '{{unidades}}',
  '{{observacion}}',
  '{{estado}}{{/activos}}',
];

const onlyText = (paragraph) => plainText(paragraph).trim();

export const build = (source) => {
  const zip = new PizZip(source);
  let document = zip.file('word/document.xml').asText();

  // SAVEDATE lo recalcula Word al guardar: se cambia por la fecha del motor.
  // El hipervínculo a la hoja de imágenes (campo HYPERLINK) se elimina.
  document = replaceFields(document, (instr) => {
    if (/^SAVEDATE\b/.test(instr)) {
      return '{{documento.fecha}}';
    }
    if (/^HYPERLINK\b/.test(instr)) {
      return '';
    }
    return undefined;
  });
  document = replaceMergeFields(document, FIELDS);
  document = replaceAssetTable(document, { headerText: 'CÓDIGO Y DESCRIPCIÓN DEL ACTIVO', rowTags: ROW_TAGS });

  // El ejemplo imprime «2026 - 0001» (año literal + ACTA); el motor ya entrega
  // el número completo AAAA-NNNN.
  document = replaceTextOrFail(document, '2026 - {{documento.numero}}', '{{documento.numero}}');

  // Línea «Link de Imágenes del activo en préstamo:»: se quita completa.
  const withoutLink = replaceInParagraphs(document, (p) => onlyText(p).startsWith('Link de Im'), () => '');
  if (withoutLink === document) {
    throw new Error('No encontré la línea del enlace de imágenes');
  }
  document = withoutLink;

  // Firmas: el cargo de quien entrega está escrito a mano en el ejemplo, y el
  // visto bueno (Control Interno) es texto fijo con el nombre de la auditora.
  document = replaceTextOrFail(document, 'JEFE CENTRO IDIOMAS', '{{firmante.entrega.cargo}}');
  document = replaceTextOrFail(document, 'MONICA ELIANA PEÑA', '{{firmante.audita.nombre}}');
  const auditCargo = replaceInParagraphs(
    document,
    (p) => onlyText(p) === 'Control Interno',
    (p) => replaceTextOrFail(p, 'Control Interno', '{{firmante.audita.cargo}}'),
  );
  if (auditCargo === document) {
    throw new Error('No encontré el cargo del visto bueno');
  }
  document = auditCargo;

  // «C.C» fijo antes de los documentos de quien recibe y quien entrega.
  document = replaceDocumentTypeLabels(document, ['firmante.recibe', 'firmante.entrega']);

  zip.file('word/document.xml', document);
  zip.file(
    'word/header1.xml',
    replaceSgcHeader(zip.file('word/header1.xml').asText(), { code: 'OCI-01-65', date: 'FECHA: 2026-09-08' }),
  );
  cleanPackage(zip);
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

await runCli(import.meta.url, 'build-oci-01-65-template.mjs', build);
