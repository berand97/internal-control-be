import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { readDocxPlaceholders, renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
import { build, SAMPLE } from '../../scripts/formats/build-oci-17-90-baja-template.mjs';
import { assertTemplateClean, findLeftovers } from '../../scripts/formats/template-leftovers.mjs';

const TEMPLATE = 'templates/formats/OCI-17-90-BAJA-v1.docx';
const BASE = 'templates/formats/OCI-01-65-v2.docx';
const XLSX = join(
  'docs',
  (existsSync('docs') ? readdirSync('docs') : []).find((name) => name.normalize('NFC') === 'acta de baja de activos fijos mdf.xlsx') ?? 'no-existe.xlsx',
);

const EXPECTED_TAGS = [
  '#activos',
  '/activos',
  '#campos.nota',
  '/campos.nota',
  '#firmantes',
  '/firmantes',
  '#tablas.sustituciones',
  '/tablas.sustituciones',
  'campos.acuerdoConsejo',
  'campos.cantidad',
  'campos.centro',
  'campos.diferencia',
  'campos.documento',
  'campos.estado',
  'campos.fechaAcuerdo',
  'campos.fechaCompra',
  'campos.informesVicefinanciera',
  'campos.nota',
  'campos.observaciones',
  'campos.precioCompra',
  'campos.totalAutorizado',
  'campos.totalInforme',
  'cargo',
  'codigo',
  'conflicto',
  'descripcion',
  'documento.fecha',
  'documento.numero',
  'etiqueta',
  'formato.codigo',
  'formato.fechaVigencia',
  'formato.version',
  'idOrigen',
  'indice',
  'motivo',
  'nombre',
  'rol',
  'sustituido',
  'sustituto',
];

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

const paragraphs = (docx: Buffer): string[] => {
  const zip = new PizZip(docx);
  return Object.keys(zip.files)
    .filter((name) => PARTS.test(name))
    .flatMap((name) =>
      [...(zip.file(name)?.asText() ?? '').matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((match) =>
        [...match[0].replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '').matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)]
          .map((item) => item[1])
          .join('')
          .replaceAll('&amp;', '&'),
      ),
    );
};

const signer = (orden: number, rol: string, etiqueta: string, nombre: string, cargo: string) => ({
  orden,
  rol,
  etiqueta,
  nombre,
  tipoDocumento: 'C.C.',
  documento: `10${orden}`,
  cargo,
});

const context = (count: number, withNote: boolean, substitution: boolean): Record<string, unknown> => {
  const activos = [
    { codigo: '50011', idOrigen: '41001', descripcion: 'VIDEOBEAM EPSON X41', estado: 'Obsoleto', centro: '7100 BIBLIOTECA CENTRAL', precio: '$ 900.000,00' },
    { codigo: '50012', idOrigen: '41002', descripcion: 'TABLERO ACRILICO MOVIL', estado: 'Dañado', centro: '7200 LABORATORIO DE FISICA', precio: '$ 400.000,00' },
  ]
    .slice(0, count)
    .map((asset, index) => ({
      id: `a-${index}`,
      indice: index + 1,
      idOrigen: asset.idOrigen,
      codigo: asset.codigo,
      descripcion: asset.descripcion,
      campos: {
        cantidad: String(index + 1),
        documento: `FV-${index}`,
        centro: asset.centro,
        fechaCompra: '2019-03-10',
        precioCompra: asset.precio,
        estado: asset.estado,
        observaciones: `Observación ${index}`,
      },
    }));
  return {
    formato: { codigo: 'OCI-17-90', version: '1', fechaVigencia: '2024-08-06' },
    documento: { numero: '00020', fecha: '27 DE OCTUBRE DE 2026' },
    firmantes: [
      signer(1, 'CONTROL_INTERNO', 'Control Interno', 'SARITA LUCIA MONTOYA', 'Auditora interna'),
      signer(2, 'CONTABILIDAD', 'Contabilidad', 'CAMILA ROJAS PEREZ', 'Contadora'),
    ],
    activos,
    totalElementos: activos.length,
    campos: {
      totalInforme: '$ 1.300.000,00',
      totalAutorizado: '$ 1.200.000,00',
      diferencia: '-$ 100.000,00',
      nota: withNote ? 'Valores del informe contable de septiembre' : '',
      acuerdoConsejo: 'ACUERDO 041-2026',
      fechaAcuerdo: '5 DE MAYO DE 2026',
      informesVicefinanciera: 'IBV - 00020',
    },
    ...(substitution
      ? {
          tablas: {
            sustituciones: [
              { rol: 'Control Interno', sustituto: 'SARITA LUCIA MONTOYA', sustituido: 'CAMILA ROJAS PEREZ', conflicto: 'Contabilidad', motivo: 'Es la misma persona' },
            ],
          },
        }
      : {}),
  };
};

describe('Plantilla OCI-17-90-BAJA (baja de activos, construida desde el Excel institucional)', () => {
  const template = readFileSync(TEMPLATE);

  it.runIf(existsSync(XLSX))('el constructor reproduce la plantilla versionada desde el Excel institucional', async () => {
    const rebuilt = await build(readFileSync(BASE), readFileSync(XLSX));
    expect([...readDocxPlaceholders(rebuilt.output)].sort()).toEqual([...readDocxPlaceholders(template)].sort());
  });

  it('no deja nada del ejemplo', () => {
    expect(findLeftovers(template, SAMPLE, { metadata: true })).toEqual([]);
    expect(() => assertTemplateClean(template, SAMPLE, { metadata: true })).not.toThrow();
  });

  it('tiene exactamente los marcadores del contrato', () => {
    const tags = [...new Set(paragraphs(template).join('\n').match(/\{\{[^}]*\}\}/g) ?? [])].map((tag) => tag.slice(2, -2).trim()).sort();
    expect(tags).toEqual([...EXPECTED_TAGS].sort());
  });

  it('conserva los textos del formato oficial', () => {
    const text = paragraphs(template).join('\n');
    for (const fragment of [
      'BAJA DE ACTIVOS',
      'Fecha de la Baja Activos Fijos:',
      'Código de barras',
      'Descripción del activo',
      'Cantidad',
      'Documento',
      'Centro',
      'Fecha Compra',
      'Precio compra',
      'Estado',
      'Observaciones',
      'Total Informe Baja:',
      'Total Autorizado Baja:',
      'Diferencia',
      'REVISAN:',
      'VOTO CONSEJO UNIVERSITARIO:',
      'INFORMES DE VICEFINANCIERA',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
    expect(text).not.toContain('Serial');
    expect(text).not.toContain('Valor en libros');
  });

  for (const [count, withNote, substitution] of [
    [1, false, false],
    [2, true, true],
  ] as const) {
    it(`renderiza con ${count} activo(s)${withNote ? ', nota' : ''}${substitution ? ' y una sustitución' : ''} con las firmas en el orden del formato`, () => {
      const output = renderDocx(template, context(count, withNote, substitution));
      const lines = paragraphs(output);
      const text = lines.join('\n');
      expect(text).not.toContain('{{');
      expect(findLeftovers(output, SAMPLE, { metadata: true })).toEqual([]);
      for (const fragment of [
        'Código: OCI-17-90',
        '00020',
        '27 DE OCTUBRE DE 2026',
        '41001',
        '50011',
        'VIDEOBEAM EPSON X41',
        'FV-0',
        '7100 BIBLIOTECA CENTRAL',
        '$ 900.000,00',
        'Obsoleto',
        'Observación 0',
        '$ 1.300.000,00',
        '$ 1.200.000,00',
        '-$ 100.000,00',
        'ACUERDO 041-2026',
        '5 DE MAYO DE 2026',
        'IBV - 00020',
      ]) {
        expect(text, fragment).toContain(fragment);
      }
      expect(text.includes('7200 LABORATORIO DE FISICA')).toBe(count === 2);
      expect(text.includes('Valores del informe contable de septiembre')).toBe(withNote);
      expect(text.includes('Nota:')).toBe(withNote);
      expect(lines.indexOf('SARITA LUCIA MONTOYA')).toBeGreaterThan(-1);
      expect(lines.indexOf('SARITA LUCIA MONTOYA')).toBeLessThan(lines.indexOf('CAMILA ROJAS PEREZ'));
      expect(text.includes('Sustitución de firmante')).toBe(substitution);
    });
  }
});
