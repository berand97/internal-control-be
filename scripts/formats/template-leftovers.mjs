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

const paragraphsOf = (xml) =>
  [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) => ({
    xml: match[0],
    text: unescapeXml([...match[0].matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((run) => run[1]).join('')),
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

export const findLeftovers = (docx, sample) => {
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

export const assertTemplateClean = (docx, sample) => {
  const problems = findLeftovers(docx, sample);
  if (problems.length > 0) {
    throw new Error(`La plantilla aún contiene restos del ejemplo:\n - ${problems.join('\n - ')}`);
  }
};

export const removeOrphanExternalRelationships = (rels, referencingXml) =>
  rels.replace(/<Relationship\b[^>]*TargetMode="External"[^>]*\/>/g, (relationship) => {
    const id = relationship.match(/Id="([^"]+)"/)?.[1];
    return id && referencingXml.includes(`"${id}"`) ? relationship : '';
  });
