import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateOrganizationalUnitDto } from '../dto/create-organizational-unit.dto.js';
import { UpdateOrganizationalUnitDto } from '../dto/update-organizational-unit.dto.js';
import { parseUnitType, UNIT_TYPE_OPTIONS } from '../org-chart/org-chart.types.js';
import {
  COLLEGIATE_BODY_TYPES,
  isCollegiateBody,
  ORG_UNIT_TYPE_DESCRIPTION,
  ORG_UNIT_TYPE_LABELS,
  ORG_UNIT_TYPES,
  OrgUnitType,
} from './org-unit-type.enum.js';

describe('tipos de unidad (Estructura Orgánica, Acuerdo 008/2021)', () => {
  it('lista en el orden de la Estructura Orgánica, con sus etiquetas', () => {
    expect(ORG_UNIT_TYPES.map((type) => [type, ORG_UNIT_TYPE_LABELS[type]])).toEqual([
      ['DEPENDENCY', 'Dependencia'],
      ['RECTORATE', 'Rectoría'],
      ['VICERECTORATE', 'Vicerrectoría'],
      ['DIRECTION', 'Dirección'],
      ['FACULTY', 'Facultad'],
      ['DEPARTMENT', 'Departamento'],
      ['PROGRAM', 'Coordinación de programa'],
      ['OFFICE', 'Oficina'],
      ['CENTER', 'Centro'],
      ['COUNCIL', 'Consejo'],
      ['COMMITTEE', 'Comité'],
      ['COMMISSION', 'Comisión'],
    ]);
    expect(Object.values(OrgUnitType)).toHaveLength(ORG_UNIT_TYPES.length);
    expect(ORG_UNIT_TYPES).not.toContain('AREA');
    expect(ORG_UNIT_TYPES).not.toContain('OTHER');
  });

  it('cuerpos colegiados: Consejo, Comité y Comisión; nada más', () => {
    expect(COLLEGIATE_BODY_TYPES).toEqual([OrgUnitType.Council, OrgUnitType.Committee, OrgUnitType.Commission]);
    expect(ORG_UNIT_TYPES.filter((type) => isCollegiateBody(type))).toEqual(COLLEGIATE_BODY_TYPES);
    expect(isCollegiateBody(null)).toBe(false);
    expect(isCollegiateBody('AREA')).toBe(false);
  });

  it('la descripción de Swagger nombra cada código con su etiqueta', () => {
    for (const type of ORG_UNIT_TYPES) {
      expect(ORG_UNIT_TYPE_DESCRIPTION).toContain(`${type} = ${ORG_UNIT_TYPE_LABELS[type]}`);
    }
  });

  describe('DTO', () => {
    const errorsFor = async (type: string, Dto: typeof CreateOrganizationalUnitDto | typeof UpdateOrganizationalUnitDto) =>
      (await validate(plainToInstance(Dto, { code: 'X', name: 'X', type }))).filter((error) => error.property === 'type');

    it.each(['AREA', 'OTHER', 'Comité', 'committee'])('rechaza %s en alta y edición', async (type) => {
      expect(await errorsFor(type, CreateOrganizationalUnitDto)).toHaveLength(1);
      expect(await errorsFor(type, UpdateOrganizationalUnitDto)).toHaveLength(1);
    });

    it.each(ORG_UNIT_TYPES)('acepta %s', async (type) => {
      expect(await errorsFor(type, CreateOrganizationalUnitDto)).toEqual([]);
      expect(await errorsFor(type, UpdateOrganizationalUnitDto)).toEqual([]);
    });
  });

  describe('lectura del Tipo en el Excel', () => {
    it('etiquetas nuevas y códigos, sin importar mayúsculas ni tildes', () => {
      for (const type of ORG_UNIT_TYPES) {
        expect(parseUnitType(ORG_UNIT_TYPE_LABELS[type])).toBe(type);
        expect(parseUnitType(type.toLowerCase())).toBe(type);
      }
      expect(parseUnitType('  COMITE ')).toBe(OrgUnitType.Committee);
      expect(parseUnitType('comision')).toBe(OrgUnitType.Commission);
      expect(parseUnitType('CONSEJO')).toBe(OrgUnitType.Council);
      expect(parseUnitType('coordinacion  de programa')).toBe(OrgUnitType.Program);
      expect(parseUnitType('DEPENDENCIA')).toBe(OrgUnitType.Dependency);
    });

    it('etiquetas viejas como alias', () => {
      expect(parseUnitType('Consejo o comité')).toBe(OrgUnitType.Council);
      expect(parseUnitType('CONSEJO O COMITE')).toBe(OrgUnitType.Council);
      expect(parseUnitType('Área')).toBe(OrgUnitType.Dependency);
      expect(parseUnitType('area')).toBe(OrgUnitType.Dependency);
      expect(parseUnitType('Otro')).toBe(OrgUnitType.Dependency);
      expect(parseUnitType('OTHER')).toBe(OrgUnitType.Dependency);
      expect(parseUnitType('Programa')).toBe(OrgUnitType.Program);
    });

    it('desconocido: undefined; las opciones van en el orden de la lista', () => {
      expect(parseUnitType('División')).toBeUndefined();
      expect(UNIT_TYPE_OPTIONS).toBe(
        'Dependencia, Rectoría, Vicerrectoría, Dirección, Facultad, Departamento, Coordinación de programa, Oficina, Centro, Consejo, Comité, Comisión',
      );
    });
  });
});
