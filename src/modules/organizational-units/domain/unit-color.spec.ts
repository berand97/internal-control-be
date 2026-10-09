import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { CreateOrganizationalUnitDto } from '../dto/create-organizational-unit.dto.js';
import { UpdateOrganizationalUnitDto } from '../dto/update-organizational-unit.dto.js';
import { effectiveUnitColor, parseUnitColor, UNIT_COLOR_MESSAGE } from './unit-color.js';

const update = async (body: Record<string, unknown>) => {
  const dto = plainToInstance(UpdateOrganizationalUnitDto, body);
  return { dto, errors: await validate(dto) };
};

describe('color de la unidad', () => {
  it('DTO: #RRGGBB sin importar mayúsculas se guarda en minúsculas', async () => {
    const { dto, errors } = await update({ color: ' #DE9927 ' });
    expect(errors).toEqual([]);
    expect(dto.color).toBe('#de9927');
  });

  it('DTO: null o vacío quitan el color; omitido no lo toca', async () => {
    expect((await update({ color: null })).dto.color).toBeNull();
    expect((await update({ color: '' })).dto.color).toBeNull();
    const omitted = await update({ name: 'Contabilidad' });
    expect(omitted.errors).toEqual([]);
    expect(omitted.dto.color).toBeUndefined();
  });

  it('DTO: un color inválido da el mensaje en español llano', async () => {
    for (const color of ['DE9927', '#DE992', '#GG9927', 'rojo', 123]) {
      const { errors } = await update({ color });
      expect(errors.map((error) => error.property)).toEqual(['color']);
      expect(Object.values(errors[0]?.constraints ?? {})).toEqual([UNIT_COLOR_MESSAGE]);
    }
    const created = plainToInstance(CreateOrganizationalUnitDto, {
      code: 'VF',
      name: 'Vicerrectoría Financiera',
      type: 'VICERECTORATE',
      color: '#12345',
    });
    const errors = await validate(created);
    expect(errors.map((error) => error.property)).toEqual(['color']);
    expect(UNIT_COLOR_MESSAGE).toBe('El color debe tener el formato #RRGGBB, por ejemplo #DE9927');
  });

  it('Excel: acepta con o sin #, cualquier mayúscula; lo demás no es color', () => {
    expect(parseUnitColor('#DE9927')).toBe('#de9927');
    expect(parseUnitColor('de9927')).toBe('#de9927');
    expect(parseUnitColor('#de99')).toBeUndefined();
    expect(parseUnitColor('naranja')).toBeUndefined();
  });

  it('effectiveColor: el propio o el del ancestro más cercano; a prueba de ciclos', () => {
    const units = [
      { id: 'a', parentId: null, color: '#de9927' },
      { id: 'b', parentId: 'a', color: null },
      { id: 'c', parentId: 'b', color: '#29b1b2' },
      { id: 'd', parentId: 'c', color: null },
      { id: 'x', parentId: 'y', color: null },
      { id: 'y', parentId: 'x', color: null },
    ];
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const color = (id: string): string | null => {
      const unit = byId.get(id);
      return unit ? effectiveUnitColor(unit, byId) : 'missing';
    };
    expect(color('b')).toBe('#de9927');
    expect(color('d')).toBe('#29b1b2');
    expect(color('x')).toBeNull();
  });
});
