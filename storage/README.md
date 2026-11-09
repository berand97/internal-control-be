Los archivos del driver `project` viven aquí para que un redeploy del API no los borre.

- Las plantillas de ejemplo versionadas están en `templates/formats/` (fuera de este directorio).
- `generated/`, `attachments/`, `documents/`, `signatures/` y `templates/` están en `.gitignore`.
- En producción monta este directorio como volumen persistente (`./storage`).

Nunca borres esta carpeta en un pipeline de despliegue.
