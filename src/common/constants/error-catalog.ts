import type { ResponseAction } from '../types/response-envelope.type.js';
import { ErrorCode } from './error-code.enum.js';

export interface ErrorCatalogEntry {
  readonly httpStatus: number;
  readonly action: ResponseAction;
  readonly message: string;
}

export const ERROR_CATALOG: Readonly<Record<ErrorCode, ErrorCatalogEntry>> = {
  [ErrorCode.ValidationFailed]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La entrada no pasó validación',
  },
  [ErrorCode.MalformedRequest]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El formato del request es inválido',
  },
  [ErrorCode.Unauthorized]: {
    httpStatus: 401,
    action: 'REAUTH',
    message: 'Token ausente o inválido',
  },
  [ErrorCode.TokenExpired]: {
    httpStatus: 401,
    action: 'REAUTH',
    message: 'La sesión expiró',
  },
  [ErrorCode.InsufficientPermissions]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No tienes permisos para esta acción',
  },
  [ErrorCode.OutOfScope]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'El recurso está fuera de tu ámbito de responsabilidad',
  },
  [ErrorCode.ResourceNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'El recurso solicitado no existe',
  },
  [ErrorCode.InvalidState]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El estado del recurso no permite esta operación',
  },
  [ErrorCode.ConcurrentModification]: {
    httpStatus: 409,
    action: 'RETRY',
    message: 'Otra operación modificó el recurso; recarga y reintenta',
  },
  [ErrorCode.TooManyAttempts]: {
    httpStatus: 429,
    action: 'RETRY',
    message: 'Demasiados intentos; espera antes de reintentar',
  },
  [ErrorCode.ExternalServiceFailure]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'Un servicio externo no respondió correctamente',
  },
  [ErrorCode.InternalError]: {
    httpStatus: 500,
    action: 'CONTACT_SUPPORT',
    message: 'Ocurrió un error inesperado',
  },
  [ErrorCode.InvalidCredentials]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'Usuario o contraseña incorrectos',
  },
  [ErrorCode.UserSuspended]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'La cuenta está suspendida',
  },
  [ErrorCode.UserInactive]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'La cuenta está inactiva',
  },
  [ErrorCode.MfaRequired]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'Se requiere código MFA',
  },
  [ErrorCode.MfaCodeInvalid]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'El código MFA es incorrecto',
  },
  [ErrorCode.PasswordPolicyViolation]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La contraseña no cumple la política',
  },
  [ErrorCode.UsernameAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El nombre de usuario ya está en uso',
  },
  [ErrorCode.PersonDocumentAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una persona con ese documento',
  },
  [ErrorCode.PersonEmailAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una persona con ese correo institucional',
  },
  [ErrorCode.PasswordResetInvalid]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'El enlace de restablecimiento es inválido o expiró',
  },
  [ErrorCode.PasswordChangeRequired]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Debes actualizar tu contraseña temporal antes de continuar',
  },
  [ErrorCode.RoleNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'El rol solicitado no existe',
  },
  [ErrorCode.RoleNotAssignable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El rol no puede asignarse directamente',
  },
  [ErrorCode.RoleMaxUsersReached]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Se alcanzó el número máximo de usuarios para el rol',
  },
  [ErrorCode.RoleCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un rol con ese código',
  },
  [ErrorCode.RoleHasAssignedUsers]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El rol tiene usuarios asignados; no se elimina',
  },
  [ErrorCode.RoleSystemImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Los roles de sistema no permiten cambiar código ni nombre',
  },
  [ErrorCode.RolePrivilegeEscalation]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No puedes administrar un rol igual o superior al tuyo',
  },
  [ErrorCode.PermissionNotHeld]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Solo puedes conceder permisos que ya tienes',
  },
  [ErrorCode.PermissionCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un permiso con ese código o combinación recurso/acción/alcance',
  },
  [ErrorCode.PermissionInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El permiso está asignado a un rol; quítalo antes de eliminarlo',
  },
  [ErrorCode.PermissionSystemImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Los permisos de sistema no se eliminan; se administran desde el rol',
  },
  [ErrorCode.NavigationPathAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un menú con esa ruta',
  },
  [ErrorCode.SodViolation]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Asignación viola separación de funciones',
  },
  [ErrorCode.DelegationRequiresExpiry]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La delegación requiere fecha de vencimiento',
  },
  [ErrorCode.CannotDelegateRoleNotHeld]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No puedes delegar un rol que no posees',
  },
  [ErrorCode.PersonAffiliationRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El usuario debe adscribirse a un departamento o a un centro de costo',
  },
  [ErrorCode.CostCenterOrgUnitMismatch]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El centro de costo no pertenece a ese departamento',
  },
  [ErrorCode.MailNotConfigured]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Configure el SMTP en Correo antes de enviar invitaciones',
  },
  [ErrorCode.MailSendFailed]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'No se pudo enviar el correo; revisa la configuración SMTP',
  },
  [ErrorCode.HasActiveLoans]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El usuario tiene préstamos activos como responsable',
  },
  [ErrorCode.HasDependentEntities]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El recurso tiene entidades dependientes; no se elimina',
  },
  [ErrorCode.CampusCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un campus con ese código',
  },
  [ErrorCode.BuildingCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un edificio con ese código en el campus',
  },
  [ErrorCode.LocationCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una ubicación con ese código en el edificio',
  },
  [ErrorCode.OrgUnitCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una unidad organizacional con ese código',
  },
  [ErrorCode.OrgUnitHasChildren]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La unidad tiene sub-unidades activas',
  },
  [ErrorCode.OrgUnitCycle]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La jerarquía organizacional no puede formar un ciclo',
  },
  [ErrorCode.CostCenterExternalCodeExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un centro con ese código externo',
  },
  [ErrorCode.CostCenterHasActiveAssets]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No puede desactivarse: tiene activos asignados',
  },
  [ErrorCode.CostCenterExternalCodeImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código externo del centro de costo no se puede modificar',
  },
  [ErrorCode.InvalidCsv]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo CSV es inválido o no tiene el formato esperado',
  },
  [ErrorCode.CategoryCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una categoría con ese código',
  },
  [ErrorCode.CategoryHasChildren]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La categoría tiene subcategorías activas',
  },
  [ErrorCode.CategoryCycle]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La jerarquía de categorías no puede formar un ciclo',
  },
  [ErrorCode.AssetCategoryHasAssets]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La categoría tiene activos asociados; no se elimina',
  },
  [ErrorCode.DynamicFieldCodeExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un campo con ese código en la categoría',
  },
  [ErrorCode.DynamicFieldInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El campo tiene datos en activos; se debe deprecar, no eliminar',
  },
  [ErrorCode.DynamicFieldTypeImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El tipo de un campo dinámico no se puede cambiar',
  },
  [ErrorCode.InvalidFieldDefinition]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La definición del campo dinámico no es válida',
  },
  [ErrorCode.AssetInternalCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código interno ya existe',
  },
  [ErrorCode.AssetBarcodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código de barras ya está registrado',
  },
  [ErrorCode.AssetSerialRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La categoría exige número de serie',
  },
  [ErrorCode.AssetPhotoRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La categoría exige fotografía del activo',
  },
  [ErrorCode.AssetAlreadyWrittenOff]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo ya fue dado de baja',
  },
  [ErrorCode.AssetCannotBeModified]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo no puede modificarse en su estado actual',
  },
  [ErrorCode.AssetMissingCustomField]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Falta un campo dinámico requerido',
  },
  [ErrorCode.AssetInvalidDynamicValue]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El valor de un campo dinámico no es válido',
  },
  [ErrorCode.AssetHasActiveLoan]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo tiene un préstamo activo',
  },
  [ErrorCode.AssetUnderInventory]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo está en una toma física en curso',
  },
  [ErrorCode.AssetInvalidStatusTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La transición de estado operacional no es válida',
  },
  [ErrorCode.AssetImportExpired]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La previsualización de importación expiró',
  },
  [ErrorCode.AssetImportTooLarge]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo supera el máximo de 5000 filas',
  },
  [ErrorCode.QrTokenInvalid]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El QR es inválido o fue alterado',
  },
  [ErrorCode.QrVersionMismatch]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El QR está desactualizado; solicita reimpresión',
  },
  [ErrorCode.QrAssetNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'El activo asociado al QR no existe',
  },
  [ErrorCode.QrAssetWrittenOff]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo fue dado de baja',
  },
  [ErrorCode.FileTooLarge]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo excede el tamaño máximo permitido',
  },
  [ErrorCode.FileTypeNotAllowed]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El tipo de archivo no está permitido',
  },
  [ErrorCode.StorageUnavailable]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'Almacenamiento no disponible; reintenta en un momento',
  },
  [ErrorCode.StorageNotConfigured]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El proveedor de almacenamiento no está configurado',
  },
  [ErrorCode.StorageOauthRequired]: {
    httpStatus: 406,
    action: 'RETRY',
    message:
      'Guarda Client ID y Secret, y conecta la cuenta con OAuth antes de activar Drive u OneDrive',
  },
  [ErrorCode.StorageOauthFailed]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'No se pudo completar la conexión con Drive u OneDrive',
  },
  [ErrorCode.TemplateUnknownPlaceholder]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La plantilla usa un campo que no pertenece al catálogo',
  },
  [ErrorCode.TemplateMissingPlaceholder]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Faltan campos requeridos en la plantilla Word',
  },
  [ErrorCode.TemplateInvalidDocx]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo Word está dañado o no es un .docx válido',
  },
  [ErrorCode.TemplateNotActive]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No hay plantilla activa para este tipo de documento',
  },
  [ErrorCode.AssetAlreadyLoaned]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo ya está en un préstamo activo',
  },
  [ErrorCode.InvalidLoanStateTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La transición de estado del préstamo no es válida',
  },
  [ErrorCode.LoanSodViolation]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Quien solicita no puede aprobar el mismo préstamo',
  },
  [ErrorCode.LoanSameCostCenter]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El centro de destino debe ser distinto al de origen',
  },
  [ErrorCode.MovementTampered]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La firma del movimiento no coincide; posible manipulación',
  },
  [ErrorCode.DocumentTampered]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'El PDF almacenado no coincide con el que se firmó; posible alteración',
  },
  [ErrorCode.SignatureOutOfOrder]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Todavía no es el turno de este firmante',
  },
  [ErrorCode.SignatureNotDesignatedSigner]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Este turno de firma está asignado a otra persona',
  },
  [ErrorCode.SignatureSignerUnassigned]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Este turno de firma no tiene persona asignada; quien administra el proceso debe asignarla',
  },
  [ErrorCode.SignatureMfaRequired]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Para firmar debe tener la verificación en dos pasos activa',
  },
  [ErrorCode.SignatureSessionInvalid]: {
    httpStatus: 403,
    action: 'REAUTH',
    message: 'La sesión ya no está vigente; inicie sesión de nuevo para firmar',
  },
  [ErrorCode.SignatureReassignAfterSigning]: {
    httpStatus: 409,
    action: 'CANCEL',
    message:
      'El acta ya tiene firmas: cambiar un firmante alteraría lo que otros firmaron. Rechace el acta y genere una nueva',
  },
  [ErrorCode.HandoverAssetInOpenHandover]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo ya está en otra entrega abierta; espere a que su acta se firme o se rechace',
  },
  [ErrorCode.HandoverCostCenterMismatch]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo pertenece a otro centro de costo: entregarlo en este centro sería un traslado (OCI-17-89)',
  },
  [ErrorCode.HandoverAssetNotDeliverable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo está dado de baja o en préstamo y no se puede entregar',
  },
  [ErrorCode.InventoryScopeOverlap]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya hay una toma física abierta que se solapa con este alcance',
  },
  [ErrorCode.InventoryUnverifiedExceedsThreshold]: {
    httpStatus: 406,
    action: 'CANCEL',
    message:
      'Más del 5% de activos siguen sin verificar; se requiere cierre autorizado',
  },
  [ErrorCode.InventoryReconcileSod]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Quien solicita la reconciliación no puede aprobarla',
  },
  [ErrorCode.DepreciationInvalidPeriod]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El período de depreciación no es válido',
  },
  [ErrorCode.ModuleUnavailable]: {
    httpStatus: 503,
    action: 'CANCEL',
    message: 'Este módulo no está disponible en este momento',
  },
  [ErrorCode.FeatureUnknown]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'El módulo indicado no existe',
  },
  [ErrorCode.FeatureNotToggleable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este módulo no se puede activar o desactivar',
  },
};
