import { blockTexts, type EmailBlock, type ParagraphBlock } from './email-blocks.js';
import { textToRichText } from './rich-text.js';

/**
 * Catálogo de los correos que el sistema YA envía (tipos fijos en código) y de sus variables.
 *
 * Límite de alcance: desde la pantalla "Plantillas de correo" se diseña el CONTENIDO de estos tipos (asunto y
 * bloques). Un tipo nuevo exige desarrollo: agregarlo aquí (variables obligatorias/opcionales, contexto de ejemplo,
 * diseño por defecto) y escribir el código que lo envía con esas variables. Las variables las pone quien envía
 * (MailService, MailOutboxService): agregar una al catálogo sin enviarla solo produce un texto vacío.
 */
export const EMAIL_TEMPLATE_TYPES = [
  'USER_INVITATION',
  'PASSWORD_RESET',
  'GENERIC_NOTIFICATION',
  'SYSTEM_ALERT',
  'LOAN_STATUS_NOTIFICATION',
  'INVENTORY_ALERT',
  'SIGNATURE_LINK',
  'IMPORT_FINISHED',
] as const;

export type EmailTemplateType = (typeof EMAIL_TEMPLATE_TYPES)[number];

export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplateType, string> = {
  USER_INVITATION: 'Invitación de usuario',
  PASSWORD_RESET: 'Restablecer contraseña',
  GENERIC_NOTIFICATION: 'Notificación general',
  SYSTEM_ALERT: 'Alerta del sistema',
  LOAN_STATUS_NOTIFICATION: 'Aviso de préstamo',
  INVENTORY_ALERT: 'Alerta de toma física',
  SIGNATURE_LINK: 'Enlace para firmar un acta',
  IMPORT_FINISHED: 'Fin de una importación desde Excel',
};

export interface EmailPlaceholderCatalog {
  readonly required: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<string>;
}

export const EMAIL_PLACEHOLDER_CATALOG: Record<
  EmailTemplateType,
  EmailPlaceholderCatalog
> = {
  USER_INVITATION: {
    required: [
      'user.email',
      'user.username',
      'auth.temporaryPassword',
      'auth.loginUrl',
    ],
    optional: ['user.fullName', 'user.role', 'app.name'],
  },
  PASSWORD_RESET: {
    required: ['user.email', 'auth.resetUrl'],
    optional: ['user.username', 'auth.expiresInHours', 'app.name'],
  },
  GENERIC_NOTIFICATION: {
    required: ['user.email', 'notification.title', 'notification.message'],
    optional: ['app.name', 'app.loginUrl'],
  },
  SYSTEM_ALERT: {
    required: ['alert.title', 'alert.message'],
    optional: ['alert.severity', 'app.name'],
  },
  LOAN_STATUS_NOTIFICATION: {
    required: ['user.email', 'prestamo.estado', 'prestamo.justificacion'],
    optional: ['origen.nombre', 'destino.nombre', 'app.loginUrl'],
  },
  INVENTORY_ALERT: {
    required: ['user.email', 'inventario.nombre', 'alerta.mensaje'],
    optional: ['inventario.fecha', 'app.loginUrl'],
  },
  SIGNATURE_LINK: {
    required: ['firma.url', 'firma.vence', 'acta.formato', 'acta.numero', 'contacto'],
    optional: ['firmante.nombre', 'firma.rol', 'app.name'],
  },
  IMPORT_FINISHED: {
    required: ['importacion.estado', 'importacion.destino', 'importacion.resumen'],
    optional: ['importacion.archivo', 'user.fullName', 'app.name', 'app.loginUrl'],
  },
};

export const EMAIL_VARIABLE_KINDS = ['url', 'text'] as const;
export type EmailVariableKind = (typeof EMAIL_VARIABLE_KINDS)[number];

/**
 * Qué es cada variable, para el editor. `url`: su valor es un enlace; en el diseño va como href de un enlace del
 * párrafo, URL de un botón o enlace de una imagen, nunca como texto visible (url-variables-as-text.ts); `linkText`
 * es el texto sugerido del enlace. `text`: se muestra tal cual.
 */
export interface EmailVariableSpec {
  readonly name: string;
  readonly label: string;
  readonly kind: EmailVariableKind;
  /** Solo kind = url; null en las de texto. */
  readonly linkText: string | null;
}

const textVar = (label: string): Omit<EmailVariableSpec, 'name'> => ({ label, kind: 'text', linkText: null });
const urlVar = (label: string, linkText: string): Omit<EmailVariableSpec, 'name'> => ({ label, kind: 'url', linkText });

/**
 * Significado de cada variable, tomado de quien la pone en el contexto: MailService (src/shared/mail/mail.service.ts:
 * invitación, restablecimiento, enlace de firma), ImportJobsService.notify (importaciones) y MailOutboxService (agrega
 * user.fullName). GENERIC_NOTIFICATION, SYSTEM_ALERT, LOAN_STATUS_NOTIFICATION e INVENTORY_ALERT aún no los envía
 * ningún código: su significado sale de su diseño por defecto y sus datos de ejemplo. Una variable significa lo mismo
 * en todos los tipos que la usan.
 */
const EMAIL_VARIABLES: Readonly<Record<string, Omit<EmailVariableSpec, 'name'>>> = {
  'user.email': textVar('Correo del usuario'),
  'user.username': textVar('Usuario con el que inicia sesión'),
  'user.fullName': textVar('Nombre completo del usuario'),
  'user.role': textVar('Rol asignado al usuario'),
  'auth.temporaryPassword': textVar('Contraseña temporal'),
  'auth.loginUrl': urlVar('Enlace para iniciar sesión', 'Iniciar sesión'),
  'auth.resetUrl': urlVar('Enlace para restablecer la contraseña', 'Restablecer contraseña'),
  'auth.expiresInHours': textVar('Horas de validez del enlace'),
  'app.name': textVar('Nombre de la aplicación'),
  'app.loginUrl': urlVar('Enlace para abrir Control Interno', 'Abrir Control Interno'),
  'notification.title': textVar('Título del aviso'),
  'notification.message': textVar('Mensaje del aviso'),
  'alert.title': textVar('Título de la alerta'),
  'alert.message': textVar('Mensaje de la alerta'),
  'alert.severity': textVar('Gravedad de la alerta'),
  'prestamo.estado': textVar('Estado del préstamo'),
  'prestamo.justificacion': textVar('Justificación del préstamo'),
  'origen.nombre': textVar('Origen del préstamo'),
  'destino.nombre': textVar('Destino del préstamo'),
  'inventario.nombre': textVar('Nombre de la toma física'),
  'inventario.fecha': textVar('Fecha de la toma física'),
  'alerta.mensaje': textVar('Mensaje de la alerta de la toma física'),
  'firma.url': urlVar('Enlace para leer y firmar el documento', 'Abrir el documento'),
  'firma.vence': textVar('Fecha y hora en que vence el enlace de firma'),
  'firma.rol': textVar('Papel del firmante en el documento'),
  'firmante.nombre': textVar('Nombre del firmante'),
  'acta.formato': textVar('Formato del documento'),
  'acta.numero': textVar('Número del documento'),
  contacto: textVar('Persona de contacto para dudas'),
  'importacion.estado': textVar('Resultado de la importación (terminada o fallida)'),
  'importacion.destino': textVar('Qué se importó (por ejemplo, activos)'),
  'importacion.archivo': textVar('Archivo y hoja importados'),
  'importacion.resumen': textVar('Resumen de la importación'),
};

const variableSpec = (name: string): EmailVariableSpec => {
  const spec = EMAIL_VARIABLES[name];
  if (!spec) {
    throw new Error(`La variable {{${name}}} del catálogo de correos no tiene descripción en EMAIL_VARIABLES`);
  }
  return { name, ...spec };
};

/** Variables de cada tipo con su descripción: primero las obligatorias, luego las opcionales. */
const typeVariables = (type: EmailTemplateType): ReadonlyArray<EmailVariableSpec> =>
  [...EMAIL_PLACEHOLDER_CATALOG[type].required, ...EMAIL_PLACEHOLDER_CATALOG[type].optional].map(variableSpec);

export const EMAIL_TEMPLATE_VARIABLES: Record<EmailTemplateType, ReadonlyArray<EmailVariableSpec>> = {
  USER_INVITATION: typeVariables('USER_INVITATION'),
  PASSWORD_RESET: typeVariables('PASSWORD_RESET'),
  GENERIC_NOTIFICATION: typeVariables('GENERIC_NOTIFICATION'),
  SYSTEM_ALERT: typeVariables('SYSTEM_ALERT'),
  LOAN_STATUS_NOTIFICATION: typeVariables('LOAN_STATUS_NOTIFICATION'),
  INVENTORY_ALERT: typeVariables('INVENTORY_ALERT'),
  SIGNATURE_LINK: typeVariables('SIGNATURE_LINK'),
  IMPORT_FINISHED: typeVariables('IMPORT_FINISHED'),
};

/** Variables de enlace (kind = url) del tipo. */
export const urlVariables = (type: EmailTemplateType): ReadonlyMap<string, EmailVariableSpec> =>
  new Map(EMAIL_TEMPLATE_VARIABLES[type].filter((item) => item.kind === 'url').map((item) => [item.name, item]));

export interface EmailTemplateDesign {
  readonly subject: string;
  readonly blocks: ReadonlyArray<EmailBlock>;
}

/** Párrafo de texto simple (sin formato) para los diseños por defecto. */
const paragraph = (text: string): ParagraphBlock => ({ type: 'paragraph', content: textToRichText(text) });

/**
 * Diseño por defecto de cada tipo: se usa mientras el tipo no tenga versión activa en BD. Mismo texto que las
 * plantillas de texto anteriores, organizado en bloques (datos en lista, enlace como botón).
 */
export const DEFAULT_EMAIL_DESIGNS: Record<EmailTemplateType, EmailTemplateDesign> = {
  USER_INVITATION: {
    subject: 'Invitación a {{app.name}}',
    blocks: [
      { type: 'heading', text: 'Invitación a {{app.name}}' },
      paragraph('Se creó su cuenta en {{app.name}}.'),
      {
        type: 'keyValueList',
        items: [
          { label: 'Rol', value: '{{user.role}}' },
          { label: 'Correo', value: '{{user.email}}' },
          { label: 'Usuario', value: '{{user.username}}' },
          { label: 'Contraseña temporal', value: '{{auth.temporaryPassword}}' },
        ],
      },
      paragraph('Inicie sesión y cambie la contraseña.'),
      { type: 'button', label: 'Iniciar sesión', url: '{{auth.loginUrl}}' },
    ],
  },
  PASSWORD_RESET: {
    subject: 'Restablecer contraseña — {{app.name}}',
    blocks: [
      paragraph('Hola {{user.email}},'),
      paragraph('Use este enlace para restablecer su contraseña:'),
      { type: 'button', label: 'Restablecer contraseña', url: '{{auth.resetUrl}}' },
      { type: 'callout', tone: 'info', text: 'El enlace vence en {{auth.expiresInHours}} horas.' },
    ],
  },
  GENERIC_NOTIFICATION: {
    subject: '{{notification.title}} — {{app.name}}',
    blocks: [
      { type: 'heading', text: '{{notification.title}}' },
      paragraph('Hola {{user.email}},'),
      paragraph('{{notification.message}}'),
      { type: 'button', label: 'Abrir {{app.name}}', url: '{{app.loginUrl}}' },
    ],
  },
  SYSTEM_ALERT: {
    subject: '[{{alert.severity}}] {{alert.title}}',
    blocks: [
      { type: 'heading', text: '{{alert.title}}' },
      { type: 'callout', tone: 'warning', text: '{{alert.message}}' },
    ],
  },
  LOAN_STATUS_NOTIFICATION: {
    subject: 'Préstamo {{prestamo.estado}}',
    blocks: [
      paragraph('Hola {{user.email}},'),
      paragraph('El préstamo cambió a {{prestamo.estado}}.'),
      { type: 'keyValueList', items: [{ label: 'Justificación', value: '{{prestamo.justificacion}}' }] },
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
    ],
  },
  INVENTORY_ALERT: {
    subject: 'Toma física: {{inventario.nombre}}',
    blocks: [
      paragraph('Hola {{user.email}},'),
      { type: 'callout', tone: 'info', text: '{{alerta.mensaje}}' },
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
    ],
  },
  SIGNATURE_LINK: {
    subject: 'Firma pendiente: {{acta.formato}} N.° {{acta.numero}}',
    blocks: [
      paragraph('Hola {{firmante.nombre}},'),
      paragraph('Tiene pendiente la firma del documento {{acta.formato}} N.° {{acta.numero}}, como {{firma.rol}}.'),
      paragraph('Para leerlo y firmarlo (o rechazarlo indicando el motivo) abra este enlace:'),
      { type: 'button', label: 'Abrir el documento', url: '{{firma.url}}' },
      {
        type: 'callout',
        tone: 'warning',
        text:
          'Antes de firmar se le pedirán los últimos 4 dígitos de su número de documento.\n' +
          'El enlace es personal, sirve una sola vez y vence el {{firma.vence}}. No lo reenvíe.',
      },
      paragraph('Si tiene dudas, no reconoce este documento o el enlace venció, contacte a {{contacto}}.'),
      paragraph('{{app.name}}'),
    ],
  },
  IMPORT_FINISHED: {
    subject: 'Importación de {{importacion.destino}}: {{importacion.estado}}',
    blocks: [
      paragraph('Hola {{user.fullName}},'),
      paragraph('La importación de {{importacion.destino}} (archivo {{importacion.archivo}}) quedó {{importacion.estado}}.'),
      { type: 'callout', tone: 'info', text: '{{importacion.resumen}}' },
      { type: 'button', label: 'Ver el detalle', url: '{{app.loginUrl}}' },
      paragraph('{{app.name}}'),
    ],
  },
};

export const EMAIL_SAMPLE_CONTEXT: Record<EmailTemplateType, Record<string, string>> =
  {
    USER_INVITATION: {
      'user.email': 'juliana.perez@unac.edu.co',
      'user.username': 'juliana.perez@unac.edu.co',
      'user.fullName': 'Juliana Pérez',
      'user.role': 'Consulta',
      'auth.temporaryPassword': 'Temp.Ejemplo1',
      'auth.loginUrl': 'http://localhost:4200/auth/login',
      'app.name': 'Control Interno UNAC',
    },
    PASSWORD_RESET: {
      'user.email': 'juliana.perez@unac.edu.co',
      'user.username': 'juliana.perez@unac.edu.co',
      'auth.resetUrl': 'http://localhost:4200/auth/reset-password?token=ejemplo',
      'auth.expiresInHours': '1',
      'app.name': 'Control Interno UNAC',
    },
    GENERIC_NOTIFICATION: {
      'user.email': 'juliana.perez@unac.edu.co',
      'notification.title': 'Aviso',
      'notification.message': 'Hay una novedad en Control Interno.',
      'app.name': 'Control Interno UNAC',
      'app.loginUrl': 'http://localhost:4200/auth/login',
    },
    SYSTEM_ALERT: {
      'alert.title': 'Servicio interrumpido',
      'alert.message': 'El almacenamiento no responde.',
      'alert.severity': 'alta',
      'app.name': 'Control Interno UNAC',
    },
    LOAN_STATUS_NOTIFICATION: {
      'user.email': 'juliana.perez@unac.edu.co',
      'prestamo.estado': 'APROBADO',
      'prestamo.justificacion': 'Práctica de laboratorio',
      'origen.nombre': 'Ingeniería',
      'destino.nombre': 'Laboratorio',
      'app.loginUrl': 'http://localhost:4200/auth/login',
    },
    INVENTORY_ALERT: {
      'user.email': 'juliana.perez@unac.edu.co',
      'inventario.nombre': 'Toma sede Medellín',
      'alerta.mensaje': 'Quedan ítems sin verificar.',
      'inventario.fecha': '2026-09-08',
      'app.loginUrl': 'http://localhost:4200/auth/login',
    },
    SIGNATURE_LINK: {
      'firmante.nombre': 'Juliana Pérez',
      'firma.url': 'http://localhost:4200/firmar/ejemplo',
      'firma.vence': '28 de septiembre de 2026, 10:00 a. m.',
      'firma.rol': 'Recibe',
      'acta.formato': 'OCI-01-55 · Acta de entrega y asignación de activos fijos',
      'acta.numero': '0093',
      contacto: 'Carolina Gómez (carolina.gomez@unac.edu.co)',
      'app.name': 'Control Interno UNAC',
    },
    IMPORT_FINISHED: {
      'user.fullName': 'Juliana Pérez',
      'importacion.estado': 'terminada',
      'importacion.destino': 'activos',
      'importacion.archivo': 'activos.xlsx · hoja ACTIVOS',
      'importacion.resumen': 'Insertados: 8780\nOmitidos por ya existir: 0\nEn cuarentena: 161',
      'app.loginUrl': 'http://localhost:4200',
      'app.name': 'Control Interno UNAC',
    },
  };


const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export const extractEmailPlaceholders = (text: string): ReadonlyArray<string> => {
  const matches = text.matchAll(TOKEN_PATTERN);
  return [...new Set([...matches].map((match) => match[1] ?? ''))].filter(
    (item) => item !== '',
  );
};

/** Variables usadas en el asunto y en los bloques, sin repetir, en orden de aparición. */
export const designPlaceholders = (design: EmailTemplateDesign): ReadonlyArray<string> =>
  extractEmailPlaceholders([design.subject, ...design.blocks.flatMap(blockTexts)].join('\n'));

export const allowedEmailPlaceholders = (
  type: EmailTemplateType,
): ReadonlySet<string> => {
  const catalog = EMAIL_PLACEHOLDER_CATALOG[type];
  return new Set([...catalog.required, ...catalog.optional]);
};

export interface PlaceholderCheck {
  readonly placeholders: ReadonlyArray<string>;
  readonly unknown: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
}

/** Variables del diseño frente al catálogo del tipo: las que no pertenecen y las obligatorias que faltan. */
export const checkDesignPlaceholders = (
  type: EmailTemplateType,
  design: EmailTemplateDesign,
): PlaceholderCheck => {
  const placeholders = designPlaceholders(design);
  const allowed = allowedEmailPlaceholders(type);
  return {
    placeholders,
    unknown: placeholders.filter((token) => !allowed.has(token)),
    missing: EMAIL_PLACEHOLDER_CATALOG[type].required.filter((token) => !placeholders.includes(token)),
  };
};

export const isEmailTemplateType = (value: string): value is EmailTemplateType =>
  EMAIL_TEMPLATE_TYPES.some((item) => item === value);
