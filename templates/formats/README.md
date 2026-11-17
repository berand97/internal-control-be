# Plantillas DOCX (Formatos SGC)

Los archivos de este directorio son la fuente de las plantillas que el motor de actas renderiza y convierte a PDF.

## Activar o actualizar OCI-21-37

La rúbrica de firma se estampa en el cuerpo del PDF donde aparecen las anclas `«FIRMA:RESPONSABLE»`, `«FIRMA:AUDITA»` y, si Contabilidad firma, `«FIRMA:CONTABILIDAD»`. La hoja final con QR y evidencia se mantiene.

Para que el entorno use esta versión:

1. Inicie sesión como Control Interno.
2. Vaya a **Documentos → Formatos** (Formatos SGC).
3. Abra el formato **OCI-21-37**.
4. Suba `OCI-21-37-v2.docx` (o la versión regenerada desde `scripts/formats/build-oci-21-37-template.mjs`) y actívela con la fecha de vigencia correspondiente.

En desarrollo local también puede sembrar la plantilla con:

```bash
node tools/seed-oci-21-37-template.mjs
```

(requiere `DATABASE_URL`, build previo de `dist/` y que no exista ya una versión con la misma `effective_date`).
