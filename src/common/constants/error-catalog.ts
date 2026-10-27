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
    message: 'Revise los datos del formulario.',
  },
  [ErrorCode.MalformedRequest]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'No pudimos leer los datos enviados. Intente de nuevo.',
  },
  [ErrorCode.Unauthorized]: {
    httpStatus: 401,
    action: 'REAUTH',
    message: 'Inicie sesión para continuar.',
  },
  [ErrorCode.TokenExpired]: {
    httpStatus: 401,
    action: 'REAUTH',
    message: 'Su sesión expiró. Inicie sesión de nuevo.',
  },
  [ErrorCode.InsufficientPermissions]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No tiene permiso para hacer esto.',
  },
  [ErrorCode.OutOfScope]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Este registro no está a su cargo.',
  },
  [ErrorCode.ResourceNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'No encontramos lo que busca.',
  },
  [ErrorCode.InvalidState]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No se puede hacer esto en el estado actual.',
  },
  [ErrorCode.ConcurrentModification]: {
    httpStatus: 409,
    action: 'RETRY',
    message: 'Alguien más cambió este registro. Recargue e intente de nuevo.',
  },
  [ErrorCode.TooManyAttempts]: {
    httpStatus: 429,
    action: 'RETRY',
    message: 'Demasiados intentos. Espere un momento e intente de nuevo.',
  },
  [ErrorCode.AccountTemporarilyLocked]: {
    httpStatus: 429,
    action: 'RETRY',
    message: 'Demasiados intentos fallidos. La cuenta quedó bloqueada por un rato. Intente más tarde.',
  },
  [ErrorCode.SessionRevoked]: {
    httpStatus: 401,
    action: 'REAUTH',
    message: 'Su sesión se cerró. Inicie sesión de nuevo.',
  },
  [ErrorCode.InvitationExpired]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'La invitación venció. Pida a un administrador que se la reenvíe.',
  },
  [ErrorCode.DelegationExceedsSourceValidity]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La delegación no puede vencer después que el rol original.',
  },
  [ErrorCode.ExternalServiceFailure]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'Un servicio externo no respondió. Intente de nuevo.',
  },
  [ErrorCode.InternalError]: {
    httpStatus: 500,
    action: 'CONTACT_SUPPORT',
    message: 'Ocurrió un error inesperado.',
  },
  [ErrorCode.InvalidCredentials]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'Usuario o contraseña incorrectos.',
  },
  [ErrorCode.UserSuspended]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'La cuenta está suspendida.',
  },
  [ErrorCode.UserInactive]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'La cuenta está inactiva.',
  },
  [ErrorCode.MfaRequired]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'Escriba el código de verificación en dos pasos.',
  },
  [ErrorCode.MfaCodeInvalid]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'El código de verificación es incorrecto.',
  },
  [ErrorCode.MfaVerificationFailed]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'El código no es válido o ya se usó.',
  },
  [ErrorCode.MfaSessionRequired]: {
    httpStatus: 403,
    action: 'REAUTH',
    message: 'Cierre sesión e ingrese de nuevo con su código de verificación en dos pasos.',
  },
  [ErrorCode.MfaRequiredByRole]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Su rol exige la verificación en dos pasos. No puede desactivarla.',
  },
  [ErrorCode.MfaNotEnabled]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'La verificación en dos pasos no está activa en esta cuenta.',
  },
  [ErrorCode.MfaEnrollmentNotStarted]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'La activación venció o no ha empezado. Empiece de nuevo.',
  },
  [ErrorCode.MfaSelfResetForbidden]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No puede restablecer su propia verificación en dos pasos. Pídalo a otro administrador.',
  },
  [ErrorCode.PasswordPolicyViolation]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La contraseña no cumple los requisitos.',
  },
  [ErrorCode.UsernameAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ese nombre de usuario ya está en uso.',
  },
  [ErrorCode.PersonDocumentAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una persona con ese documento.',
  },
  [ErrorCode.PersonEmailAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una persona con ese correo institucional.',
  },
  [ErrorCode.PasswordResetInvalid]: {
    httpStatus: 401,
    action: 'CANCEL',
    message: 'El enlace para cambiar la contraseña no es válido o venció.',
  },
  [ErrorCode.PasswordChangeRequired]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Cambie su contraseña temporal para continuar.',
  },
  [ErrorCode.RoleNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'Ese rol no existe.',
  },
  [ErrorCode.RoleNotAssignable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este rol no se puede asignar directamente.',
  },
  [ErrorCode.RoleMaxUsersReached]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El rol ya tiene el máximo de usuarios.',
  },
  [ErrorCode.RoleCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un rol con ese código.',
  },
  [ErrorCode.RoleHasAssignedUsers]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El rol tiene usuarios asignados. Quíteselos antes de eliminarlo.',
  },
  [ErrorCode.RoleHasChildRoles]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Otros roles heredan de este. Quíteles la herencia o elimínelos primero.',
  },
  [ErrorCode.RoleSelfAssignmentForbidden]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No puede asignarse roles ni permisos a sí mismo. Pídalo a otro administrador.',
  },
  [ErrorCode.RoleSystemImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código y el nombre de un rol del sistema no se pueden cambiar.',
  },
  [ErrorCode.RolePrivilegeEscalation]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'No puede administrar un rol igual o superior al suyo.',
  },
  [ErrorCode.PermissionNotHeld]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Solo puede conceder permisos que usted tiene.',
  },
  [ErrorCode.PermissionCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un permiso igual.',
  },
  [ErrorCode.PermissionInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El permiso está asignado a un rol. Quíteselo antes de eliminarlo.',
  },
  [ErrorCode.PermissionSystemImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Los permisos del sistema no se eliminan. Adminístrelos desde el rol.',
  },
  [ErrorCode.NavigationPathAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un menú con esa ruta.',
  },
  [ErrorCode.SodViolation]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Esta asignación junta funciones que deben estar separadas.',
  },
  [ErrorCode.DelegationRequiresExpiry]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Indique hasta cuándo dura la delegación.',
  },
  [ErrorCode.CannotDelegateRoleNotHeld]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No puede delegar un rol que usted no tiene.',
  },
  [ErrorCode.PersonAffiliationRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Elija una dependencia o un centro de costo para el usuario.',
  },
  [ErrorCode.CostCenterOrgUnitMismatch]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Ese centro de costo no es de esa dependencia.',
  },
  [ErrorCode.MailNotConfigured]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Configure el servidor de correo antes de enviar invitaciones.',
  },
  [ErrorCode.MailSendFailed]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'No se pudo enviar el correo. Revise la configuración del servidor de correo.',
  },
  [ErrorCode.HasActiveLoans]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El usuario tiene préstamos activos a su cargo.',
  },
  [ErrorCode.HasDependentEntities]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este registro tiene otros registros asociados. No se puede eliminar.',
  },
  [ErrorCode.CampusCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una sede con ese código.',
  },
  [ErrorCode.BuildingCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un edificio con ese código en la sede.',
  },
  [ErrorCode.LocationCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una ubicación con ese código en el edificio.',
  },
  [ErrorCode.OrgUnitCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ese código interno ya está en uso.',
  },
  [ErrorCode.OrgUnitHasChildren]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Tiene dependencias activas debajo. Muévalas o archívelas primero.',
  },
  [ErrorCode.OrgUnitCycle]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Una dependencia no puede quedar debajo de sí misma.',
  },
  [ErrorCode.CostCenterExternalCodeExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un centro de costo con ese código.',
  },
  [ErrorCode.CostCenterHasActiveAssets]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Tiene activos asignados. No se puede desactivar.',
  },
  [ErrorCode.CostCenterExternalCodeImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código del centro de costo no se puede cambiar.',
  },
  [ErrorCode.InvalidCsv]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo CSV no tiene el formato esperado.',
  },
  [ErrorCode.CategoryCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una categoría con ese código.',
  },
  [ErrorCode.CategoryHasChildren]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La categoría tiene subcategorías activas.',
  },
  [ErrorCode.CategoryCycle]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Una categoría no puede quedar debajo de sí misma.',
  },
  [ErrorCode.AssetCategoryHasAssets]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La categoría tiene activos. No se puede eliminar.',
  },
  [ErrorCode.DynamicFieldCodeExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un campo con ese código en la categoría.',
  },
  [ErrorCode.DynamicFieldInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Algunos activos tienen datos en este campo. Márquelo como obsoleto en lugar de eliminarlo.',
  },
  [ErrorCode.DynamicFieldTypeImmutable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El tipo de un campo no se puede cambiar.',
  },
  [ErrorCode.InvalidFieldDefinition]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La configuración del campo no es válida.',
  },
  [ErrorCode.AssetInternalCodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ese código interno ya existe.',
  },
  [ErrorCode.AssetBarcodeAlreadyExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ese código de barras ya está registrado.',
  },
  [ErrorCode.AssetSerialRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Esta categoría exige número de serie.',
  },
  [ErrorCode.AssetPhotoRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Esta categoría exige una foto del activo.',
  },
  [ErrorCode.AssetAlreadyWrittenOff]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo ya fue dado de baja.',
  },
  [ErrorCode.AssetCannotBeModified]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo no se puede modificar en su estado actual.',
  },
  [ErrorCode.AssetMissingCustomField]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Falta un campo obligatorio de la categoría.',
  },
  [ErrorCode.AssetInvalidDynamicValue]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Un campo de la categoría tiene un valor no válido.',
  },
  [ErrorCode.AssetHasActiveLoan]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo tiene un préstamo activo.',
  },
  [ErrorCode.AssetUnderInventory]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo está en una toma física en curso.',
  },
  [ErrorCode.AssetInvalidStatusTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo no puede pasar a ese estado.',
  },
  [ErrorCode.AssetImportExpired]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La vista previa venció. Vuelva a subir el archivo.',
  },
  [ErrorCode.AssetImportTooLarge]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo tiene más de 5000 filas. Divídalo en varios.',
  },
  [ErrorCode.QrTokenInvalid]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El código QR no es válido.',
  },
  [ErrorCode.QrVersionMismatch]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El código QR está desactualizado. Pida que lo reimpriman.',
  },
  [ErrorCode.QrAssetNotFound]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'No encontramos el activo de este código QR.',
  },
  [ErrorCode.QrAssetWrittenOff]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo fue dado de baja.',
  },
  [ErrorCode.FileTooLarge]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo es demasiado grande.',
  },
  [ErrorCode.FileTypeNotAllowed]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Ese tipo de archivo no está permitido.',
  },
  [ErrorCode.StorageUnavailable]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'El almacenamiento no está disponible. Intente de nuevo en un momento.',
  },
  [ErrorCode.StorageNotConfigured]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El almacenamiento de archivos no está configurado.',
  },
  [ErrorCode.StorageOauthRequired]: {
    httpStatus: 406,
    action: 'RETRY',
    message: 'Guarde el Client ID y el Secret y conecte la cuenta antes de activar Drive u OneDrive.',
  },
  [ErrorCode.StorageOauthFailed]: {
    httpStatus: 424,
    action: 'RETRY',
    message: 'No se pudo conectar con Drive u OneDrive.',
  },
  [ErrorCode.TemplateUnknownPlaceholder]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La plantilla usa un campo que no existe.',
  },
  [ErrorCode.TemplateMissingPlaceholder]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Faltan campos obligatorios en la plantilla Word.',
  },
  [ErrorCode.TemplateInvalidDocx]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo Word está dañado o no es un .docx.',
  },
  [ErrorCode.TemplateNotActive]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'No hay una plantilla activa para este tipo de documento.',
  },
  [ErrorCode.EmailTemplateInvalidDesign]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El diseño del correo tiene errores. Revise los bloques marcados.',
  },
  [ErrorCode.EmailTemplateUnknownVariable]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El correo usa una variable que no existe para este tipo de correo.',
  },
  [ErrorCode.EmailTemplateMissingVariable]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Faltan variables obligatorias en el correo.',
  },
  [ErrorCode.EmailAssetInvalidImage]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La imagen está dañada o es demasiado grande.',
  },
  [ErrorCode.PublicAssetsNotConfigured]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Para usar imágenes en los correos, configure en Almacenamiento el bucket público y su URL.',
  },
  [ErrorCode.AssetAlreadyLoaned]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo ya está prestado.',
  },
  [ErrorCode.InvalidLoanStateTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El préstamo no admite esa acción en su estado actual.',
  },
  [ErrorCode.LoanSodViolation]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Quien pide el préstamo no puede aprobarlo.',
  },
  [ErrorCode.LoanSameCostCenter]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El centro de destino debe ser distinto al de origen.',
  },
  [ErrorCode.MovementTampered]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La firma del movimiento no coincide. El registro pudo ser alterado.',
  },
  [ErrorCode.DocumentTampered]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'El PDF guardado no coincide con el que se firmó. Pudo ser alterado.',
  },
  [ErrorCode.SignatureOutOfOrder]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Todavía no es el turno de este firmante.',
  },
  [ErrorCode.SignatureNotDesignatedSigner]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Este turno de firma es de otra persona.',
  },
  [ErrorCode.SignatureSignerUnassigned]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Este turno de firma no tiene a nadie asignado. Pida a quien administra el proceso que lo asigne.',
  },
  [ErrorCode.SignatureMfaRequired]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Active la verificación en dos pasos para poder firmar.',
  },
  [ErrorCode.SignatureSessionInvalid]: {
    httpStatus: 403,
    action: 'REAUTH',
    message: 'Su sesión ya no está vigente. Inicie sesión de nuevo para firmar.',
  },
  [ErrorCode.SignatureReassignAfterSigning]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El acta ya tiene firmas y no se puede cambiar el firmante. Rechace el acta y genere una nueva.',
  },
  [ErrorCode.SignatureNoChannel]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'La persona de este turno no tiene cómo firmar. Pida a quien administra el proceso que reasigne el turno.',
  },
  [ErrorCode.SignatureNoIdentityCheck]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'La persona de este turno no tiene documento registrado. Regístrelo o reasigne el turno.',
  },
  [ErrorCode.SignatureSignerInactive]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'La persona de este turno está inactiva. Pida a quien administra el proceso que reasigne el turno.',
  },
  [ErrorCode.SignatureSignerCannotSign]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esta persona no puede firmar este turno.',
  },
  [ErrorCode.SignatureLinkNotApplicable]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Este turno no se firma por correo o no es el turno actual del acta.',
  },
  [ErrorCode.SignatureLinkUnavailable]: {
    httpStatus: 410,
    action: 'CANCEL',
    message: 'El enlace de firma ya no sirve. Pida a quien administra el proceso que se lo reenvíe.',
  },
  [ErrorCode.SignatureIdentityMismatch]: {
    httpStatus: 403,
    action: 'RETRY',
    message: 'Los dígitos no coinciden con el documento.',
  },
  [ErrorCode.SignatureIdentityLocked]: {
    httpStatus: 410,
    action: 'CANCEL',
    message: 'Se agotaron los intentos y el enlace ya no sirve. Pida a quien administra el proceso que se lo reenvíe.',
  },
  [ErrorCode.SignatureIdentityRequired]: {
    httpStatus: 403,
    action: 'RETRY',
    message: 'Confirme su identidad antes de firmar o rechazar.',
  },
  [ErrorCode.DocumentAlreadySigned]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'El acta ya está firmada y no se puede anular.',
  },
  [ErrorCode.HandoverAssetInOpenHandover]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo está en otra entrega abierta. Espere a que su acta se firme o se rechace.',
  },
  [ErrorCode.HandoverCostCenterMismatch]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo es de otro centro de costo. Para moverlo use un traslado.',
  },
  [ErrorCode.HandoverAssetNotDeliverable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo está dado de baja o prestado. No se puede entregar.',
  },
  [ErrorCode.HandoverAssetReserved]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo está en un préstamo, una solicitud, un traslado o una baja abierta. Espere a que termine para entregarlo.',
  },
  [ErrorCode.DocumentFormatNotReady]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'El formato de esta acta aún no está listo. Falta el código SGC o los firmantes.',
  },
  [ErrorCode.DocumentFormatAlreadyExists]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ya existe un formato con esa clave.',
  },
  [ErrorCode.DocumentFormatBreaksProcess]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esta versión quita firmantes que el proceso necesita para generar el acta.',
  },
  [ErrorCode.DocumentFormatSequenceStarted]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ya se emitieron actas en ese periodo. El consecutivo inicial no se puede cambiar.',
  },
  [ErrorCode.DocumentSignerDuplicated]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Una persona no puede firmar dos veces la misma acta. Cambie el firmante o indique un sustituto para Control Interno.',
  },
  [ErrorCode.DocumentSignerSubstituteInvalid]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Ese sustituto no es válido. Debe tener usuario activo, permiso para firmar por Control Interno y no firmar otra parte del acta.',
  },
  [ErrorCode.DocumentSignerNotEligible]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Esta persona no puede firmar por Control Interno. Necesita usuario activo y permiso para hacerlo.',
  },
  [ErrorCode.TransferSameCostCenter]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El centro de costo de destino debe ser distinto al de origen.',
  },
  [ErrorCode.TransferMixedSourceCostCenter]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Todos los activos del traslado deben ser del mismo centro de costo.',
  },
  [ErrorCode.TransferAssetInOpenTransfer]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo ya está en otro traslado abierto.',
  },
  [ErrorCode.TransferInvalidStateTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El traslado no admite esa acción en su estado actual.',
  },
  [ErrorCode.TransferReasonUnavailable]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Ese motivo de traslado no existe o está inactivo.',
  },
  [ErrorCode.TransferReasonExists]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ya existe un motivo de traslado con ese código.',
  },
  [ErrorCode.TransferReasonInUse]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Este motivo ya se usó en traslados. Desactívelo en lugar de eliminarlo.',
  },
  [ErrorCode.TransferNoAccountingSigner]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'Nadie tiene el rol de Contabilidad. Pida a un administrador que lo asigne.',
  },
  [ErrorCode.TransferNoControlSigner]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'Nadie tiene permiso para firmar por Control Interno. Pida a un administrador que lo otorgue.',
  },
  [ErrorCode.TransferSignerNotEligible]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Esta persona no puede firmar ese turno del acta de traslado.',
  },
  [ErrorCode.TransferSignerRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Varias personas pueden firmar ese turno. Elija una.',
  },
  [ErrorCode.WriteOffInvalidStateTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La baja no admite esa acción en su estado actual.',
  },
  [ErrorCode.WriteOffMixedCostCenter]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Todos los activos de la baja deben ser del mismo centro de costo.',
  },
  [ErrorCode.WriteOffAssetHeld]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo está en otro proceso abierto. Espere a que termine para darlo de baja.',
  },
  [ErrorCode.WriteOffNoControlSigner]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'Nadie tiene permiso para firmar por Control Interno. Pida a un administrador que lo otorgue.',
  },
  [ErrorCode.WriteOffSignerRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Varias personas pueden firmar por Control Interno. Elija una.',
  },
  [ErrorCode.AssetInOpenWriteOff]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El activo está en una baja abierta.',
  },
  [ErrorCode.AssetRequestNotHead]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Solo el jefe del centro de costo puede hacer esto en la solicitud.',
  },
  [ErrorCode.AssetRequestOwnerWithoutHead]: {
    httpStatus: 409,
    action: 'CONTACT_SUPPORT',
    message: 'El centro de costo al que pide los activos no tiene jefe. Pida a un administrador que lo asigne.',
  },
  [ErrorCode.AssetRequestSodViolation]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Quien hizo la solicitud no puede decidirla.',
  },
  [ErrorCode.AssetRequestInvalidStateTransition]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'La solicitud no admite esa acción en su estado actual.',
  },
  [ErrorCode.AssetRequestAssetUnavailable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Alguno de los activos elegidos ya no está disponible.',
  },
  [ErrorCode.LoanExtensionNotRequester]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Solo quien pidió el préstamo puede pedir que se extienda.',
  },
  [ErrorCode.LoanNoPendingExtension]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El préstamo no tiene una extensión pendiente.',
  },
  [ErrorCode.LoanDeliveryActNotRejected]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Solo se genera una nueva acta de entrega si la anterior fue rechazada.',
  },
  [ErrorCode.LoanNotStarted]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El préstamo aún no empieza. Entréguelo en la fecha de inicio.',
  },
  [ErrorCode.LoanDeliveryActNotSigned]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El acta de entrega aún no tiene todas las firmas. Espere para registrar la devolución.',
  },
  [ErrorCode.InventoryScopeOverlap]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya hay una toma física en curso con algunos de estos activos.',
  },
  [ErrorCode.InventoryUnverifiedExceedsThreshold]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Más del 5% de los activos siguen sin verificar. El cierre necesita autorización.',
  },
  [ErrorCode.InventoryReconcileSod]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Quien pide la conciliación no puede aprobarla.',
  },
  [ErrorCode.InventoryActorNotAllowed]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Solo el responsable de la toma o quien programa tomas puede hacer esto.',
  },
  [ErrorCode.InventoryConflictOfInterest]: {
    httpStatus: 403,
    action: 'CANCEL',
    message: 'Usted es jefe o custodio de activos de esta toma. No puede ejecutarla, corregirla ni cerrarla.',
  },
  [ErrorCode.InventoryAssetWrittenOff]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo está dado de baja. Si apareció, primero reverse la baja.',
  },
  [ErrorCode.InventoryMissingCauseRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Elija una causa del faltante o escriba otra de 3 a 500 caracteres.',
  },
  [ErrorCode.InventoryCatalogEntryUnavailable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Esa opción no existe o está inactiva.',
  },
  [ErrorCode.InventoryCatalogEntryInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Esta opción ya se usó en una toma. Desactívela en lugar de eliminarla.',
  },
  [ErrorCode.InventoryCatalogEntryExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe una opción con ese código o nombre.',
  },
  [ErrorCode.InventorySurplusWasLost]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este sobrante es un activo que estaba perdido. No se resuelve desde la toma.',
  },
  [ErrorCode.InventorySurplusNotResolvable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este sobrante no se puede registrar como activo.',
  },
  [ErrorCode.InventoryUnassignedSurplus]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Hay sobrantes sin centro de costo. Elija el centro de cada uno o regístrelos como activos antes de conciliar.',
  },
  [ErrorCode.AssetPriceZeroReasonUnavailable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ese motivo de precio cero no existe o está inactivo.',
  },
  [ErrorCode.AssetPriceZeroReasonInUse]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este motivo ya se usó en activos. Desactívelo en lugar de eliminarlo.',
  },
  [ErrorCode.AssetPriceZeroReasonExists]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Ya existe un motivo de precio cero con ese nombre.',
  },
  [ErrorCode.AssetPriceNotZero]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'El activo tiene precio de compra. No necesita motivo de precio cero.',
  },
  [ErrorCode.DepreciationInvalidPeriod]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El periodo de depreciación no es válido.',
  },
  [ErrorCode.ModuleUnavailable]: {
    httpStatus: 503,
    action: 'CANCEL',
    message: 'Este módulo no está disponible en este momento.',
  },
  [ErrorCode.FeatureUnknown]: {
    httpStatus: 404,
    action: 'CANCEL',
    message: 'Ese módulo no existe.',
  },
  [ErrorCode.FeatureNotToggleable]: {
    httpStatus: 406,
    action: 'CANCEL',
    message: 'Este módulo no se puede activar ni desactivar.',
  },
  [ErrorCode.ScopeNoCostCenter]: {
    httpStatus: 403,
    action: 'CONTACT_SUPPORT',
    message: 'Su rol no tiene centros de costo asignados. Pida a Control Interno que se los asigne.',
  },
  [ErrorCode.ScopeOrgUnitUnresolved]: {
    httpStatus: 403,
    action: 'CONTACT_SUPPORT',
    message: 'Su rol está asignado a una dependencia y aún no le da acceso a centros de costo. Pida a Control Interno que se lo asigne sobre un centro de costo.',
  },
  [ErrorCode.CostCenterHeadOverlap]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esa persona ya es jefe de ese centro de costo en parte de esas fechas.',
  },
  [ErrorCode.CostCenterHeadEnded]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'La jefatura ya terminó.',
  },
  [ErrorCode.CostCenterPlacementCycle]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ese centro está debajo de este. Elija otro centro padre.',
  },
  [ErrorCode.CostCenterPlacementUnchanged]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esa ya es la ubicación actual.',
  },
  [ErrorCode.CostCenterPlacementRequired]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La dependencia y el centro padre se cambian desde la ubicación del centro.',
  },
  [ErrorCode.CostCenterGroupingHasAssets]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Tiene activos asignados. No puede quedar como agrupador.',
  },
  [ErrorCode.CostCenterCodeOutOfUnitRange]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El código no corresponde a la dependencia.',
  },
  [ErrorCode.CostCenterWithoutHead]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El centro de costo no tiene jefe vigente. Asígnele un jefe antes de agregarle activos.',
  },
  [ErrorCode.CostCenterInactive]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El centro de costo está archivado. Reactívelo antes de continuar.',
  },
  [ErrorCode.CostCenterParentInactive]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Su centro padre está archivado. Reactívelo primero.',
  },
  [ErrorCode.CostCenterOrgUnitInactive]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Su dependencia está archivada. Reactívela primero.',
  },
  [ErrorCode.OrgUnitCodePrefixExists]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ese prefijo ya es de otra dependencia.',
  },
  [ErrorCode.OrgUnitParentArchived]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esa dependencia está archivada. Elija otra o reactívela primero.',
  },
  [ErrorCode.OrgUnitNameDuplicate]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Ya existe una dependencia con ese nombre bajo el mismo jefe.',
  },
  [ErrorCode.OrgUnitPrefixOutOfParent]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El prefijo es el mismo de su jefe. Agregue al menos un dígito.',
  },
  [ErrorCode.OrgChartImportHasErrors]: {
    httpStatus: 422,
    action: 'CANCEL',
    message: 'El archivo tiene errores. Corríjalos y vuelva a subirlo.',
  },
  [ErrorCode.OrgChartImportStale]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'El organigrama cambió mientras revisaba el archivo. Vuelva a subirlo.',
  },
  [ErrorCode.OrgChartImportConflict]: {
    httpStatus: 409,
    action: 'CANCEL',
    message:
      'Otra persona cambió estas dependencias después de que usted descargó el archivo. Descargue el organigrama de nuevo y repita sus cambios.',
  },
  [ErrorCode.OrgChartImportClosed]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Esta revisión ya se aplicó o venció. Vuelva a subir el archivo.',
  },
  [ErrorCode.OrgChartInvalidFile]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Este archivo no es el Excel del organigrama. Debe tener la hoja Organigrama con sus encabezados.',
  },
  [ErrorCode.StructureReconcileStale]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'La estructura cambió desde la vista previa. Revísela de nuevo antes de aplicar.',
  },
  [ErrorCode.ImportJobNotRetryable]: {
    httpStatus: 409,
    action: 'CANCEL',
    message: 'Solo se puede reintentar una importación que falló.',
  },
  [ErrorCode.StorageKeyInvalid]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La ruta del archivo no es válida.',
  },
  [ErrorCode.StorageProjectPathLocked]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La carpeta del almacenamiento local no se cambia desde aquí.',
  },
  [ErrorCode.ArchiveTooLarge]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'El archivo es demasiado grande para procesarlo.',
  },
  [ErrorCode.MailAddressInvalid]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'La dirección de correo no es válida.',
  },
  [ErrorCode.OutboundDestinationForbidden]: {
    httpStatus: 400,
    action: 'CANCEL',
    message: 'Ese servidor está en una red interna. Use una dirección pública.',
  },
  [ErrorCode.EventsTicketInvalid]: {
    httpStatus: 401,
    action: 'RETRY',
    message: 'La conexión de avisos venció. Recargue la página.',
  },
  [ErrorCode.EventsCapacityReached]: {
    httpStatus: 503,
    action: 'RETRY',
    message: 'Hay demasiadas conexiones abiertas. Intente más tarde.',
  },
};
