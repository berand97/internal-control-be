export const EMAIL_TEMPLATE_TYPES = [
  'USER_INVITATION',
  'PASSWORD_RESET',
  'GENERIC_NOTIFICATION',
  'SYSTEM_ALERT',
  'LOAN_STATUS_NOTIFICATION',
  'INVENTORY_ALERT',
] as const;

export type EmailTemplateType = (typeof EMAIL_TEMPLATE_TYPES)[number];

export const EMAIL_TEMPLATE_LABEL: Record<EmailTemplateType, string> = {
  USER_INVITATION: 'Invitación de usuario',
  PASSWORD_RESET: 'Restablecer contraseña',
  GENERIC_NOTIFICATION: 'Notificación general',
  SYSTEM_ALERT: 'Alerta del sistema',
  LOAN_STATUS_NOTIFICATION: 'Aviso de préstamo',
  INVENTORY_ALERT: 'Alerta de toma física',
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
};

export interface EmailTemplateDraft {
  readonly subject: string;
  readonly body: string;
}

export const DEFAULT_EMAIL_TEMPLATES: Record<EmailTemplateType, EmailTemplateDraft> =
  {
    USER_INVITATION: {
      subject: 'Invitación a {{app.name}}',
      body: [
        'Se creó su cuenta en {{app.name}}.',
        '',
        'Rol: {{user.role}}',
        'Correo: {{user.email}}',
        'Usuario: {{user.username}}',
        'Contraseña temporal: {{auth.temporaryPassword}}',
        '',
        'Inicie sesión en {{auth.loginUrl}} y cambie la contraseña.',
      ].join('\n'),
    },
    PASSWORD_RESET: {
      subject: 'Restablecer contraseña — {{app.name}}',
      body: [
        'Hola {{user.email}},',
        '',
        'Use este enlace para restablecer su contraseña:',
        '{{auth.resetUrl}}',
        '',
        'El enlace vence en {{auth.expiresInHours}} horas.',
      ].join('\n'),
    },
    GENERIC_NOTIFICATION: {
      subject: '{{notification.title}} — {{app.name}}',
      body: 'Hola {{user.email}},\n\n{{notification.message}}\n\n{{app.loginUrl}}',
    },
    SYSTEM_ALERT: {
      subject: '[{{alert.severity}}] {{alert.title}}',
      body: '{{alert.message}}',
    },
    LOAN_STATUS_NOTIFICATION: {
      subject: 'Préstamo {{prestamo.estado}}',
      body: [
        'Hola {{user.email}},',
        'El préstamo cambió a {{prestamo.estado}}.',
        'Justificación: {{prestamo.justificacion}}',
        '{{app.loginUrl}}',
      ].join('\n'),
    },
    INVENTORY_ALERT: {
      subject: 'Toma física: {{inventario.nombre}}',
      body: 'Hola {{user.email}},\n{{alerta.mensaje}}\n{{app.loginUrl}}',
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
  };

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export const extractEmailPlaceholders = (text: string): ReadonlyArray<string> => {
  const matches = text.matchAll(TOKEN_PATTERN);
  return [...new Set([...matches].map((match) => match[1] ?? ''))].filter(
    (item) => item !== '',
  );
};

export const allowedEmailPlaceholders = (
  type: EmailTemplateType,
): ReadonlySet<string> => {
  const catalog = EMAIL_PLACEHOLDER_CATALOG[type];
  return new Set([...catalog.required, ...catalog.optional]);
};

export const renderEmailText = (
  template: string,
  context: Record<string, string>,
): string =>
  template.replace(TOKEN_PATTERN, (_full, token: string) => context[token] ?? '');

export const isEmailTemplateType = (value: string): value is EmailTemplateType =>
  EMAIL_TEMPLATE_TYPES.some((item) => item === value);
