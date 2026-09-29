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
  'INVENTORY_SCHEDULED',
  'INVENTORY_RESCHEDULED',
  'INVENTORY_REMINDER',
  'INVENTORY_CANCELLED',
  'ASSET_REQUEST_CREATED',
  'ASSET_REQUEST_ACCEPTED',
  'ASSET_REQUEST_CLOSED',
  'ASSET_REQUEST_RETURNED',
  'ASSET_REQUEST_CORRECTED',
  'ASSET_REQUEST_CANCELLED',
  'ASSET_REQUEST_GENERATED',
  'ASSET_REQUEST_EXPIRED',
  'ASSET_REQUEST_COMPLETED',
  'ASSET_REQUEST_LOAN_SCHEDULED',
  'ASSET_REQUEST_LOAN_STARTS',
  'ASSET_REQUEST_LOAN_REJECTED',
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
  INVENTORY_SCHEDULED: 'Aviso de toma física programada',
  INVENTORY_RESCHEDULED: 'Aviso de toma física reprogramada',
  INVENTORY_REMINDER: 'Recordatorio de toma física',
  INVENTORY_CANCELLED: 'Aviso de toma física cancelada',
  ASSET_REQUEST_CREATED: 'Solicitud de activos recibida',
  ASSET_REQUEST_ACCEPTED: 'Solicitud de activos aceptada por el centro dueño',
  ASSET_REQUEST_CLOSED: 'Solicitud de activos cerrada por el centro dueño',
  ASSET_REQUEST_RETURNED: 'Solicitud de activos devuelta para corregir',
  ASSET_REQUEST_CORRECTED: 'Solicitud de activos corregida',
  ASSET_REQUEST_CANCELLED: 'Solicitud de activos cancelada',
  ASSET_REQUEST_GENERATED: 'Documento de la solicitud de activos generado',
  ASSET_REQUEST_EXPIRED: 'Solicitud de activos vencida',
  ASSET_REQUEST_COMPLETED: 'Documento de la solicitud de activos firmado',
  ASSET_REQUEST_LOAN_SCHEDULED: 'Préstamo de la solicitud de activos programado',
  ASSET_REQUEST_LOAN_STARTS: 'Día de entrega del préstamo de la solicitud de activos',
  ASSET_REQUEST_LOAN_REJECTED: 'Préstamo programado de la solicitud de activos rechazado',
};

/** Obligatorias y opcionales comunes de los avisos de solicitudes de activos (AssetRequestNoticesService). */
const ASSET_REQUEST_REQUIRED = [
  'solicitud.codigo',
  'solicitud.tipo',
  'solicitud.centroSolicitante',
  'solicitud.centroDueno',
  'solicitud.url',
] as const;
const ASSET_REQUEST_OPTIONAL = [
  'solicitud.descripcion',
  'solicitud.solicitante',
  'user.fullName',
  'app.name',
  'app.loginUrl',
] as const;

export interface EmailPlaceholderCatalog {
  readonly required: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<string>;
}

/** Opcionales comunes de los avisos de toma física (InventoryNoticesService). */
const INVENTORY_OPTIONAL = [
  'centro.codigo',
  'centro.nombre',
  'toma.responsable',
  'user.fullName',
  'app.name',
  'app.loginUrl',
] as const;

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
  INVENTORY_SCHEDULED: {
    required: ['toma.codigo', 'toma.nombre', 'toma.alcance', 'toma.inicio', 'toma.fin'],
    optional: [...INVENTORY_OPTIONAL],
  },
  INVENTORY_RESCHEDULED: {
    required: ['toma.codigo', 'toma.nombre', 'toma.alcance', 'toma.inicio', 'toma.fin', 'toma.motivo'],
    optional: ['toma.inicioAnterior', 'toma.finAnterior', ...INVENTORY_OPTIONAL],
  },
  INVENTORY_REMINDER: {
    required: ['toma.codigo', 'toma.nombre', 'toma.alcance', 'toma.inicio', 'toma.fin', 'recordatorio.cuando'],
    optional: ['recordatorio.dias', ...INVENTORY_OPTIONAL],
  },
  INVENTORY_CANCELLED: {
    required: ['toma.codigo', 'toma.nombre', 'toma.alcance', 'toma.motivo'],
    optional: ['toma.inicio', 'toma.fin', ...INVENTORY_OPTIONAL],
  },
  ASSET_REQUEST_CREATED: { required: [...ASSET_REQUEST_REQUIRED], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_ACCEPTED: { required: [...ASSET_REQUEST_REQUIRED], optional: ['solicitud.activos', ...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_CLOSED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.motivo'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_RETURNED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.motivo'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_CORRECTED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.estado'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_CANCELLED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.motivo'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_GENERATED: {
    required: [...ASSET_REQUEST_REQUIRED, 'documento.tipo'],
    optional: [...ASSET_REQUEST_OPTIONAL],
  },
  ASSET_REQUEST_EXPIRED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.vencio'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_COMPLETED: {
    required: [
      ...ASSET_REQUEST_REQUIRED.filter((name) => name !== 'solicitud.url'),
      'documento.tipo',
      'documento.numero',
      'documento.url',
    ],
    optional: ['solicitud.url', ...ASSET_REQUEST_OPTIONAL],
  },
  ASSET_REQUEST_LOAN_SCHEDULED: { required: [...ASSET_REQUEST_REQUIRED, 'prestamo.inicio'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_LOAN_STARTS: { required: [...ASSET_REQUEST_REQUIRED, 'prestamo.inicio'], optional: [...ASSET_REQUEST_OPTIONAL] },
  ASSET_REQUEST_LOAN_REJECTED: { required: [...ASSET_REQUEST_REQUIRED, 'solicitud.motivo'], optional: [...ASSET_REQUEST_OPTIONAL] },
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
 * invitación, restablecimiento, enlace de firma), ImportJobsService.notify (importaciones), InventoryNoticesService
 * (avisos y recordatorios de tomas físicas) y MailOutboxService (agrega user.fullName). GENERIC_NOTIFICATION, SYSTEM_ALERT, LOAN_STATUS_NOTIFICATION e INVENTORY_ALERT aún no los envía
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
  'toma.codigo': textVar('Código de la toma física'),
  'toma.nombre': textVar('Nombre de la toma física'),
  'toma.alcance': textVar('Qué cubre la toma (centro de costo, ubicación, unidad o toda la institución)'),
  'toma.inicio': textVar('Fecha de inicio de la toma'),
  'toma.fin': textVar('Fecha de fin de la toma'),
  'toma.inicioAnterior': textVar('Fecha de inicio antes de reprogramar'),
  'toma.finAnterior': textVar('Fecha de fin antes de reprogramar'),
  'toma.responsable': textVar('Responsable de la toma'),
  'toma.motivo': textVar('Motivo de la reprogramación o de la cancelación'),
  'centro.codigo': textVar('Código del centro de costo (solo tomas de un centro)'),
  'centro.nombre': textVar('Nombre del centro de costo (solo tomas de un centro)'),
  'recordatorio.cuando': textVar('Cuándo empieza la toma (hoy, mañana, en 15 días)'),
  'recordatorio.dias': textVar('Días que faltan para el inicio'),
  'solicitud.codigo': textVar('Código de la solicitud de activos'),
  'solicitud.tipo': textVar('Tipo de solicitud (préstamo temporal o traslado permanente)'),
  'solicitud.centroSolicitante': textVar('Centro de costo que solicita los activos'),
  'solicitud.centroDueno': textVar('Centro de costo dueño de los activos'),
  'solicitud.url': urlVar('Enlace a la solicitud en Control Interno', 'Ver la solicitud'),
  'solicitud.descripcion': textVar('Qué necesita el centro solicitante'),
  'solicitud.solicitante': textVar('Nombre de quien solicita'),
  'solicitud.activos': textVar('Cantidad de activos elegidos por el centro dueño'),
  'solicitud.motivo': textVar('Motivo del cierre, la devolución o la cancelación'),
  'solicitud.estado': textVar('A quién pasa la solicitud corregida (centro dueño o Control Interno)'),
  'solicitud.vencio': textVar('Fecha en que venció la solicitud (aceptada sin revisión de Control Interno, o devuelta sin corrección)'),
  'prestamo.inicio': textVar('Fecha de inicio del préstamo: desde ese día se puede entregar'),
  'documento.tipo': textVar('Documento generado (préstamo OCI-01-65 o traslado OCI-17-89)'),
  'documento.numero': textVar('Número del acta firmada'),
  'documento.url': urlVar('Enlace al acta firmada', 'Ver el acta'),
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
  INVENTORY_SCHEDULED: typeVariables('INVENTORY_SCHEDULED'),
  INVENTORY_RESCHEDULED: typeVariables('INVENTORY_RESCHEDULED'),
  INVENTORY_REMINDER: typeVariables('INVENTORY_REMINDER'),
  INVENTORY_CANCELLED: typeVariables('INVENTORY_CANCELLED'),
  ASSET_REQUEST_CREATED: typeVariables('ASSET_REQUEST_CREATED'),
  ASSET_REQUEST_ACCEPTED: typeVariables('ASSET_REQUEST_ACCEPTED'),
  ASSET_REQUEST_CLOSED: typeVariables('ASSET_REQUEST_CLOSED'),
  ASSET_REQUEST_RETURNED: typeVariables('ASSET_REQUEST_RETURNED'),
  ASSET_REQUEST_CORRECTED: typeVariables('ASSET_REQUEST_CORRECTED'),
  ASSET_REQUEST_CANCELLED: typeVariables('ASSET_REQUEST_CANCELLED'),
  ASSET_REQUEST_GENERATED: typeVariables('ASSET_REQUEST_GENERATED'),
  ASSET_REQUEST_EXPIRED: typeVariables('ASSET_REQUEST_EXPIRED'),
  ASSET_REQUEST_COMPLETED: typeVariables('ASSET_REQUEST_COMPLETED'),
  ASSET_REQUEST_LOAN_SCHEDULED: typeVariables('ASSET_REQUEST_LOAN_SCHEDULED'),
  ASSET_REQUEST_LOAN_STARTS: typeVariables('ASSET_REQUEST_LOAN_STARTS'),
  ASSET_REQUEST_LOAN_REJECTED: typeVariables('ASSET_REQUEST_LOAN_REJECTED'),
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

/** Diseño por defecto de los avisos de solicitud de activos: título, texto, datos, aviso opcional y botón. */
const assetRequestDesign = (
  subject: string,
  heading: string,
  text: string,
  callout?: { readonly tone: 'info' | 'warning'; readonly text: string },
  button: { readonly label: string; readonly url: string } = { label: 'Ver la solicitud', url: '{{solicitud.url}}' },
): EmailTemplateDesign => ({
  subject,
  blocks: [
    { type: 'heading', text: heading },
    paragraph('Hola {{user.fullName}},'),
    paragraph(text),
    {
      type: 'keyValueList',
      items: [
        { label: 'Solicitud', value: '{{solicitud.codigo}}' },
        { label: 'Tipo', value: '{{solicitud.tipo}}' },
        { label: 'Centro que solicita', value: '{{solicitud.centroSolicitante}}' },
        { label: 'Centro dueño', value: '{{solicitud.centroDueno}}' },
      ],
    },
    ...(callout ? [{ type: 'callout' as const, tone: callout.tone, text: callout.text }] : []),
    { type: 'button', label: button.label, url: button.url },
    paragraph('{{app.name}}'),
  ],
});

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
  INVENTORY_SCHEDULED: {
    subject: 'Toma física programada: {{toma.alcance}}',
    blocks: [
      { type: 'heading', text: 'Toma física programada' },
      paragraph('Hola {{user.fullName}},'),
      paragraph('Control Interno programó la toma física {{toma.codigo}} ({{toma.nombre}}).'),
      {
        type: 'keyValueList',
        items: [
          { label: 'Alcance', value: '{{toma.alcance}}' },
          { label: 'Inicio', value: '{{toma.inicio}}' },
          { label: 'Fin', value: '{{toma.fin}}' },
          { label: 'Responsable', value: '{{toma.responsable}}' },
        ],
      },
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
      paragraph('{{app.name}}'),
    ],
  },
  INVENTORY_RESCHEDULED: {
    subject: 'Toma física reprogramada: {{toma.codigo}}',
    blocks: [
      { type: 'heading', text: 'Toma física reprogramada' },
      paragraph('Hola {{user.fullName}},'),
      paragraph('La toma física {{toma.codigo}} ({{toma.nombre}}) cambió de fechas.'),
      {
        type: 'keyValueList',
        items: [
          { label: 'Alcance', value: '{{toma.alcance}}' },
          { label: 'Nuevo inicio', value: '{{toma.inicio}}' },
          { label: 'Nuevo fin', value: '{{toma.fin}}' },
          { label: 'Fechas anteriores', value: '{{toma.inicioAnterior}} a {{toma.finAnterior}}' },
          { label: 'Responsable', value: '{{toma.responsable}}' },
        ],
      },
      { type: 'callout', tone: 'info', text: 'Motivo: {{toma.motivo}}' },
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
      paragraph('{{app.name}}'),
    ],
  },
  INVENTORY_REMINDER: {
    subject: 'Recordatorio: la toma física {{toma.codigo}} empieza {{recordatorio.cuando}}',
    blocks: [
      paragraph('Hola {{user.fullName}},'),
      paragraph('Le recordamos que la toma física {{toma.codigo}} ({{toma.nombre}}) empieza {{recordatorio.cuando}}.'),
      {
        type: 'keyValueList',
        items: [
          { label: 'Alcance', value: '{{toma.alcance}}' },
          { label: 'Inicio', value: '{{toma.inicio}}' },
          { label: 'Fin', value: '{{toma.fin}}' },
          { label: 'Responsable', value: '{{toma.responsable}}' },
        ],
      },
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
      paragraph('{{app.name}}'),
    ],
  },
  INVENTORY_CANCELLED: {
    subject: 'Toma física cancelada: {{toma.codigo}}',
    blocks: [
      { type: 'heading', text: 'Toma física cancelada' },
      paragraph('Hola {{user.fullName}},'),
      paragraph('Control Interno canceló la toma física {{toma.codigo}} ({{toma.nombre}}) de {{toma.alcance}}.'),
      { type: 'callout', tone: 'warning', text: 'Motivo: {{toma.motivo}}' },
      paragraph('No recibirá más recordatorios de esta toma.'),
      { type: 'button', label: 'Abrir Control Interno', url: '{{app.loginUrl}}' },
      paragraph('{{app.name}}'),
    ],
  },
  ASSET_REQUEST_CREATED: assetRequestDesign(
    'Solicitud de activos {{solicitud.codigo}}',
    'Nueva solicitud de activos',
    '{{solicitud.solicitante}} pide activos de su centro de costo. Revise la solicitud y elija los activos o ciérrela indicando el motivo.',
    { tone: 'info', text: '{{solicitud.descripcion}}' },
  ),
  ASSET_REQUEST_ACCEPTED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} aceptada',
    'Solicitud de activos aceptada',
    'El centro dueño aceptó la solicitud y eligió {{solicitud.activos}} activos. Control Interno la revisa y genera el documento.',
  ),
  ASSET_REQUEST_CLOSED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} cerrada',
    'Solicitud de activos cerrada',
    'El centro dueño cerró la solicitud: no entregará los activos.',
    { tone: 'warning', text: 'Motivo: {{solicitud.motivo}}' },
  ),
  ASSET_REQUEST_RETURNED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} devuelta para corregir',
    'Solicitud de activos devuelta',
    'Control Interno devolvió la solicitud para que la corrija o la cancele.',
    { tone: 'warning', text: 'Motivo: {{solicitud.motivo}}' },
  ),
  ASSET_REQUEST_CORRECTED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} corregida',
    'Solicitud de activos corregida',
    'El solicitante corrigió la solicitud; ahora la revisa {{solicitud.estado}}.',
  ),
  ASSET_REQUEST_CANCELLED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} cancelada',
    'Solicitud de activos cancelada',
    'El solicitante canceló la solicitud.',
    { tone: 'warning', text: 'Motivo: {{solicitud.motivo}}' },
  ),
  ASSET_REQUEST_GENERATED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}}: documento generado',
    'Documento generado',
    'Control Interno generó el documento de la solicitud: {{documento.tipo}}. Las personas que firman reciben su enlace de firma.',
  ),
  ASSET_REQUEST_EXPIRED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}} vencida',
    'Solicitud de activos vencida',
    'La solicitud venció el {{solicitud.vencio}} sin que Control Interno generara el documento. Los activos elegidos quedaron libres.',
  ),
  ASSET_REQUEST_COMPLETED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}}: acta {{documento.numero}} firmada',
    'Documento firmado',
    'El acta {{documento.tipo}} N.° {{documento.numero}} de la solicitud quedó firmada por todos.',
    undefined,
    { label: 'Ver el acta', url: '{{documento.url}}' },
  ),
  ASSET_REQUEST_LOAN_SCHEDULED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}}: préstamo programado',
    'Préstamo programado',
    'Control Interno generó el préstamo de la solicitud. Los activos siguen en el centro dueño: se entregan desde el {{prestamo.inicio}}, y al entregarlos se genera el acta de préstamo para firmar.',
  ),
  ASSET_REQUEST_LOAN_STARTS: assetRequestDesign(
    'Solicitud {{solicitud.codigo}}: hoy se entrega el préstamo',
    'Hoy se entrega el préstamo',
    'Desde hoy, {{prestamo.inicio}}, se pueden entregar los activos del préstamo. El jefe del centro dueño o Control Interno registran la entrega en el sistema; ahí se genera el acta para firmar.',
  ),
  ASSET_REQUEST_LOAN_REJECTED: assetRequestDesign(
    'Solicitud {{solicitud.codigo}}: préstamo rechazado',
    'Préstamo rechazado',
    'El préstamo programado de la solicitud se rechazó antes de entregarse. La solicitud quedó cerrada y los activos quedaron libres.',
    { tone: 'warning', text: 'Motivo: {{solicitud.motivo}}' },
  ),
};

const INVENTORY_SAMPLE: Readonly<Record<string, string>> = {
  'user.fullName': 'Juliana Pérez',
  'toma.codigo': 'TF-2026-014',
  'toma.nombre': 'Toma física Talento Humano 2026',
  'toma.alcance': 'Centro de costo 3060 · Talento Humano',
  'toma.inicio': '19 de octubre de 2026',
  'toma.fin': '23 de octubre de 2026',
  'toma.responsable': 'Carolina Gómez',
  'centro.codigo': '3060',
  'centro.nombre': 'Talento Humano',
  'app.loginUrl': 'http://localhost:4200',
  'app.name': 'Control Interno UNAC',
};

const ASSET_REQUEST_SAMPLE: Readonly<Record<string, string>> = {
  'user.fullName': 'Juliana Pérez',
  'solicitud.codigo': 'SOL-2026-0007',
  'solicitud.tipo': 'Préstamo temporal',
  'solicitud.centroSolicitante': '3060 · Talento Humano',
  'solicitud.centroDueno': '2010 · Sistemas',
  'solicitud.url': 'http://localhost:4200/asset-requests/ejemplo',
  'solicitud.descripcion': 'Dos portátiles para la inducción de personal nuevo',
  'solicitud.solicitante': 'Carolina Gómez',
  'app.loginUrl': 'http://localhost:4200',
  'app.name': 'Control Interno UNAC',
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
    INVENTORY_SCHEDULED: { ...INVENTORY_SAMPLE },
    INVENTORY_RESCHEDULED: {
      ...INVENTORY_SAMPLE,
      'toma.inicioAnterior': '5 de octubre de 2026',
      'toma.finAnterior': '9 de octubre de 2026',
      'toma.motivo': 'Coincide con el cierre contable',
    },
    INVENTORY_REMINDER: { ...INVENTORY_SAMPLE, 'recordatorio.cuando': 'en 15 días', 'recordatorio.dias': '15' },
    INVENTORY_CANCELLED: { ...INVENTORY_SAMPLE, 'toma.motivo': 'Se hará dentro de la toma general de la sede' },
    ASSET_REQUEST_CREATED: { ...ASSET_REQUEST_SAMPLE },
    ASSET_REQUEST_ACCEPTED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.activos': '2' },
    ASSET_REQUEST_CLOSED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.motivo': 'Los equipos están comprometidos para el semestre' },
    ASSET_REQUEST_RETURNED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.motivo': 'Falta la fecha real de inicio del préstamo' },
    ASSET_REQUEST_CORRECTED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.estado': 'Control Interno' },
    ASSET_REQUEST_CANCELLED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.motivo': 'Ya no se necesitan los equipos' },
    ASSET_REQUEST_GENERATED: { ...ASSET_REQUEST_SAMPLE, 'documento.tipo': 'Préstamo de activos (OCI-01-65)' },
    ASSET_REQUEST_EXPIRED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.vencio': '12 de octubre de 2026' },
    ASSET_REQUEST_LOAN_SCHEDULED: { ...ASSET_REQUEST_SAMPLE, 'prestamo.inicio': '12 de octubre de 2026' },
    ASSET_REQUEST_LOAN_STARTS: { ...ASSET_REQUEST_SAMPLE, 'prestamo.inicio': '12 de octubre de 2026' },
    ASSET_REQUEST_LOAN_REJECTED: { ...ASSET_REQUEST_SAMPLE, 'solicitud.motivo': 'Los equipos se necesitan para el cierre del semestre' },
    ASSET_REQUEST_COMPLETED: {
      ...ASSET_REQUEST_SAMPLE,
      'documento.tipo': 'Préstamo de activos (OCI-01-65)',
      'documento.numero': '0104',
      'documento.url': 'http://localhost:4200/documents/ejemplo',
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
