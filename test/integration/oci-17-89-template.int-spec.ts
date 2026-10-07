// Plantilla OCI-17-89 (Traslado de activos).
//
// El formato institucional solo existe en Excel (docs/acta de traslado de activos fijos mdf.xlsx); la plantilla Word
// se arma con sus textos sobre el paquete limpio de OCI-01-65-v2.docx:
//   node scripts/formats/build-oci-17-89-template.mjs templates/formats/OCI-01-65-v2.docx "docs/acta de traslado de activos fijos mdf.xlsx" templates/formats/OCI-17-89-v1.docx
// y se carga al motor como plantilla del formato (POST /documents/formats/OCI-17-89/templates, sgcVersion=1).
// No usa Gotenberg: renderiza el DOCX con el renderizador real del repo.
import { existsSync, readFileSync } from 'node:fs';
import PizZip from 'pizzip';
import { readDocxPlaceholders, renderDocx } from '../../src/modules/document-templates/domain/docx-template.js';
import { build, SAMPLE } from '../../scripts/formats/build-oci-17-89-template.mjs';
import { assertTemplateClean, findLeftovers } from '../../scripts/formats/template-leftovers.mjs';

const TEMPLATE = 'templates/formats/OCI-17-89-v1.docx';
const BASE = 'templates/formats/OCI-01-65-v2.docx';
const XLSX = 'docs/acta de traslado de activos fijos mdf.xlsx';

const EXPECTED_TAGS = [
  '#activos',
  '/activos',
  '#tablas.sustituciones',
  '/tablas.sustituciones',
  'campos.centro',
  'campos.centroDestino',
  'campos.centroOrigen',
  'campos.estado',
  'campos.fechaCompra',
  'campos.fisico',
  'campos.modelo',
  'campos.motivo',
  'campos.numeracion',
  'campos.numeroDocumento',
  'campos.observaciones',
  'campos.precioCompra',
  'campos.serie',
  'campos.traslado',
  'codigo',
  'conflicto',
  'descripcion',
  'documento.fecha',
  'documento.numero',
  'firmante.contabilidad.cargo',
  'firmante.contabilidad.nombre',
  'firmante.control_interno.cargo',
  'firmante.control_interno.nombre',
  'firmante.entrega.nombre',
  'firmante.recibe.nombre',
  'formato.codigo',
  'formato.fechaVigencia',
  'formato.version',
  'idOrigen',
  'indice',
  'motivo',
  'rol',
  'sustituido',
  'sustituto',
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

const signer = (rol: string, nombre: string, cargo: string) => ({ nombre, tipoDocumento: 'C.C.', documento: '1', cargo, rol });

const context = (count: number, substitution: boolean): Record<string, unknown> => {
  const activos = [
    { id: 'a-1', idOrigen: '41001', codigo: '50011', descripcion: 'VIDEOBEAM EPSON X41' },
    { id: 'a-2', idOrigen: '41002', codigo: '50012', descripcion: 'TABLERO ACRILICO MOVIL' },
  ]
    .slice(0, count)
    .map((asset, index) => ({
      ...asset,
      indice: index + 1,
      unidades: 1,
      observacion: '',
      estado: 'Bueno',
      campos: {
        modelo: `MOD-${index}`,
        numeroDocumento: `FV-${index}`,
        serie: `SER-${index}`,
        centro: '7100 BIBLIOTECA CENTRAL',
        fechaCompra: '2021-05-10',
        precioCompra: '$ 1.500.000,00',
        fisico: 'Sí',
        estado: 'Bueno',
        numeracion: index === 0 ? 'Sí' : 'No',
        observaciones: `Observación ${index}`,
        motivo: 'Reubicación',
        traslado: '7200 LABORATORIO DE FISICA',
      },
    }));
  return {
    formato: { codigo: 'OCI-17-89', clave: 'OCI-17-89', nombre: 'Acta de traslado de activos fijos', version: '1', fechaVigencia: '2024-08-06' },
    documento: { numero: '00144', fecha: '28 DE SEPTIEMBRE DE 2026', fechaIso: '2026-09-28' },
    centroCosto: { codigo: '7100', nombre: 'BIBLIOTECA CENTRAL', unidad: { codigo: '', nombre: '' } },
    firmante: {
      entrega: signer('ENTREGA', 'GLORIA ESTELA BUITRAGO', 'Jefe biblioteca'),
      recibe: signer('RECIBE', 'JULIAN ANDRES OSORIO', 'Coordinador laboratorio'),
      control_interno: {
        ...signer('CONTROL_INTERNO', 'SARITA LUCIA MONTOYA', 'Auditora interna'),
        ...(substitution ? { sustitucion: { nombre: 'JULIAN ANDRES OSORIO', rol: 'Control Interno', motivo: 'Recibe los activos' } } : {}),
      },
      contabilidad: signer('CONTABILIDAD', 'CAMILA ROJAS PEREZ', 'Contadora'),
    },
    activos,
    totalElementos: activos.length,
    campos: { centroOrigen: '7100 BIBLIOTECA CENTRAL', centroDestino: '7200 LABORATORIO DE FISICA' },
    ...(substitution
      ? {
          tablas: {
            sustituciones: [
              { rol: 'Control Interno', sustituto: 'SARITA LUCIA MONTOYA', sustituido: 'JULIAN ANDRES OSORIO', conflicto: 'Recibe', motivo: 'Recibe los activos' },
            ],
          },
        }
      : {}),
  };
};

describe('Plantilla OCI-17-89 (traslado de activos, construida desde el Excel institucional)', () => {
  const template = readFileSync(TEMPLATE);

  it.runIf(existsSync(XLSX))('el constructor reproduce la plantilla versionada (mismos marcadores) desde el Excel institucional', async () => {
    const rebuilt = await build(readFileSync(BASE), readFileSync(XLSX));
    expect([...readDocxPlaceholders(rebuilt.output)].sort()).toEqual([...readDocxPlaceholders(template)].sort());
  });

  it('la plantilla versionada no deja nada del ejemplo', () => {
    expect(findLeftovers(template, SAMPLE, { metadata: true })).toEqual([]);
    expect(() => assertTemplateClean(template, SAMPLE, { metadata: true })).not.toThrow();
  });

  it('tiene exactamente los marcadores del contrato', () => {
    const tags = [...new Set(paragraphs(template).join('\n').match(/\{\{[^}]*\}\}/g) ?? [])].map((tag) => tag.slice(2, -2).trim()).sort();
    expect(tags).toEqual([...EXPECTED_TAGS].sort());
  });

  it('conserva los textos del formato: título, encabezados de la tabla, bloque de firmas y cláusula', () => {
    const text = paragraphs(template).join('\n');
    for (const fragment of [
      'CONTROL INTERNO',
      'TRASLADO DE ACTIVOS',
      'Fecha traslado',
      'Centro que entrega:',
      'Centro que recibe:',
      'Código de barras',
      'Descripción del activo',
      'Precio compra',
      'Numeración',
      'Razón',
      'Traslado',
      'Firma encargado (a)',
      'REVISAN:',
      'CONTABILIDAD',
      'CLÁUSULA DE COMPROMISO',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  for (const [count, substitution] of [
    [1, false],
    [2, true],
  ] as const) {
    it(`renderiza con ${count} activo(s)${substitution ? ' y una sustitución de firmante' : ''}, sin marcadores ni restos`, () => {
      const output = renderDocx(template, context(count, substitution));
      const text = paragraphs(output).join('\n');
      expect(text).not.toContain('{{');
      expect(findLeftovers(output, SAMPLE, { metadata: true })).toEqual([]);
      expect(text).toContain('00144');
      expect(text).toContain('28 DE SEPTIEMBRE DE 2026');
      expect(text).toContain('7100 BIBLIOTECA CENTRAL');
      expect(text).toContain('7200 LABORATORIO DE FISICA');
      expect(text).toContain('Código: OCI-17-89');
      for (const name of ['GLORIA ESTELA BUITRAGO', 'JULIAN ANDRES OSORIO', 'SARITA LUCIA MONTOYA', 'CAMILA ROJAS PEREZ']) {
        expect(text).toContain(name);
      }
      expect(text).toContain('VIDEOBEAM EPSON X41');
      expect(text.includes('TABLERO ACRILICO MOVIL')).toBe(count === 2);
      expect(text).toContain('Reubicación');
      if (substitution) {
        expect(text).toContain('firma por Control Interno SARITA LUCIA MONTOYA en lugar de JULIAN ANDRES OSORIO, que firma el acta como Recibe. Motivo: Recibe los activos');
      } else {
        expect(text).not.toContain('Sustitución de firmante');
      }
    });
  }
});
