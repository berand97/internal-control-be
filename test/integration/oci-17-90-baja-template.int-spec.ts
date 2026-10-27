import { readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { readDocxPlaceholders, renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
import { build, SAMPLE } from '../../scripts/formats/build-oci-17-90-baja-template.mjs';
import { assertTemplateClean, findLeftovers } from '../../scripts/formats/template-leftovers.mjs';

const TEMPLATE = 'templates/formats/OCI-17-90-BAJA-v1.docx';
const BASE = 'templates/formats/OCI-01-65-v2.docx';

const EXPECTED_TAGS = [
  '#activos',
  '/activos',
  '#firmantes',
  '/firmantes',
  '#tablas.sustituciones',
  '/tablas.sustituciones',
  'campos.conceptoTecnico',
  'campos.costo',
  'campos.disposicionFinal',
  'campos.fechaAdquisicion',
  'campos.fechaValor',
  'campos.motivo',
  'campos.observaciones',
  'campos.serial',
  'campos.totalCosto',
  'campos.totalValorLibros',
  'campos.valorLibros',
  'cargo',
  'centroCosto.codigo',
  'centroCosto.nombre',
  'centroCosto.unidad.nombre',
  'codigo',
  'conflicto',
  'descripcion',
  'documento',
  'documento.fecha',
  'documento.numero',
  'estado',
  'etiqueta',
  'formato.codigo',
  'formato.fechaVigencia',
  'formato.version',
  'indice',
  'motivo',
  'nombre',
  'rol',
  'sustituido',
  'sustituto',
  'tipoDocumento',
  'totalElementos',
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

const context = (count: number, substitution: boolean): Record<string, unknown> => {
  const activos = [
    { id: 'a-1', codigo: '50011', descripcion: 'VIDEOBEAM EPSON X41', estado: 'Malo', serial: 'SER-1', valor: '$ 900.000,00' },
    { id: 'a-2', codigo: '50012', descripcion: 'TABLERO ACRILICO MOVIL', estado: 'Obsoleto', serial: '', valor: '$ 400.000,00 sin depreciación' },
  ]
    .slice(0, count)
    .map((asset, index) => ({
      id: asset.id,
      indice: index + 1,
      codigo: asset.codigo,
      descripcion: asset.descripcion,
      estado: asset.estado,
      campos: { serial: asset.serial, fechaAdquisicion: '2019-03-10', costo: '$ 1.500.000,00', valorLibros: asset.valor },
    }));
  return {
    formato: { codigo: 'OCI-17-90', version: '1', fechaVigencia: '2026-10-27' },
    documento: { numero: '00020', fecha: '27 DE OCTUBRE DE 2026' },
    centroCosto: { codigo: '7100', nombre: 'BIBLIOTECA CENTRAL', unidad: { codigo: 'BIB', nombre: 'Vicerrectoría Académica' } },
    firmantes: [
      signer(1, 'RESPONSABLE', 'Responsable', 'GLORIA ESTELA BUITRAGO', 'Jefe biblioteca'),
      signer(2, 'AUDITA', 'Control Interno', 'SARITA LUCIA MONTOYA', 'Auditora interna'),
    ],
    activos,
    totalElementos: activos.length,
    campos: {
      motivo: 'Daño irreparable',
      conceptoTecnico: 'Tarjeta principal quemada',
      disposicionFinal: 'Reciclaje certificado',
      observaciones: 'Sin observaciones',
      fechaValor: '2026-10-27',
      totalCosto: '$ 3.000.000,00',
      totalValorLibros: '$ 1.300.000,00',
    },
    ...(substitution
      ? {
          tablas: {
            sustituciones: [
              { rol: 'Control Interno', sustituto: 'SARITA LUCIA MONTOYA', sustituido: 'GLORIA ESTELA BUITRAGO', conflicto: 'Responsable', motivo: 'Es responsable' },
            ],
          },
        }
      : {}),
  };
};

describe('Plantilla OCI-17-90-BAJA (acta de baja, propuesta por desarrollo)', () => {
  const template = readFileSync(TEMPLATE);

  it('el constructor reproduce la plantilla versionada desde la base', () => {
    const rebuilt = build(readFileSync(BASE));
    expect([...readDocxPlaceholders(rebuilt.output)].sort()).toEqual([...readDocxPlaceholders(template)].sort());
  });

  it('no deja restos de la plantilla base', () => {
    expect(findLeftovers(template, SAMPLE, { metadata: true })).toEqual([]);
    expect(() => assertTemplateClean(template, SAMPLE, { metadata: true })).not.toThrow();
  });

  it('tiene exactamente los marcadores del contrato', () => {
    const tags = [...new Set(paragraphs(template).join('\n').match(/\{\{[^}]*\}\}/g) ?? [])].map((tag) => tag.slice(2, -2).trim()).sort();
    expect(tags).toEqual([...EXPECTED_TAGS].sort());
  });

  for (const [count, substitution] of [
    [1, false],
    [2, true],
  ] as const) {
    it(`renderiza con ${count} activo(s)${substitution ? ' y una sustitución' : ''} y las firmas en el orden del formato`, () => {
      const output = renderDocx(template, context(count, substitution));
      const lines = paragraphs(output);
      const text = lines.join('\n');
      expect(text).not.toContain('{{');
      expect(findLeftovers(output, SAMPLE, { metadata: true })).toEqual([]);
      for (const fragment of [
        'ACTA DE BAJA DE ACTIVOS FIJOS',
        'Código: OCI-17-90',
        '00020',
        '27 DE OCTUBRE DE 2026',
        '7100 BIBLIOTECA CENTRAL',
        'Vicerrectoría Académica',
        'Daño irreparable',
        'Tarjeta principal quemada',
        'Reciclaje certificado',
        'VIDEOBEAM EPSON X41',
        'SER-1',
        '$ 900.000,00',
        'Malo',
        '$ 3.000.000,00',
      ]) {
        expect(text, fragment).toContain(fragment);
      }
      expect(text.includes('$ 400.000,00 sin depreciación')).toBe(count === 2);
      expect(lines.indexOf('GLORIA ESTELA BUITRAGO')).toBeGreaterThan(-1);
      expect(lines.indexOf('GLORIA ESTELA BUITRAGO')).toBeLessThan(lines.indexOf('SARITA LUCIA MONTOYA'));
      expect(text.includes('Sustitución de firmante')).toBe(substitution);
    });
  }
});
