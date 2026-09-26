// Sin Gotenberg ni BD: la comparación de restos del ejemplo no puede depender de la fecha del día.
import { SAMPLE as OCI_01_65_SAMPLE } from '../../scripts/formats/build-oci-01-65-template.mjs';
import { OCI_01_55_SAMPLE } from '../../scripts/formats/template-leftovers.mjs';
import { containsFragment, sampleLeftovers } from './pdf-text.js';

const OPTIONS = { numbers: true } as const;

describe('sampleLeftovers: fragmentos del ejemplo por límites de palabra/número', () => {
  it('una fecha real que contiene una fecha del ejemplo como subcadena no es un resto', () => {
    for (const day of ['19', '29']) {
      const text = `Fecha: ${day} de septiembre de 2026\nFecha de entrega: ${day} de septiembre de 2026`;
      expect(sampleLeftovers(text, OCI_01_65_SAMPLE, OPTIONS), day).toEqual([]);
    }
    expect(sampleLeftovers('Plazo: 114 días, 18 meses', OCI_01_65_SAMPLE, OPTIONS)).toEqual([]);
    expect(sampleLeftovers('Del 111 de diciembre', OCI_01_65_SAMPLE, OPTIONS)).toEqual([]);
  });

  it('cada día del año: solo el 9 de septiembre, el 27 de marzo y el 11 de diciembre son restos', () => {
    const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const flagged: string[] = [];
    for (const month of months) {
      for (let day = 1; day <= 31; day += 1) {
        const date = `${day} de ${month}`;
        if (sampleLeftovers(`Fecha: ${date} de 2026`, OCI_01_65_SAMPLE, OPTIONS).length > 0) {
          flagged.push(date);
        }
      }
    }
    expect(flagged).toEqual(['27 de marzo', '9 de septiembre', '11 de diciembre']);
  });

  it('los fragmentos reales se siguen detectando, con puntuación, saltos, mayúsculas o tildes alrededor', () => {
    expect(sampleLeftovers('Fecha: 9 de septiembre de 2026', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['9 de septiembre']);
    expect(sampleLeftovers('(9 DE SEPTIEMBRE)', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['9 de septiembre']);
    expect(sampleLeftovers('Duración:\n14 DÍAS.', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['14 días']);
    expect(sampleLeftovers('Estado: buen estado, 8 meses', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['Buen estado', '8 meses']);
    expect(sampleLeftovers('Ver Link de Imagenes', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['Link de Imágenes']);
    expect(sampleLeftovers('host 192.168.4.60:80', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['192.168.4.60']);
    expect(sampleLeftovers('Link de fotografías: x', OCI_01_55_SAMPLE, OPTIONS)).toEqual(['Link de', 'fotografías:']);
    // Documentos y números del ejemplo: sin cambios.
    expect(sampleLeftovers('C.C. 1.234.089.865', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['1234089865']);
    expect(sampleLeftovers('Consecutivo 0001', OCI_01_65_SAMPLE, OPTIONS)).toEqual(['0001']);
  });

  it('containsFragment: un dígito no pega con un dígito ni una letra con una letra', () => {
    expect(containsFragment('19 DE SEPTIEMBRE', '9 DE SEPTIEMBRE')).toBe(false);
    expect(containsFragment('A9 DE SEPTIEMBRE', '9 DE SEPTIEMBRE')).toBe(true);
    expect(containsFragment('9 DE SEPTIEMBRES', '9 DE SEPTIEMBRE')).toBe(false);
    expect(containsFragment('9 DE SEPTIEMBRE2026', '9 DE SEPTIEMBRE')).toBe(true);
    expect(containsFragment('X.CORE I5.', 'CORE I5')).toBe(true);
    expect(containsFragment('CORE I57', 'CORE I5')).toBe(false);
    expect(containsFragment('A+B', 'A+B')).toBe(true);
  });
});
