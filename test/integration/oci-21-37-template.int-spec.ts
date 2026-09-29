// Plantilla OCI-21-37 (Acta de toma física de inventario de activos fijos).
//
// El formato institucional solo existe en Excel (docs/acta de toma física de inventario de activos fijos mdf.xlsx); la
// plantilla Word se arma con sus textos sobre el paquete limpio de OCI-01-65-v2.docx:
//   node scripts/formats/build-oci-21-37-template.mjs templates/formats/OCI-01-65-v2.docx "docs/acta de toma física de inventario de activos fijos mdf.xlsx" templates/formats/OCI-21-37-v2.docx
// y se carga al motor como plantilla del formato (POST /documents/formats/OCI-21-37/templates, sgcVersion=2).
// Renderiza el DOCX con el renderizador real del repo y el contenido real del acta (buildInventoryActContent). Con
// GOTENBERG_URL, además lo convierte a PDF y revisa la capa de texto.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import PizZip from 'pizzip';
import { PhysicalCondition } from '../../src/modules/assets/enums/physical-condition.enum.js';
import {
  readDocxPlaceholders,
  renderDocx,
} from '../../src/modules/document-templates/domain/docx-template.js';
import { CONDITION_LABELS } from '../../src/modules/documents/services/document-engine.service.js';
import {
  buildInventoryActContent,
  formatMoney,
  type ActCategory,
  type ActItem,
} from '../../src/modules/inventories/domain/inventory-act.js';
import type { AssetValuation } from '../../src/modules/inventories/domain/inventory-valuation.js';
import { VerificationResult } from '../../src/modules/inventories/enums/verification-result.js';
import {
  build,
  SAMPLE,
} from '../../scripts/formats/build-oci-21-37-template.mjs';
import {
  assertTemplateClean,
  findLeftovers,
} from '../../scripts/formats/template-leftovers.mjs';
import { pdfText, sampleLeftovers, squash } from './pdf-text.js';

const TEMPLATE = 'templates/formats/OCI-21-37-v2.docx';
const BASE = 'templates/formats/OCI-01-65-v2.docx';
// El nombre del Excel lleva tilde: se busca por su forma normalizada (el disco puede guardarlo en NFD).
const XLSX = join(
  'docs',
  readdirSync('docs').find(
    (name) =>
      name.normalize('NFC') ===
      'acta de toma física de inventario de activos fijos mdf.xlsx',
  ) ?? 'no-existe.xlsx',
);
const GOTENBERG = process.env['GOTENBERG_URL'];
const OUTPUT = process.env['OCI_21_37_OUTPUT_DIR'];

const EXPECTED_TAGS = [
  '#activos',
  '/activos',
  '#esTotal',
  '/esTotal',
  '^esTotal',
  '#tablas.hallazgos',
  '/tablas.hallazgos',
  '#tablas.sobrantes',
  '/tablas.sobrantes',
  '#tablas.sobrantes.length',
  '/tablas.sobrantes.length',
  '#tablas.sustituciones',
  '/tablas.sustituciones',
  'activoCreado',
  'campos.alcance',
  'campos.categoriaCodigo',
  'campos.causa',
  'campos.codigoTemporal',
  'campos.condicionObservada',
  'campos.corteContable',
  'campos.fechaCierre',
  'campos.fechaInicio',
  'campos.porcentajeVerificado',
  'campos.resultado',
  'campos.tomaCodigo',
  'campos.tomaNombre',
  'campos.totalEncontrados',
  'campos.totalEsperados',
  'campos.totalFaltantes',
  'campos.totalNoVerificados',
  'campos.totalOtraUbicacion',
  'campos.totalSinCategoria',
  'campos.totalSobrantes',
  'campos.totalVerificados',
  'campos.valorCompra',
  'campos.valorLibros',
  'cantidad',
  'centroCosto.codigo',
  'centroCosto.nombre',
  'codigo',
  'condicion',
  'conflicto',
  'descripcion',
  'documento.fecha',
  'documento.numero',
  'firmante.audita.cargo',
  'firmante.audita.nombre',
  'firmante.responsable.cargo',
  'firmante.responsable.nombre',
  'formato.codigo',
  'formato.fechaVigencia',
  'formato.version',
  'idOrigen',
  'indice',
  'motivo',
  'motivoResolucion',
  'nombre',
  'observacion',
  'porcentaje',
  'resolucion',
  'rol',
  'sustituido',
  'sustituto',
  'totalElementos',
  'ubicacion',
  'valorCompra',
  'valorLibros',
];

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

const paragraphs = (docx: Buffer): string[] => {
  const zip = new PizZip(docx);
  return Object.keys(zip.files)
    .filter((name) => PARTS.test(name))
    .flatMap((name) =>
      [
        ...(zip.file(name)?.asText() ?? '').matchAll(
          /<w:p[ >][\s\S]*?<\/w:p>/g,
        ),
      ].map((match) =>
        [
          ...match[0]
            .replace(/<w:pPr>[\s\S]*?<\/w:pPr>/g, '')
            .matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g),
        ]
          .map((item) => item[1] ?? '\t')
          .join('')
          .replaceAll('&amp;', '&')
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>'),
      ),
    );
};

const CATEGORIES: ActCategory[] = [
  { code: 'AU', label: 'En uso' },
  { code: 'ANE', label: 'No encontrado' },
  { code: 'AOD', label: 'Obsoleto o dañado' },
];

const item = (
  id: string,
  result: VerificationResult,
  category: string | null,
  extra: Partial<ActItem> = {},
): ActItem => ({
  id,
  assetId: `asset-${id}`,
  result,
  actualCondition:
    result === VerificationResult.Found ? PhysicalCondition.Good : null,
  expectedCodeTemporary: false,
  findingCategoryCode: category,
  missingCauseId: null,
  missingCauseOther: null,
  notes: null,
  voided: false,
  actualLocationName: null,
  resolvedAssetId: null,
  resolvedAssetCode: null,
  surplusResolution: null,
  surplusResolutionReason: null,
  ...extra,
});

const valuation = (
  price: number | null,
  book: number | null,
): AssetValuation => ({
  acquisitionPrice: price,
  priceIsZero: price === 0,
  bookValue: book,
  bookValueSource: book === null ? null : 'DEPRECIATION',
});

const ASSETS = [
  {
    idOrigen: '41001',
    codigo: 'A2026-000101',
    descripcion: 'VIDEOBEAM EPSON X41',
  },
  {
    idOrigen: 'A2026-000102',
    codigo: 'A2026-000102',
    descripcion: 'TABLERO ACRILICO MOVIL 120 X 240 CON SOPORTE',
  },
  { idOrigen: '41003', codigo: '50013', descripcion: 'SILLA INTERLOCUTORA' },
  { idOrigen: '41004', codigo: '50014', descripcion: 'IMPRESORA LASER' },
];

const context = (options: {
  categories: ActCategory[];
  surplus: boolean;
  substitution: boolean;
}): Record<string, unknown> => {
  const items = [
    item('1', VerificationResult.Found, 'AU', {
      notes: 'Etiqueta deteriorada',
    }),
    item('2', VerificationResult.Found, 'AU', { expectedCodeTemporary: true }),
    item('3', VerificationResult.Missing, 'ANE', {
      missingCauseOther: 'Se desconoce su paradero',
    }),
    item('4', VerificationResult.NotVerified, null),
    ...(options.surplus
      ? [
          item('5', VerificationResult.Surplus, null, {
            assetId: null,
            notes: 'Mesa auxiliar sin placa',
            actualLocationName: 'Oficina 101',
            actualCondition: PhysicalCondition.Fair,
            surplusResolution: 'LEAVE_UNRESOLVED',
            surplusResolutionReason: 'Se espera la factura',
          }),
        ]
      : []),
  ];
  const content = buildInventoryActContent({
    code: 'TF-2026-014',
    name: 'Toma anual Biblioteca',
    scopeLabel: 'Centro de costo 7100 — BIBLIOTECA CENTRAL',
    plannedStartDate: '2026-09-01',
    plannedEndDate: '2026-09-05',
    actualStartDate: '2026-09-02',
    actualEndDate: '2026-09-04',
    approvedAt: new Date('2026-09-10T15:00:00Z'),
    basis: {
      kind: 'SYSTEM_SNAPSHOT',
      cutId: null,
      cutDate: null,
      sourceLabel: null,
      snapshotAt: new Date('2026-09-02T13:00:00Z'),
      snapshotDate: '2026-09-02',
      valuationDate: '2026-09-02',
    },
    items,
    categories: options.categories,
    causeLabels: new Map(),
    valuations: new Map([
      ['asset-1', valuation(1_500_000, 900_000)],
      ['asset-2', valuation(820_000, 410_000)],
      ['asset-3', valuation(2_350_000, null)],
      ['asset-4', valuation(95_000, 0)],
    ]),
    conditionLabels: CONDITION_LABELS,
  });
  const signer = (rol: string, nombre: string, cargo: string) => ({
    nombre,
    tipoDocumento: 'C.C.',
    documento: '1',
    cargo,
    rol,
  });
  const byId = new Map(
    ASSETS.map((asset, index) => [`asset-${index + 1}`, asset]),
  );
  return {
    formato: {
      codigo: 'OCI-21-37',
      clave: 'OCI-21-37',
      nombre: 'Acta de toma física de inventario de activos fijos',
      version: '2',
      fechaVigencia: '2026-09-08',
    },
    documento: {
      numero: '00006',
      fecha: '10 DE SEPTIEMBRE DE 2026',
      fechaIso: '2026-09-10',
    },
    centroCosto: {
      codigo: '7100',
      nombre: 'BIBLIOTECA CENTRAL',
      unidad: { codigo: '', nombre: '' },
    },
    firmante: {
      responsable: signer(
        'RESPONSABLE',
        'GLORIA ESTELA BUITRAGO',
        'Jefe biblioteca',
      ),
      audita: {
        ...signer('AUDITA', 'SARITA LUCIA MONTOYA', 'Auditora interna'),
        ...(options.substitution
          ? {
              sustitucion: {
                nombre: 'GLORIA ESTELA BUITRAGO',
                rol: 'Control Interno',
                motivo: 'Aprobó la conciliación',
              },
            }
          : {}),
      },
    },
    activos: content.assetIds.map((id, index) => ({
      indice: index + 1,
      id,
      ...byId.get(id),
      unidades: 1,
      observacion: content.assetNotes[id] ?? '',
      estado: 'Bueno',
      campos: content.assetFields[id] ?? {},
    })),
    totalElementos: content.assetIds.length,
    campos: content.fields,
    tablas: {
      ...content.tables,
      ...(options.substitution
        ? {
            sustituciones: [
              {
                rol: 'Control Interno',
                sustituto: 'SARITA LUCIA MONTOYA',
                sustituido: 'GLORIA ESTELA BUITRAGO',
                conflicto: 'Responsable',
                motivo: 'Aprobó la conciliación',
              },
            ],
          }
        : {}),
    },
  };
};

describe('Plantilla OCI-21-37 (acta de toma física, construida desde el Excel institucional)', () => {
  const template = readFileSync(TEMPLATE);

  it('el constructor reproduce la plantilla versionada (mismos marcadores) y no deja nada del ejemplo', async () => {
    const rebuilt = await build(readFileSync(BASE), readFileSync(XLSX));
    expect([...readDocxPlaceholders(rebuilt.output)].sort()).toEqual(
      [...readDocxPlaceholders(template)].sort(),
    );
    expect(findLeftovers(template, SAMPLE, { metadata: true })).toEqual([]);
    expect(() =>
      assertTemplateClean(template, SAMPLE, { metadata: true }),
    ).not.toThrow();
  });

  it('tiene exactamente los marcadores del contrato', () => {
    const tags = [
      ...new Set(
        paragraphs(template)
          .join('\n')
          .match(/\{\{[^}]*\}\}/g) ?? [],
      ),
    ]
      .map((tag) => tag.slice(2, -2).trim())
      .sort();
    expect(tags).toEqual([...EXPECTED_TAGS].sort());
  });

  it('no fija categorías: ninguna sigla ni rótulo de categoría es texto de la plantilla', () => {
    const text = paragraphs(template)
      .join('\n')
      .replace(/\{\{[^}]*\}\}/g, ' ');
    for (const fragment of [
      'AU',
      'ANE',
      'AOD',
      'ANI',
      'Activos en uso',
      'Activos no encontrados',
      'obsoletos',
    ]) {
      expect(text, fragment).not.toMatch(new RegExp(`\\b${fragment}\\b`));
    }
  });

  it('conserva los textos del formato: título, encabezado, resumen de hallazgos, firmas y columnas del detalle', () => {
    const text = paragraphs(template).join('\n');
    for (const fragment of [
      'CONTROL INTERNO',
      'ACTA DE TOMA FISICA DE INVENTARIO DE ACTIVOS FIJOS',
      'Informe de Hallazgos No.',
      'Centro de Costos',
      'Fecha Toma física',
      'Fecha de corte de base de datos',
      'Responsable',
      'Total de activos en base de datos',
      'Hallazgo',
      '# de bienes',
      'Precio de compra',
      'Porcentaje',
      'Valor en libros',
      'ENCARGADO:',
      'REVISA:',
      'Código de barras',
      'Descripción del activo',
      'Precio compra',
      'Observaciones',
    ]) {
      expect(text, fragment).toContain(fragment);
    }
  });

  for (const options of [
    { categories: CATEGORIES, surplus: false, substitution: false },
    {
      categories: [
        ...CATEGORIES,
        { code: 'XYZ', label: 'Categoría configurada después' },
      ],
      surplus: true,
      substitution: false,
    },
    {
      categories: [
        ...CATEGORIES,
        { code: 'XYZ', label: 'Categoría configurada después' },
      ],
      surplus: true,
      substitution: true,
    },
  ]) {
    it(`renderiza con ${options.categories.length} categorías${options.surplus ? ', un sobrante' : ''}${options.substitution ? ' y una sustitución' : ''}, sin marcadores ni restos`, async () => {
      const output = renderDocx(template, context(options));
      const text = paragraphs(output).join('\n');
      expect(text).not.toContain('{{');
      expect(findLeftovers(output, SAMPLE, { metadata: true })).toEqual([]);
      for (const fragment of [
        '00006',
        'TF-2026-014',
        '7100',
        'BIBLIOTECA CENTRAL',
        'Código: OCI-21-37',
        'GLORIA ESTELA BUITRAGO',
        'SARITA LUCIA MONTOYA',
      ]) {
        expect(text, fragment).toContain(fragment);
      }
      expect(text).toContain(
        'Del 2 de septiembre de 2026 al 4 de septiembre de 2026',
      );
      expect(text).toContain(
        'Sin corte contable: estado del sistema al 2 de septiembre de 2026',
      );
      // Una fila por categoría configurada, en su orden, y la fila Total.
      for (const category of options.categories) {
        expect(text).toContain(`${category.code} — ${category.label}`);
      }
      expect(text).toContain(
        `AU — En uso\n2\n${formatMoney(2_320_000)}\n66,67 %\n${formatMoney(1_310_000)}`,
      );
      // Valor en libros desconocido: «Sin dato», nunca 0.
      expect(text).toContain(
        `ANE — No encontrado\n1\n${formatMoney(2_350_000)}\n33,33 %\nSin dato`,
      );
      expect(text).toContain(
        `Total\n3\n${formatMoney(4_670_000)}\n100,00 %\nSin dato`,
      );
      expect(text).toContain('VIDEOBEAM EPSON X41');
      expect(text).toContain('Se desconoce su paradero');
      expect(text).toContain('Etiqueta deteriorada');
      expect(text.includes('ANEXO 2. Sobrantes sin activo registrado')).toBe(
        options.surplus,
      );
      expect(text.includes('Mesa auxiliar sin placa')).toBe(options.surplus);
      if (options.substitution) {
        expect(text).toContain(
          'firma por Control Interno SARITA LUCIA MONTOYA en lugar de GLORIA ESTELA BUITRAGO, que firma el acta como Responsable. Motivo: Aprobó la conciliación',
        );
      } else {
        expect(text).not.toContain('Sustitución de firmante');
      }

      if (GOTENBERG) {
        const form = new FormData();
        form.append('files', new Blob([new Uint8Array(output)]), 'acta.docx');
        const response = await fetch(
          `${GOTENBERG.replace(/\/$/, '')}/forms/libreoffice/convert`,
          { method: 'POST', body: form },
        );
        expect(response.status).toBe(200);
        const pdf = Buffer.from(await response.arrayBuffer());
        const pdfLayer = squash(await pdfText(pdf));
        expect(sampleLeftovers(pdfLayer, SAMPLE, { numbers: true })).toEqual(
          [],
        );
        expect(pdfLayer).toContain(
          'ANEXO 1. Detalle de los activos de la toma',
        );
        if (OUTPUT) {
          mkdirSync(OUTPUT, { recursive: true });
          const name = `muestra-${options.categories.length}-categorias${options.substitution ? '-sustitucion' : ''}`;
          writeFileSync(join(OUTPUT, `${name}.docx`), output);
          writeFileSync(join(OUTPUT, `${name}.pdf`), pdf);
          writeFileSync(join(OUTPUT, `${name}.txt`), pdfLayer);
        }
      }
    });
  }

  it.runIf(Boolean(GOTENBERG))(
    'con 60 activos el anexo ocupa varias páginas, repite el encabezado de la tabla y no parte filas',
    async () => {
      const base = context({
        categories: CATEGORIES,
        surplus: false,
        substitution: false,
      });
      const [first] = base['activos'] as Array<Record<string, unknown>>;
      const many = Array.from({ length: 60 }, (_, index) => ({
        ...first,
        indice: index + 1,
        id: `asset-many-${index}`,
        idOrigen: `A2026-${String(index + 200).padStart(6, '0')}`,
        codigo: `A2026-${String(index + 200).padStart(6, '0')}`,
        descripcion: `ESCRITORIO MODULAR NUMERO ${index + 1} CON CAJONERA Y PORTATECLADO`,
      }));
      const output = renderDocx(template, {
        ...base,
        activos: many,
        totalElementos: many.length,
      });
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(output)]), 'acta.docx');
      const response = await fetch(
        `${(GOTENBERG ?? '').replace(/\/$/, '')}/forms/libreoffice/convert`,
        { method: 'POST', body: form },
      );
      expect(response.status).toBe(200);
      const pdf = Buffer.from(await response.arrayBuffer());
      const pages = (await PDFDocument.load(pdf)).getPageCount();
      const layer = await pdfText(pdf);
      if (OUTPUT) {
        mkdirSync(OUTPUT, { recursive: true });
        writeFileSync(join(OUTPUT, 'muestra-60-activos.pdf'), pdf);
        writeFileSync(join(OUTPUT, 'muestra-60-activos.txt'), layer);
      }
      // El anexo ocupa varias páginas y su encabezado se repite en cada una (fila de encabezado de tabla).
      expect(pages).toBeGreaterThanOrEqual(3);
      expect((layer.match(/Descripción del activo/g) ?? []).length).toBe(
        pages - 1,
      );
      // Ni el # ni el código se parten: cada fila empieza con su número y su código enteros.
      const rows = squash(layer);
      for (let index = 0; index < 60; index += 1) {
        expect(rows).toMatch(
          new RegExp(
            `(?<!\\d)${index + 1}\\s?A2026-${String(index + 200).padStart(6, '0')}`,
          ),
        );
      }
    },
  );
});
