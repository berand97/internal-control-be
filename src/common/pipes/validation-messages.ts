type Translate = (numbers: ReadonlyArray<number>) => string;

const count = (value: number, one: string, many: string): string => (value === 1 ? `1 ${one}` : `${value} ${many}`);

const first = (numbers: ReadonlyArray<number>): number => numbers[0] ?? 0;

const fixed = (text: string): Translate => () => text;

const TRANSLATIONS: Readonly<Record<string, Translate>> = {
  isNotEmpty: fixed('Este campo es obligatorio.'),
  isDefined: fixed('Este campo es obligatorio.'),
  arrayNotEmpty: fixed('Agregue al menos un elemento.'),
  isString: fixed('Escriba un texto.'),
  maxLength: (numbers) => `Escriba máximo ${count(first(numbers), 'carácter', 'caracteres')}.`,
  minLength: (numbers) => `Escriba al menos ${count(first(numbers), 'carácter', 'caracteres')}.`,
  isUuid: fixed('Elija una opción válida.'),
  isInt: fixed('Escriba un número entero.'),
  isNumber: fixed('Escriba un número.'),
  isNumberString: fixed('Escriba solo números.'),
  isPositive: fixed('Escriba un número mayor que 0.'),
  isNegative: fixed('Escriba un número menor que 0.'),
  min: (numbers) => `El valor mínimo es ${first(numbers)}.`,
  max: (numbers) => `El valor máximo es ${first(numbers)}.`,
  isEnum: fixed('Elija una opción de la lista.'),
  isIn: fixed('Elija una opción de la lista.'),
  matches: fixed('El formato no es válido.'),
  isEmail: fixed('Escriba un correo válido.'),
  isDateString: fixed('Escriba una fecha válida.'),
  isIso8601: fixed('Escriba una fecha válida.'),
  isDate: fixed('Escriba una fecha válida.'),
  isBoolean: fixed('Elija sí o no.'),
  isArray: fixed('Envíe una lista.'),
  arrayMinSize: (numbers) => `Agregue al menos ${count(first(numbers), 'elemento', 'elementos')}.`,
  arrayMaxSize: (numbers) => `Agregue máximo ${count(first(numbers), 'elemento', 'elementos')}.`,
  arrayUnique: fixed('Hay valores repetidos.'),
  isObject: fixed('El valor no es válido.'),
  isNotEmptyObject: fixed('Este campo es obligatorio.'),
  isUrl: fixed('Escriba una dirección web válida.'),
  isHexColor: fixed('Escriba un color en formato #RRGGBB.'),
  whitelistValidation: fixed('Este campo no se permite.'),
  nestedValidation: fixed('El valor no es válido.'),
};

const FALLBACK = 'El valor no es válido.';

const isDefaultMessage = (message: string, property: string): boolean => {
  const subject = message.replace(/^each value in /u, '').replace(/^nested property /u, '').replace(/^property /u, '');
  return (
    subject.startsWith(`${property} must `) ||
    subject.startsWith(`${property} should `) ||
    /^All .+'s elements must be unique$/u.test(message)
  );
};

const numbersIn = (message: string): number[] =>
  [...message.matchAll(/-?\d+(?:\.\d+)?/gu)].map((match) => Number(match[0]));

export const translateConstraint = (constraint: string, message: string, property: string): string => {
  if (!isDefaultMessage(message, property)) {
    return message;
  }
  const numbers = numbersIn(message.slice(message.indexOf(property) + property.length));
  const key = constraint === 'isLength' ? (/longer than/u.test(message) ? 'minLength' : 'maxLength') : constraint;
  const translate = TRANSLATIONS[key];
  return translate ? translate(numbers) : FALLBACK;
};
