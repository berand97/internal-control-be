import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { readDocxPlaceholders, renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
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
  it('la plantilla OCI-01-55 versionada no conserva nada del acta de ejemplo, tampoco el autor en los metadatos', () => {
    expect(findLeftovers(readFileSync(TEMPLATE), OCI_01_55_SAMPLE, { metadata: true })).toEqual([]);
    expect(() => assertTemplateClean(readFileSync(TEMPLATE), OCI_01_55_SAMPLE, { metadata: true })).not.toThrow();
    const core = new PizZip(readFileSync(TEMPLATE)).file('docProps/core.xml')?.asText() ?? '';
    expect(core).toContain('<dc:creator></dc:creator>');
    expect(core).toContain('<cp:lastModifiedBy></cp:lastModifiedBy>');
  });

  it('la plantilla OCI-01-55 tiene exactamente los marcadores del contrato, con el tipo de documento de cada firmante', () => {
    expect([...readDocxPlaceholders(readFileSync(TEMPLATE))].sort()).toEqual(
      [
        'auditor.cargo',
        'auditor.documento',
        'auditor.nombre',
        'auditor.tipoDocumento',
        'centroCosto.codigo',
        'centroCosto.nombre',
        'codigo',
        'descripcion',
        'documento.fecha',
        'documento.numero',
        'estado',
        'formato.codigo',
        'formato.fechaVigencia',
        'formato.version',
        'idOrigen',
        'indice',
        'observacion',
        'responsable.cargo',
        'responsable.documento',
        'responsable.nombre',
        'responsable.tipoDocumento',
        'totalElementos',
        'unidades',
      ].sort(),
    );
  });

  it('OCI-01-55 imprime la abreviatura del tipo de cada firmante, y solo el número si el tipo se desconoce', () => {
    const text = (responsableTipo: string) => {
      const output = renderDocx(readFileSync(TEMPLATE), {
        formato: { codigo: 'OCI-01-55', version: '2', fechaVigencia: '2026-09-08' },
        documento: { numero: '2026-0001', fecha: '1 DE OCTUBRE DE 2026' },
        centroCosto: { codigo: '4410', nombre: 'SISTEMAS' },
        responsable: { nombre: 'ANA RUIZ', tipoDocumento: responsableTipo, documento: '71000111', cargo: 'DOCENTE' },
        auditor: { nombre: 'SARA MONTOYA', tipoDocumento: 'C.E.', documento: '43000333', cargo: 'AUDITORA' },
        activos: [],
        totalElementos: 0,
      });
      const xml = new PizZip(output).file('word/document.xml')?.asText() ?? '';
      return [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((match) => match[1]).join('');
    };
    const known = text('C.C.');
    expect(known).toContain('C.C. 71000111');
    expect(known).toContain('C.E. 43000333');
    const unknown = text('');
    expect(unknown).toContain(' 71000111');
    expect(unknown).not.toContain('C.C');
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
