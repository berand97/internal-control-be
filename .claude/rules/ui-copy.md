# UI copy

Error and warning messages from the backend are shown to users as they are. Write them in Spanish the way a person at the university would. They must never sound machine-written.

This covers `error-catalog.ts`, `ApiException` messages, class-validator `message` options, Excel import row errors and warnings, Excel sheet notes and instructions, and history reasons.

- Short, plain sentences. Say what happened and, if needed, what to do. Nothing else.
- Do not justify or explain the rule behind a message.
- No guillemets « », no em or en dashes, no semicolons, no colon followed by an explanation, no "(p. ej. ...)".
- One term per concept: "dependencia" (never "unidad" or "unidad organizacional"), "centro de costo".
- Address the user as "usted", naturally. Prefer short imperatives ("Elija otra dependencia.").
- No filler: "solo", "por separado si los necesita", "Tenga en cuenta", "Recuerde", "de todos modos".
- End each sentence with a period. Get singular and plural right ("1 centro hijo activo", "2 centros hijos activos").
- No endpoints, permission codes, env vars, table names or UUIDs in a message. Put ids in `details`, not in the text.
- No personal data beyond what the user already sees on screen.
- Every class-validator decorator on a DTO the UI posts to gets a Spanish `message`. The English defaults reach the user.
- Changing a text never changes an error code, HTTP status, `details` shape or logic. Update the specs that assert the text.

## Before and after

| Before | After |
| --- | --- |
| Ya existe «Calidad» bajo Rectoría (prefijo 102). Dos unidades activas bajo la misma dependencia no pueden llamarse igual: use un nombre que las distinga. | Ya existe Calidad en Rectoría. |
| La dependencia «X» está archivada. Reactívela primero o elija otro padre. | X está archivada. Elija otra dependencia o reactívela primero. |
| El código interno debe empezar por una letra mayúscula y llevar solo letras mayúsculas sin tildes, dígitos y guion bajo (p. ej. OFICINA_CALIDAD) | Use mayúsculas sin tildes, números y guion bajo. Debe empezar con letra. |
| El código del centro propio debe tener de 1 a 20 dígitos, sin letras ni espacios | Escriba solo números, hasta 20. |
| La fila 4 también deja «Planeación» bajo Rectoría. Dos unidades activas... | La fila 4 repite el nombre Planeación en Rectoría. |
| Centro propio 1510 pendiente: el centro aún no existe; se amarrará solo cuando se cree | El centro 1510 aún no existe. Quedará como centro propio cuando lo creen. |
| La unidad tiene 3 centros de costo activos: muévalos a otra unidad o desactívelos antes de desactivar la unidad | Tiene 3 centros de costo activos. Muévalos a otra dependencia o archívelos primero. |
| La unidad y el centro padre se cambian con POST /cost-centers/{id}/placement, indicando el motivo | La dependencia y el centro padre se cambian desde la ubicación del centro. |
