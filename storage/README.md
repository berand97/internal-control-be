Los archivos del driver `project` viven aquí para que un redeploy del API no los borre.

- `templates/` se puede versionar (plantillas Word de ejemplo).
- `generated/` y `attachments/` están en `.gitignore`; en producción monta este directorio como volumen persistente (`./storage`).

Nunca borres esta carpeta en un pipeline de despliegue.
