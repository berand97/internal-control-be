import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PizZip = require('pizzip');

export const OCI_01_55_SAMPLE = {
  names: ['LEIZ', 'PADILLA', 'MONICA', 'MÓNICA', 'ELIANA', 'PEÑA'],
  documents: ['1006799678', '1037595676'],
  numbers: ['0092', '16762', '91'],
  text: ['Link de', 'fotografías:', 'Link de activos'],
};

const XML_PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

const unescapeXml = (text) =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

const fold = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

// Texto visible del párrafo con los runs unidos. Tabulaciones y saltos de línea
// cuentan como espacio: separan en pantalla lo que está a cada lado.
const paragraphsOf = (xml) =>
  [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => ({
    xml: match[0],
    text: unescapeXml(
      [...match[0].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>/g)]
        .map((run) => (run[2] === undefined ? run[1] : run[2] === 'tab' ? '\t' : '\n'))
        .join(''),
    ),
  }));

const invisibleRuns = (xml) =>
  [...xml.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)]
    .map((match) => match[0])
    .filter((run) => {
      const text = unescapeXml([...run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((item) => item[1]).join(''));
      if (text.trim() === '') {
        return false;
      }
      const props = run.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] ?? '';
      const size = Number(props.match(/<w:sz w:val="(\d+)"/)?.[1] ?? '24');
      return (
        /<w:vanish\/>|<w:vanish w:val="(?:1|true)"\/>/.test(props) ||
        /<w:color w:val="FFFFFF"/i.test(props) ||
        size <= 4
      );
    });

// Campos que Word calcula al abrir el documento y que no llevan datos: la
// numeración de páginas del pie. Cualquier otro campo (SAVEDATE, HYPERLINK,
// MERGEFIELD, …) se recalcula o enlaza fuera de la plantilla.
const ALLOWED_FIELDS = /^(PAGE|NUMPAGES)\b/;

const fieldInstructions = (xml) => [
  ...[...xml.matchAll(/<w:fldSimple\b[^>]*w:instr="([^"]*)"/g)].map((match) => unescapeXml(match[1]).trim()),
  ...[...xml.matchAll(/<w:instrText(?: [^>]*)?>([^<]*)<\/w:instrText>/g)]
    .map((match) => unescapeXml(match[1]).trim())
    .filter((instr) => instr !== ''),
];

// Metadatos del paquete (autor, último editor, …). Solo se revisan si el
// llamador lo pide; las dos plantillas versionadas (OCI-01-55 y OCI-01-65) se
// construyen con clearAuthorMetadata y pasan con { metadata: true }.
const METADATA_PARTS = /^docProps\/(core|app|custom)\.xml$/;

export const findLeftovers = (docx, sample, { metadata = false } = {}) => {
  const zip = new PizZip(docx);
  const problems = [];
  const names = Object.keys(zip.files).filter((name) => XML_PARTS.test(name));
  for (const name of names) {
    const xml = zip.file(name).asText();
    for (const paragraph of paragraphsOf(xml)) {
      const folded = fold(paragraph.text);
      const digits = paragraph.text.replace(/\D/g, '');
      for (const value of sample.names) {
        if (new RegExp(`\\b${fold(value)}\\b`).test(folded)) {
          problems.push(`${name}: nombre del ejemplo "${value}" en «${paragraph.text.trim()}»`);
        }
      }
      for (const value of sample.documents) {
        if (digits.includes(value)) {
          problems.push(`${name}: documento del ejemplo ${value} en «${paragraph.text.trim()}»`);
        }
      }
      for (const value of sample.numbers) {
        const outsideTags = paragraph.text.replace(/\{\{[^}]*\}\}/g, ' ');
        if (new RegExp(`(^|\\D)${value}(\\D|$)`).test(outsideTags)) {
          problems.push(`${name}: número del ejemplo ${value} en «${paragraph.text.trim()}»`);
        }
      }
      for (const value of sample.text) {
        if (folded.includes(fold(value))) {
          problems.push(`${name}: texto del ejemplo "${value}" en «${paragraph.text.trim()}»`);
        }
      }
      if (/https?:\/\/|www\.|docs\.google|drive\.google/i.test(paragraph.text)) {
        problems.push(`${name}: URL en «${paragraph.text.trim()}»`);
      }
      if (/[\p{L}\p{N}]\{\{|\}\}[\p{L}\p{N}]/u.test(paragraph.text)) {
        problems.push(`${name}: marcador pegado a texto suelto en «${paragraph.text.trim()}»`);
      }
    }
    for (const run of invisibleRuns(xml)) {
      const text = unescapeXml([...run.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((item) => item[1]).join(''));
      problems.push(`${name}: texto invisible (blanco, oculto o de tamaño mínimo) «${text}»`);
    }
    if (/MERGEFIELD|<w:hyperlink\b/.test(xml)) {
      problems.push(`${name}: quedan campos de combinación o hipervínculos`);
    }
    for (const instr of fieldInstructions(xml).filter((item) => !ALLOWED_FIELDS.test(item))) {
      problems.push(`${name}: campo de Word que se recalcula o enlaza «${instr}»`);
    }
  }
  const settings = zip.file('word/settings.xml');
  if (settings && /<w:mailMerge>/.test(settings.asText())) {
    problems.push('word/settings.xml: queda la combinación de correspondencia (ruta a la hoja de datos)');
  }
  if (metadata) {
    for (const name of Object.keys(zip.files).filter((item) => METADATA_PARTS.test(item))) {
      const folded = fold(unescapeXml(zip.file(name).asText().replace(/<[^>]+>/g, ' ')));
      for (const value of sample.names) {
        if (new RegExp(`\\b${fold(value)}\\b`).test(folded)) {
          problems.push(`${name}: nombre del ejemplo "${value}" en los metadatos`);
        }
      }
    }
  }
  for (const rels of Object.keys(zip.files).filter((name) => name.endsWith('.rels'))) {
    if (/TargetMode="External"/.test(zip.file(rels).asText())) {
      problems.push(`${rels}: relación externa (enlace o recurso fuera del documento)`);
    }
  }
  return problems;
};

export const removeInvisibleRuns = (xml) => {
  let result = xml;
  for (const run of invisibleRuns(xml)) {
    result = result.replace(run, '');
  }
  return result;
};

export const assertTemplateClean = (docx, sample, options) => {
  const problems = findLeftovers(docx, sample, options);
  if (problems.length > 0) {
    throw new Error(`La plantilla aún contiene restos del ejemplo:\n - ${problems.join('\n - ')}`);
  }
};

export const removeOrphanExternalRelationships = (rels, referencingXml) =>
  rels.replace(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g, (relationship) => {
    const id = relationship.match(/Id="([^"]+)"/)?.[1];
    return id && referencingXml.includes(`"${id}"`) ? relationship : '';
  });
