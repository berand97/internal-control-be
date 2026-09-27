import { deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../../common/constants/error-code.enum.js';
import { readWorkbook } from '../../../modules/staging/excel/read-workbook.js';
import { assertZipWithinLimits, ZIP_LIMITS } from './zip-limits.js';

interface Entry {
  readonly name: string;
  readonly data: Buffer;
  /** Tamaño descomprimido que se declara (por defecto, el real). */
  readonly declared?: number;
  readonly store?: boolean;
}

/** ZIP mínimo (sin CRC: el guardián no lo mira) para fabricar casos que ninguna librería escribiría. */
const zip = (entries: ReadonlyArray<Entry>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.store ? entry.data : deflateRawSync(entry.data);
    const declared = entry.declared ?? entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(entry.store ? 0 : 8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.store ? 0 : 8, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
};

const MIB = 1024 * 1024;

describe('assertZipWithinLimits', () => {
  it('deja pasar un ZIP normal', () => {
    expect(() =>
      assertZipWithinLimits(zip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>'.repeat(1000)) }]), ZIP_LIMITS.XLSX),
    ).not.toThrow();
  });

  it('rechaza un deflate bomb honesto: 65 MiB de ceros declarados (unos 64 KiB comprimidos)', () => {
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(65 * MIB) }]);
    expect(bomb.length).toBeLessThan(MIB);
    expect(() => assertZipWithinLimits(bomb, ZIP_LIMITS.XLSX)).toThrow(
      expect.objectContaining({ code: ErrorCode.ArchiveTooLarge }),
    );
  });

  it('rechaza un deflate bomb que miente en el directorio central, sin descomprimirlo entero', () => {
    const liar = zip([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(80 * MIB), declared: 1024 }]);
    const started = Date.now();
    expect(() => assertZipWithinLimits(liar, ZIP_LIMITS.XLSX)).toThrow(
      expect.objectContaining({ code: ErrorCode.ArchiveTooLarge }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rechaza demasiadas entradas', () => {
    const many = zip(Array.from({ length: 1001 }, (_, index) => ({ name: `f${index}`, data: Buffer.from('x') })));
    expect(() => assertZipWithinLimits(many, ZIP_LIMITS.XLSX)).toThrow(
      expect.objectContaining({ code: ErrorCode.ArchiveTooLarge }),
    );
  });

  it('rechaza un ZIP con desplazamientos fuera del búfer', () => {
    const broken = zip([{ name: 'a', data: Buffer.from('hola') }]);
    broken.writeUInt32LE(0x7fffffff, broken.length - 6);
    expect(() => assertZipWithinLimits(broken, ZIP_LIMITS.XLSX)).toThrow(
      expect.objectContaining({ code: ErrorCode.FileTypeNotAllowed }),
    );
  });

  it('no toca un búfer que no es ZIP (lo rechaza la librería, como antes)', () => {
    expect(() => assertZipWithinLimits(Buffer.from('external_code,name\n1,a\n'), ZIP_LIMITS.XLSX)).not.toThrow();
  });
});

describe('readWorkbook con topes (BE-05)', () => {
  it('una sola celda en la fila 1.048.576 responde error de validación en menos de 1 s', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Bomba').getCell('A1048576').value = 'x';
    const content = Buffer.from(await workbook.xlsx.writeBuffer());
    const started = Date.now();
    await expect(readWorkbook(content)).rejects.toMatchObject({ code: ErrorCode.ArchiveTooLarge });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('un libro normal se sigue leyendo con sus filas vacías intermedias', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Activos');
    sheet.getCell('A1').value = 'Código';
    sheet.getCell('A3').value = 'ACT-1';
    const sheets = await readWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(sheets[0]?.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3]);
  });
});
