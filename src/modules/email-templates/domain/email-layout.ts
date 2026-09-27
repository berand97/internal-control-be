/**
 * Identidad fija de todos los correos: encabezado institucional, colores y pie. Cada plantilla define solo su
 * contenido (asunto + bloques); esto no es editable desde la pantalla.
 *
 * Colores: la paleta institucional del frontend (frontend/src/styles.css, "venice-blue"), en hexadecimal porque los
 * clientes de correo no entienden variables CSS ni oklch.
 *
 * Logo: MAIL_BRAND_LOGO_URL (https, imagen PNG o JPG; Gmail y Outlook no muestran SVG). Sin él, el encabezado
 * muestra el nombre de la marca (MAIL_BRAND_NAME, por defecto "Control Interno UNAC") como texto.
 */
export const EMAIL_COLORS = {
  pageBackground: '#f3f7fc',
  cardBackground: '#ffffff',
  headerBackground: '#233e57',
  headerText: '#ffffff',
  text: '#17283a',
  mutedText: '#2a5983',
  border: '#cadded',
  accent: '#306999',
  accentText: '#ffffff',
  infoBackground: '#e7eff7',
  infoBorder: '#4184b6',
  warningBackground: '#fdf3e1',
  warningBorder: '#c98a1a',
} as const;

export const EMAIL_FONT_STACK = "Arial, 'Helvetica Neue', Helvetica, sans-serif";

export const EMAIL_CONTENT_WIDTH = 600;

export interface EmailBrand {
  /** Nombre visible en el encabezado (si no hay logo), en el alt del logo y en el pie. */
  readonly name: string;
  /** URL https del logo (PNG/JPG); null muestra el nombre como texto. */
  readonly logoUrl: string | null;
}

export const DEFAULT_EMAIL_BRAND: EmailBrand = { name: 'Control Interno UNAC', logoUrl: null };

export const EMAIL_FOOTER_TEXT = (brandName: string): string =>
  `Mensaje automático enviado por ${brandName}.`;
