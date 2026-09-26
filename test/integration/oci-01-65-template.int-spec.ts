// Plantilla OCI-01-65 (Acta de préstamo temporal de activos fijos).
//
// Se construye desde el Word institucional con:
//   node scripts/formats/build-oci-01-65-template.mjs "docs/acta de préstamo temporal de activos fijos mdf.docx" templates/formats/OCI-01-65-v2.docx
// y se carga al motor como versión de plantilla del formato:
//   POST /documents/formats/OCI-01-65/templates   (multipart/form-data, permiso document_template:update:global)
//     file=@templates/formats/OCI-01-65-v2.docx  sgcVersion=2  effectiveDate=2026-09-08
// La carga guarda los marcadores que lee readDocxPlaceholders; este test fija esa lista.
//
// No usa Gotenberg: renderiza el DOCX con el renderizador real del repo.
import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { readDocxPlaceholders, renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
import { SAMPLE } from '../../scripts/formats/build-oci-01-65-template.mjs';
import { assertTemplateClean, findLeftovers } from '../../scripts/formats/template-leftovers.mjs';

const TEMPLATE = 'templates/formats/OCI-01-65-v2.docx';

// Contrato de marcadores del OCI-01-65. Cualquier marcador nuevo o faltante
// en la plantilla rompe el test.
const EXPECTED_TAGS = [
  '#activos',
  '/activos',
  'campos.fechaEntrega',
  'campos.fechaEstimadaDevolucion',
  'campos.tiempoUso',
  'centroCosto.codigo',
  'centroCosto.nombre',
  'codigo',
  'descripcion',
  'documento.fecha',
  'documento.numero',
  'estado',
  'firmante.audita.cargo',
  'firmante.audita.nombre',
  'firmante.entrega.cargo',
  'firmante.entrega.documento',
  'firmante.entrega.nombre',
  'firmante.entrega.tipoDocumento',
  'firmante.recibe.cargo',
  'firmante.recibe.documento',
  'firmante.recibe.nombre',
  'firmante.recibe.tipoDocumento',
  'formato.codigo',
  'formato.fechaVigencia',
  'formato.version',
  'idOrigen',
  'indice',
  'observacion',
  'responsable.nombre',
  'totalElementos',
  'unidades',
];

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

const paragraphs = (docx: Buffer): string[] => {
  const zip = new PizZip(docx);
  return Object.keys(zip.files)
    .filter((name) => PARTS.test(name))
    .flatMap((name) =>
      [...(zip.file(name)?.asText() ?? '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) =>
        [...match[0].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g)]
          .map((item) => item[1] ?? '\t')
          .join('')
          .replaceAll('&amp;', '&')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>'),
      ),
    );
};

const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

type Signer = {
  orden: number;
  rol: string;
  etiqueta: string;
  personId: string;
  nombre: string;
  tipoDocumento: string;
  documento: string;
  cargo: string;
};

const SIGNERS: Signer[] = [
  { orden: 1, rol: 'ENTREGA', etiqueta: 'Entrega', personId: 'p-entrega', nombre: 'GLORIA ESTELA BUITRAGO', tipoDocumento: 'C.C.', documento: '71000111', cargo: 'COORDINADORA DE SISTEMAS' },
  { orden: 2, rol: 'RECIBE', etiqueta: 'Recibe', personId: 'p-recibe', nombre: 'JULIAN ANDRES OSORIO', tipoDocumento: 'C.E.', documento: '98000222', cargo: 'DOCENTE INVESTIGADOR' },
  { orden: 3, rol: 'AUDITA', etiqueta: 'Control Interno', personId: 'p-audita', nombre: 'SARA LUCIA MONTOYA', tipoDocumento: 'C.C.', documento: '43000333', cargo: 'AUDITORA INTERNA' },
];

const ASSETS = [
  { id: 'a-1', idOrigen: '41001', codigo: '50011', descripcion: 'VIDEOBEAM EPSON X41', estado: 'Bueno', observacion: 'Con control remoto' },
  { id: 'a-2', idOrigen: '41002', codigo: '50012', descripcion: 'TABLERO ACRILICO MOVIL', estado: 'Regular', observacion: '' },
  { id: 'a-3', idOrigen: '41003', codigo: '50013', descripcion: 'CAMARA DOCUMENTAL IPEVO', estado: 'Sin verificar', observacion: '' },
];

// Misma forma que DocumentEngineService.buildContext
// (src/modules/documents/services/document-engine.service.ts:934-962) más
// `firmante.<rol>` y los campos del préstamo en `campos`.
const context = (count: number, signers: Signer[] = SIGNERS): Record<string, unknown> => {
  const auditor = signers.find((signer) => signer.rol === 'AUDITA');
  const recibe = signers.find((signer) => signer.rol === 'RECIBE');
  const activos = ASSETS.slice(0, count).map((asset, index) => ({ indice: index + 1, unidades: 1, ...asset }));
  return {
    formato: {
      codigo: 'OCI-01-65',
      clave: 'OCI-01-65',
      nombre: 'Acta de préstamo temporal de activos fijos',
      version: '2',
      fechaVigencia: '2026-09-08',
    },
    documento: { numero: '2026-0042', fecha: '25 de septiembre de 2026', fechaIso: '2026-09-25' },
    centroCosto: { codigo: '4100', nombre: 'VICERRECTORIA ACADEMICA' },
    responsable: { nombre: recibe?.nombre, tipoDocumento: recibe?.tipoDocumento, documento: recibe?.documento, cargo: recibe?.cargo },
    auditor: { nombre: auditor?.nombre, tipoDocumento: auditor?.tipoDocumento, documento: auditor?.documento, cargo: auditor?.cargo },
    firmantes: signers,
    firmante: Object.fromEntries(
      signers.map((signer) => [
        signer.rol.toLowerCase(),
        { nombre: signer.nombre, tipoDocumento: signer.tipoDocumento, documento: signer.documento, cargo: signer.cargo },
      ]),
    ),
    activos,
    totalElementos: activos.length,
    campos: {
      fechaEntrega: '1 de octubre de 2026',
      fechaEstimadaDevolucion: '30 de noviembre de 2026',
      tiempoUso: '2 meses',
    },
  };
};

describe('Plantilla OCI-01-65 (acta de préstamo temporal)', () => {
  const template = readFileSync(TEMPLATE);

  it('no conserva nada del acta de ejemplo, ni en el texto ni en los metadatos', () => {
    expect(findLeftovers(template, SAMPLE, { metadata: true })).toEqual([]);
    expect(() => assertTemplateClean(template, SAMPLE, { metadata: true })).not.toThrow();
  });

  it('tiene exactamente los marcadores del contrato', () => {
    const tags = [...new Set(paragraphs(template).join('\n').match(/\{\{[^}]*\}\}/g) ?? [])]
      .map((tag) => tag.slice(2, -2).trim())
      .sort();
    expect(tags).toEqual([...EXPECTED_TAGS].sort());
    // Lo que la carga (POST /documents/formats/OCI-01-65/templates) registra como marcadores.
    expect([...readDocxPlaceholders(template)].sort()).toEqual(
      EXPECTED_TAGS.filter((tag) => !tag.startsWith('#') && !tag.startsWith('/')).sort(),
    );
  });

  it('la sección de devolución queda en blanco, sin marcadores', () => {
    const text = paragraphs(template).map((item) => item.trim());
    expect(text).toContain('Registro de devolución:');
    expect(text).toContain('Fecha de devolución:');
    expect(text).toContain('Estado del equipo al momento de la devolución:');
  });

  it('el chequeo rechaza campos que Word recalcula, la combinación de correspondencia y el autor del ejemplo', () => {
    const tamper = (edit: (zip: PizZip) => void): Buffer => {
      const zip = new PizZip(template);
      edit(zip);
      return zip.generate({ type: 'nodebuffer' });
    };
    const addToBody = (zip: PizZip, xml: string) =>
      zip.file('word/document.xml', (zip.file('word/document.xml')?.asText() ?? '').replace('</w:body>', `${xml}</w:body>`));
    const field = (instr: string, shown: string) =>
      `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${shown}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
    const cases: Array<[string, Buffer, RegExp]> = [
      ['SAVEDATE', tamper((zip) => addToBody(zip, field('SAVEDATE  \\@ "d \'de\' MMMM"', '1 de enero'))), /campo de Word.*SAVEDATE/],
      ['HYPERLINK como campo', tamper((zip) => addToBody(zip, field('HYPERLINK "https://example.org"', 'Ver'))), /campo de Word.*HYPERLINK/],
      ['fldSimple', tamper((zip) => addToBody(zip, '<w:p><w:fldSimple w:instr=" DATE "><w:r><w:t>x</w:t></w:r></w:fldSimple></w:p>')), /campo de Word.*DATE/],
      [
        'combinación de correspondencia',
        tamper((zip) =>
          zip.file(
            'word/settings.xml',
            (zip.file('word/settings.xml')?.asText() ?? '').replace('</w:settings>', '<w:mailMerge><w:mainDocumentType w:val="formLetters"/></w:mailMerge></w:settings>'),
          ),
        ),
        /combinación de correspondencia/,
      ],
      [
        'autor en metadatos',
        tamper((zip) =>
          zip.file('docProps/core.xml', (zip.file('docProps/core.xml')?.asText() ?? '').replace('<dc:creator></dc:creator>', '<dc:creator>Mónica Peña</dc:creator>')),
        ),
        /nombre del ejemplo "PEÑA" en los metadatos/,
      ],
    ];
    for (const [label, docx, expected] of cases) {
      expect(findLeftovers(docx, SAMPLE, { metadata: true }).join('\n'), label).toMatch(expected);
    }
    // Los números de página del pie son campos permitidos.
    expect(findLeftovers(template, SAMPLE).join('\n')).not.toMatch(/PAGE/);
  });

  it('tipo de documento desconocido: imprime solo el número, nunca C.C. por defecto', () => {
    const signers = SIGNERS.map((signer) => ({ ...signer, tipoDocumento: '' }));
    const text = paragraphs(renderDocx(template, context(1, signers))).join('\n');
    expect(text).toContain('98000222');
    expect(text).toContain('71000111');
    expect(text).not.toMatch(/C\.\s*C/);
    expect(text).not.toMatch(/C\.E/);
  });

  for (const count of [1, 3]) {
    it(`renderiza con ${count} activo(s): total, filas, firmantes y sin restos`, () => {
      const data = context(count);
      const output = renderDocx(template, data);
      const lines = paragraphs(output);
      const text = lines.join('\n');

      expect(text).not.toContain('{{');
      expect(text).not.toContain('}}');
      expect(findLeftovers(output, SAMPLE, { metadata: true })).toEqual([]);
      const folded = fold(text);
      for (const fragment of [...SAMPLE.names, ...SAMPLE.documents, ...SAMPLE.text]) {
        expect(folded, fragment).not.toMatch(new RegExp(`\\b${fold(fragment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));
      }
      for (const number of SAMPLE.numbers) {
        expect(text, number).not.toMatch(new RegExp(`(^|\\D)${number}(\\D|$)`));
      }

      const total = text.match(/Total, elementos entregados:\s*(\S+)/)?.[1];
      expect(total).toBe(String(count));
      for (const asset of ASSETS.slice(0, count)) {
        expect(lines.map((line) => line.trim())).toContain(`${asset.idOrigen} - ${asset.codigo} ${asset.descripcion}`);
      }
      for (const asset of ASSETS.slice(count)) {
        expect(text).not.toContain(asset.descripcion);
      }

      for (const signer of SIGNERS) {
        expect(text, signer.rol).toContain(signer.nombre);
        expect(text, signer.rol).toContain(signer.cargo);
      }
      // Cada firmante con la abreviatura de su tipo (quien recibe tiene cédula de extranjería).
      expect(text).toContain('C.E. 98000222');
      expect(text).toContain('C.C. 71000111');
      expect(text).not.toContain('C.C 98000222');
      expect(text).toContain('2026-0042');
      expect(text).not.toContain('2026 - ');
      expect(text).toContain('Fecha: 25 de septiembre de 2026');
      expect(text).toContain('Fecha de entrega: 1 de octubre de 2026');
      expect(text).toContain('30 de noviembre de 2026');
      expect(text).toContain('Tiempo de uso estimado:2 meses');
      expect(text).toContain('4100 VICERRECTORIA ACADEMICA');
      expect(text).toContain('Código: OCI-01-65');
      expect(text).toContain('FECHA: 2026-09-08');
    });
  }
});
