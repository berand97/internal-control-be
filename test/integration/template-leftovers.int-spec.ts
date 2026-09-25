import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import {
  assertTemplateClean,
  findLeftovers,
  OCI_01_55_SAMPLE,
} from '../../scripts/formats/template-leftovers.mjs';

const TEMPLATE = 'templates/formats/OCI-01-55-v2.docx';

const run = (text: string, props = '') =>
  `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;

const withParagraph = (runs: string, externalLink = false): Buffer => {
  const zip = new PizZip(readFileSync(TEMPLATE));
  const document = zip.file('word/document.xml')?.asText() ?? '';
  zip.file('word/document.xml', document.replace('</w:body>', `<w:p>${runs}</w:p></w:body>`));
  if (externalLink) {
    const rels = zip.file('word/_rels/document.xml.rels')?.asText() ?? '';
    zip.file(
      'word/_rels/document.xml.rels',
      rels.replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://docs.google.com/spreadsheets/d/x" TargetMode="External"/></Relationships>',
      ),
    );
  }
  return zip.generate({ type: 'nodebuffer' });
};

describe('Chequeo de restos del ejemplo en plantillas', () => {
  it('la plantilla OCI-01-55 versionada no conserva nada del acta de ejemplo', () => {
    expect(findLeftovers(readFileSync(TEMPLATE), OCI_01_55_SAMPLE)).toEqual([]);
    expect(() => assertTemplateClean(readFileSync(TEMPLATE), OCI_01_55_SAMPLE)).not.toThrow();
  });

  it('rechaza fragmentos del ejemplo aunque Word los haya partido en varios runs', () => {
    const cases: Array<[string, Buffer, RegExp]> = [
      ['nombre partido', withParagraph(run('Recibe: LEIZ JOHANA PAD') + run('ILLA')), /nombre del ejemplo "PADILLA"/],
      ['nombre con tilde partido', withParagraph(run('Audita: MÓN') + run('ICA ELIANA PE') + run('ÑA')), /nombre del ejemplo "PEÑA"/],
      ['cédula con puntos partida', withParagraph(run('C.C 1.037.5') + run('95.676')), /documento del ejemplo 1037595676/],
      ['número de acta partido', withParagraph(run('ACTA N° 00') + run('92')), /número del ejemplo 0092/],
      ['total del ejemplo pegado al marcador', withParagraph(run('Total: 9') + run('{{totalElementos}}')), /marcador pegado a texto suelto/],
      ['texto invisible', withParagraph(run('nk', '<w:color w:val="FFFFFF"/><w:sz w:val="2"/>') + run(' de fotografías:', '<w:color w:val="FFFFFF"/>')), /texto invisible/],
      ['URL en el texto', withParagraph(run('Ver https://docs.') + run('google.com/x')), /URL en/],
      ['enlace externo huérfano', withParagraph(run('Sin enlaces a la vista'), true), /relación externa/],
    ];
    for (const [label, docx, expected] of cases) {
      const problems = findLeftovers(docx, OCI_01_55_SAMPLE);
      expect(problems.join('\n'), label).toMatch(expected);
      expect(() => assertTemplateClean(docx, OCI_01_55_SAMPLE), label).toThrow(/restos del ejemplo/);
    }
  });
});
