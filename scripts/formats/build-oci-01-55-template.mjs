// Convierte el formato institucional OCI-01-55 (Word con campos MERGEFIELD y un
// caso real diligenciado) en una plantilla del motor de documentos, sin datos
// personales. Uso: node scripts/formats/build-oci-01-55-template.mjs <origen.docx> <destino.docx>
import {
  cleanPackage,
  clearAuthorMetadata,
  generateClean,
  PizZip,
  replaceAssetTable,
  replaceInParagraphs,
  replaceMergeFields,
  replaceDocumentTypeLabels,
  replaceSgcHeader,
  replaceText,
  runCli,
  templateTags,
} from './template-builder.mjs';
import { OCI_01_55_SAMPLE, removeInvisibleRuns } from './template-leftovers.mjs';

// La muestra vive junto al chequeo porque el test del chequeo la importa de ahí.
export const SAMPLE = OCI_01_55_SAMPLE;

export const FIELDS = {
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

export const build = (source) => {
  const zip = new PizZip(source);
  let document = replaceMergeFields(zip.file('word/document.xml').asText(), FIELDS);
  document = replaceAssetTable(document, { headerText: 'CODIGO DEL ACTIVO', rowTags: ROW_TAGS });
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
  document = removeInvisibleRuns(document);
  document = replaceText(document, `9${FIELDS.TACTIVOS}`, FIELDS.TACTIVOS);
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
  document = replaceDocumentTypeLabels(document, ['responsable', 'auditor']);
  zip.file('word/document.xml', document);
  zip.file(
    'word/header1.xml',
    replaceSgcHeader(zip.file('word/header1.xml').asText(), { code: 'OCI-01-55', date: 'Fecha: 2026-09-08' }),
  );
  cleanPackage(zip);
  clearAuthorMetadata(zip);
  return { output: generateClean(zip, SAMPLE, { metadata: true }), tags: templateTags(zip) };
};

await runCli(import.meta.url, 'build-oci-01-55-template.mjs', build);
