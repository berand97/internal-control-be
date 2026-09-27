# Despliegue del backend (Dokploy)

Este documento describe qué necesita el backend para arrancar en producción, cómo se
despliega en Dokploy y qué pasa cuando falta algo. La fuente de verdad de las variables
es `src/config/configuration.ts` (más `src/instrumentation.ts`, `src/app.module.ts` y
`docker-entrypoint.sh`); si agrega una variable allí, agréguela aquí.

> No escriba valores reales de secretos en este archivo, en el repositorio ni en tickets.
> Se cargan solo en el panel de Dokploy.

## 1. Piezas

| Pieza | Qué es | Dónde |
|---|---|---|
| `api` | NestJS; aplica migraciones y arranca (`docker-entrypoint.sh`) | `Dockerfile`, servicio `api` de `docker-compose.yml` |
| `gotenberg` | Conversión DOCX→PDF de las actas (`POST /forms/libreoffice/convert`) | servicio `gotenberg` de `docker-compose.yml` |
| PostgreSQL 18.6 | Base de datos | Servicio de base de datos de Dokploy (fuera de este compose) |
| Volumen `backend_storage` | Fotos, plantillas, actas generadas y adjuntos | montado en `/data/storage` del `api` |
| MinIO (opcional) | Almacenamiento S3 de actas, plantillas, rúbricas y archivos de importación | Servicio aparte, fuera de este compose; se conecta desde la pantalla *Almacenamiento* (ver §10) |

### Gotenberg

- Imagen fijada: `gotenberg/gotenberg:8.37.0-libreoffice@sha256:f1d5a60e…09ad1`.
  - `8.37.0` es la última 8.x publicada (11-sep-2026) y es exactamente la que resuelve hoy la
    etiqueta flotante `8` que usa el CI (mismo digest). Se fija con digest para que el render
    de las actas no cambie sin un commit.
  - Variante `-libreoffice`: sin Chromium. El backend solo usa la ruta de LibreOffice; sin
    Chromium la imagen es más pequeña y no hay conversión de URLs/HTML expuesta.
  - Para actualizar: cambie etiqueta y digest en `docker-compose.yml` y
    `docker-compose.dev.yml`, corra la suite de integración con Gotenberg
    (`GOTENBERG_URL=... pnpm test:int`) y revise un acta real.
- **No publica puertos.** Solo es accesible desde la red interna del compose como
  `http://gotenberg:3000`. No le asigne dominio en Dokploy.
- Flags (ver `docker-compose.yml`): `--api-timeout=60s`, `--api-body-limit=50MB`,
  `--api-disable-download-from=true`, `--webhook-disable=true`,
  `--libreoffice-deny-private-ips=true`, `--libreoffice-auto-start=true`,
  `--libreoffice-start-timeout=30s`, `--libreoffice-max-queue-size=20`,
  `--libreoffice-restart-after=10`.
- Límites: 1 CPU y 1 GB de memoria (`deploy.resources.limits`).
- Healthcheck: `curl --fail http://localhost:3000/health`. El `api` espera a que Gotenberg
  esté sano (`depends_on: condition: service_healthy`).

## 2. Variables de entorno

Leyenda: **Obligatoria** = sin ella el despliegue falla (en `docker compose` o al arrancar el
backend). Los ejemplos son ilustrativos: genere sus propios secretos.

### 2.1 Obligatorias

| Variable | Ejemplo | Qué pasa si falta |
|---|---|---|
| `DATABASE_URL` | `postgres://USUARIO:CLAVE@control-interno-database:5432/control_interno` | `docker compose` falla (`required variable DATABASE_URL is missing`); fuera de compose, el backend no arranca (`Variable de entorno requerida ausente`). |
| `JWT_ACCESS_SECRET` | salida de `openssl rand -base64 64` | Igual que arriba. Solo firma tokens de sesión de vida corta (acceso 15 min, retos MFA 5 min): se puede rotar en cualquier momento (ver §7). |
| `JWT_REFRESH_SECRET` | salida de `openssl rand -base64 64` (distinta de la anterior) | Igual que arriba. |
| `QR_SIGNING_SECRET` | ver §7 **antes** de elegir el valor | `docker compose` falla (`QR_SIGNING_SECRET es obligatoria en produccion…`); fuera de compose el backend no arranca. No puede ser igual a `JWT_ACCESS_SECRET` ni a `JWT_REFRESH_SECRET`. Firma los QR **impresos** en las etiquetas: cambiarla invalida todas las etiquetas. |
| `MOVEMENT_SIGNING_SECRET` | ver §7 | Igual que arriba. HMAC de integridad de cada movimiento: cambiarla sin `MOVEMENT_SIGNING_SECRET_PREVIOUS` hace que los movimientos anteriores salgan como alterados. |
| `SETTINGS_ENCRYPTION_KEY` | ver §7 | Igual que arriba. Cifra en la base los secretos SMTP y las credenciales de almacenamiento (S3, Google Drive, OneDrive): cambiarla sin `SETTINGS_ENCRYPTION_KEY_PREVIOUS` los deja ilegibles. |
| `SIGNATURE_VERIFY_URL` | `https://control-interno.unac.edu.co/verificar-firma` | `docker compose` falla con `SIGNATURE_VERIFY_URL es obligatoria en produccion…`. Fuera de compose, el backend no arranca. Debe ser **https**, de host **público** (no localhost/10.x/192.168.x/172.16-31.x/`.local`/`.internal`) y **sin** `?` ni `#`: queda impresa en el QR de cada acta firmada. |
| `GOTENBERG_URL` | `http://gotenberg:3000` | En compose ya viene fijada a `http://gotenberg:3000` (solo defínala para apuntar a otro Gotenberg). Fuera de compose (despliegue solo con Dockerfile), si falta el backend **no arranca**: `GOTENBERG_URL es obligatoria en producción`. |

Por qué `GOTENBERG_URL` es obligatoria en producción: todas las actas pasan por la
conversión a PDF. Un servidor que arranca sin ella acepta generar actas y responde 502 en
cada una; es preferible que el despliegue falle de inmediato y se vea en Dokploy.

### 2.2 Fijadas por `docker-compose.yml` / `Dockerfile` (no las cambie en Dokploy)

| Variable | Valor | Nota |
|---|---|---|
| `NODE_ENV` | `production` | Activa las validaciones de producción y apaga la documentación de la API. |
| `PORT` | `3000` | |
| `STORAGE_DRIVER` | `project` | Valor inicial; ver nota de almacenamiento. |
| `STORAGE_PROJECT_PATH` | `/data/storage` | Debe coincidir con el volumen. |

### 2.3 Recomendadas / opcionales

| Variable | Obligatoria | Por defecto | Ejemplo | Qué pasa si falta |
|---|---|---|---|---|
| `RUN_MIGRATIONS` | No | `true` | `true` | Con `true` el entrypoint corre `typeorm migration:run` antes de arrancar. Con `false` no migra (ver §4). |
| `CORS_ALLOWED_ORIGINS` | En la práctica sí | vacío | `https://control-interno.unac.edu.co` | Vacío = ningún origen permitido: el frontend en otro dominio no puede llamar al API. Lista separada por comas. |
| `APP_PUBLIC_URL` | En la práctica sí | `http://localhost:4200` | `https://control-interno.unac.edu.co` | Enlaces de correos (invitaciones, recuperación) y redirecciones de OAuth de almacenamiento apuntarían a localhost. |
| `API_PUBLIC_URL` | En la práctica sí | `http://localhost:3000` | `https://api.control-interno.unac.edu.co` | URLs de archivos del almacenamiento `project`, callbacks OAuth de Google Drive/OneDrive y las **imágenes de las plantillas de correo** (`<API_PUBLIC_URL>/api/v1/public/email-assets/<id>`, pública y sin sesión) apuntarían a localhost. En producción debe ser **https** y de host público: los clientes de correo descargan las imágenes desde internet. Si no lo es, el backend arranca pero lo advierte en el log (`API_PUBLIC_URL debe usar https en producción…`). Si hay un proxy delante, debe dejar pasar `/api/v1/public/email-assets/` sin autenticación y sin cambiar `Cross-Origin-Resource-Policy: cross-origin` (si fuerza `same-origin`, Outlook web no muestra las imágenes). |
| `MOVEMENT_SIGNING_SECRET_PREVIOUS` | Solo al rotar | vacío | `<valor anterior>` | Lista separada por comas de claves anteriores de firma de movimientos: solo **verifican**. Ver §7.3. |
| `SETTINGS_ENCRYPTION_KEY_PREVIOUS` | Solo al rotar | vacío | `<valor anterior>` | Lista separada por comas de claves anteriores de cifrado: solo **descifran**; lo leído se vuelve a cifrar con la actual. Ver §7.2. |
| `OUTBOUND_ALLOW_PRIVATE_NETWORKS` | No | `false` en producción, `true` fuera | `false` | Con `false`, el host SMTP y el endpoint S3 no pueden ser privados, loopback ni link-local. Ver §8. |
| `OUTBOUND_ALLOWED_HOSTS` | No | vacío | `minio,relay.interno.unac.edu.co` | Excepciones explícitas (host o IP exactos) a la regla anterior. Ver §8. |
| `JWT_ACCESS_EXPIRES_IN` | No | `15m` | `15m` | Formato `900`, `15m`, `7d`; un valor inválido impide arrancar. |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | `7d` | Ídem. |
| `JWT_MFA_CHALLENGE_EXPIRES_IN` | No | `5m` | `5m` | Ídem. |
| `JWT_ISSUER` | No | `asset-management-api` | | |
| `JWT_AUDIENCE` | No | `asset-management-web` | | |
| `ARGON2_MEMORY_COST` | No | `65536` | | No numérico = no arranca. |
| `ARGON2_TIME_COST` | No | `3` | | Ídem. |
| `ARGON2_PARALLELISM` | No | `4` | | Ídem. |
| `REFRESH_COOKIE_SECURE` | No | `true` | `true` | Déjela en `true` en producción (cookie solo por https). |
| `TRUST_PROXY` | No | `loopback, linklocal, uniquelocal` | `2` | Proxies de confianza para `X-Forwarded-For` (IP real en firmas, auditoría y throttler). Número de saltos o lista de redes; nunca `true`. |
| `API_DOCS_ENABLED` | No | `false` en producción | `false` | `true` publica `/api/openapi.json` y `/api/reference`. |
| `DATABASE_LOGGING` | No | `false` | `false` | `true` registra el SQL (ruidoso; puede incluir datos personales). |
| `DOCUMENT_NUMBERING_POLICY` | No | `continue` | `continue` | `continue` \| `restart`; otro valor impide arrancar. |
| `SIGNATURE_PROVIDER` | No | `internal` | `internal` | `internal` \| `stub`. **Nunca `stub` en producción** (solo desarrollo). |
| `FEATURE_CIRCUIT_THRESHOLD` | No | `5` | `5` | |
| `FEATURE_<CODIGO>` | No | — | `FEATURE_LOANS=false` | Apaga un módulo (guiones → guiones bajos). Los módulos core no se apagan. |
| `STORAGE_S3_*`, `STORAGE_GOOGLE_*`, `STORAGE_ONEDRIVE_*` | No | vacíos | | Valores iniciales si se usa otro driver; ver nota de almacenamiento. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | vacío | `https://observe.ejemplo/api/default` | Sin endpoint **y** `OTEL_EXPORTER_OTLP_AUTH` no se exporta telemetría. |
| `OTEL_EXPORTER_OTLP_AUTH` | No | vacío | `Basic <base64>` | Ídem. |
| `OTEL_SERVICE_NAME` | No | `control-interno-be` | | |
| `OTEL_STREAM_NAME` | No | `default` | | |
| `OTEL_ORGANIZATION` | No | `default` | | |
| `OBSERVE_APP_KEY` / `OBSERVE_APP_SECRET` | No | vacíos | | Sin ambas no se registra NestJS Observe. |
| `ALLOW_REMOTE_DATABASE` | **No usar en producción** | — | | Solo afecta a entornos con `NODE_ENV` distinto de `production` (ver §6). |

**Nota de almacenamiento.** Las variables `STORAGE_*` son solo el valor inicial: en cuanto
existe la fila de `storage_settings` (se crea al guardar la configuración desde la
aplicación), el driver y las credenciales salen de la base de datos. La carpeta del driver
`project` es la excepción: **siempre** sale de `STORAGE_PROJECT_PATH` (no se cambia desde la
aplicación; una `project_path` distinta guardada en la base se ignora y se avisa en el log la
primera vez que se usa el almacenamiento). Debe seguir siendo `/data/storage` o los archivos quedarán fuera del volumen.
Los secretos de almacenamiento (`s3_secret_key`, `google_client_secret`, `google_refresh_token`,
`onedrive_client_secret`, `onedrive_refresh_token`) se guardan cifrados con
`SETTINGS_ENCRYPTION_KEY` (prefijo `enc.v1.`); la migración `1767225780000` cifra los que ya existían.

## 3. Volúmenes

- `backend_storage` → `/data/storage` del `api`. Persistente; contiene `generated/`,
  `attachments/` y `templates/` (el entrypoint los crea y ajusta permisos al usuario `node`).
  Inclúyalo en los respaldos junto con la base de datos: un acta firmada sin su PDF no se
  puede volver a mostrar.
- Gotenberg no usa volúmenes.

## 4. `RUN_MIGRATIONS`

- `true` (defecto): en cada arranque del contenedor se ejecuta
  `node ./node_modules/typeorm/cli.js migration:run -d ./dist/database/data-source.js` y
  luego la aplicación. Las migraciones ya aplicadas no se repiten.
- `false`: no migra. Úselo si prefiere aplicar migraciones a mano (mismo comando con
  `docker exec` en el contenedor) o si necesita arrancar una versión sin tocar el esquema.
- Las migraciones corren **antes** de validar el resto de la configuración de la app: si
  falta, por ejemplo, `SIGNATURE_VERIFY_URL` fuera de compose, las migraciones se aplican y
  luego la app se niega a arrancar. Con compose esto no ocurre porque `docker compose` falla
  antes.

## 5. Procedimiento de despliegue

1. **Respaldo.** Antes de cualquier despliegue con migraciones nuevas: `pg_dump` de la base
   de producción y copia del volumen `backend_storage`.
2. **Variables.** En Dokploy → aplicación → *Environment*, cargue las obligatorias de §2.1 y
   las recomendadas de §2.3. Dokploy las escribe en un `.env` junto a `docker-compose.yml`;
   el compose las usa para interpolar y las pasa completas al `api` (`env_file`).
3. **Tipo de despliegue.**
   - *Docker Compose* (recomendado): ruta del compose `docker-compose.yml` en la carpeta del
     backend. Levanta `api` y `gotenberg` juntos. Asigne el dominio solo al servicio `api`,
     puerto `3000`.
   - *Application con Dockerfile* (solo el `api`): el compose se ignora. Tiene que crear
     Gotenberg aparte en Dokploy (misma imagen y flags, sin dominio público), definir
     `GOTENBERG_URL` con su nombre interno, montar un volumen en `/data/storage` y definir
     todas las variables de §2.1 a mano.
4. **Desplegar.** Si falta una variable obligatoria, el log de Dokploy muestra el error de
   `docker compose` o del backend con el nombre de la variable.
5. **Verificar.**
   - `api` y `gotenberg` en estado *healthy*.
   - `GET https://<api>/api/v1` responde 200.
   - Log del `api`: sin errores de migración.
   - Genere un acta de prueba y descargue el PDF; el QR debe apuntar a `SIGNATURE_VERIFY_URL`.
6. **Revertir.** Vuelva a desplegar el commit anterior. Si hubo migraciones nuevas, antes
   revierta con `typeorm migration:revert` (una por migración, dentro del contenedor de la
   versión nueva) o restaure el respaldo.

## 6. Protección en desarrollo: solo base de datos local

Fuera de `NODE_ENV=production`, la aplicación y los CLI que usan
`src/database/data-source.ts` (migraciones, `staging`) **se niegan a conectarse** a una base
de datos que no sea local: `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, socket Unix o el
contenedor `postgres` de `docker-compose.dev.yml`. Evita que un `.env` de desarrollo copiado
del servidor haga que un `pnpm start` o `pnpm db:migrate` escriba en producción.

- Error: `DATABASE_URL apunta a un host no local (<host>) y NODE_ENV no es production…`
  (sin usuario ni contraseña en el mensaje).
- Escape explícito: `ALLOW_REMOTE_DATABASE=true` (solo ese valor). La conexión se permite y
  queda un aviso en el log con el host y el `NODE_ENV`, sin credenciales.
- En producción no se restringe el host.

## 7. Claves separadas por propósito: primer despliegue y rotación

Desde la auditoría BE-12, en producción cada propósito tiene su clave y el backend **no arranca**
(y `docker compose` no levanta) si falta alguna o si es igual a `JWT_ACCESS_SECRET` o
`JWT_REFRESH_SECRET`:

| Variable | Protege | Qué rompe cambiarla sin más |
|---|---|---|
| `QR_SIGNING_SECRET` | QR impresos en las etiquetas de los activos | Todas las etiquetas impresas dejan de validar. |
| `MOVEMENT_SIGNING_SECRET` | HMAC de integridad de cada movimiento | Los movimientos anteriores aparecen como alterados (`MOVEMENT_TAMPERED`, `SIGNATURE_MISMATCH`). |
| `SETTINGS_ENCRYPTION_KEY` | Secretos SMTP y credenciales de almacenamiento cifrados en la base | La configuración de correo y de almacenamiento no se puede leer (500). |

**Antes de esta versión, una variable que no estuviera definida usaba el valor de
`JWT_ACCESS_SECRET`.** Por eso el primer despliegue no se hace con claves nuevas.

### 7.1 Primer despliegue de esta versión (sin romper firmas, QR ni secretos)

1. En Dokploy → *Environment* revise (sin copiarlos a ningún otro lado) si existen
   `QR_SIGNING_SECRET`, `MOVEMENT_SIGNING_SECRET` y `SETTINGS_ENCRYPTION_KEY`.
2. **Si las tres existen y ninguna es igual a `JWT_ACCESS_SECRET` ni a `JWT_REFRESH_SECRET`:** no
   cambie nada. Siga con el paso 6.
3. **Si alguna falta:** su valor efectivo hoy es el de `JWT_ACCESS_SECRET`. Cree cada una que
   falte con **exactamente el valor actual de `JWT_ACCESS_SECRET`** (copiar y pegar dentro del
   panel). No genere un valor nuevo: invalidaría etiquetas, firmas y secretos.
4. **Rote `JWT_ACCESS_SECRET`** (obligatorio si en el paso 3 copió su valor, o si alguna de las
   tres ya era igual a él): reemplácelo por la salida de `openssl rand -base64 64`. Efecto: los
   tokens de acceso vigentes (15 min) y los retos MFA en curso (5 min) dejan de valer; la
   aplicación renueva la sesión con la cookie de refresco (firmada con `JWT_REFRESH_SECRET`, que no
   cambia) y quien estaba a mitad de un inicio de sesión con MFA lo repite.
   - Si alguna de las tres era igual a `JWT_REFRESH_SECRET`, rote también `JWT_REFRESH_SECRET`:
     todos los usuarios tendrán que iniciar sesión de nuevo.
5. Despliegue. La migración `1767225780000` cifra con `SETTINGS_ENCRYPTION_KEY` las credenciales
   de almacenamiento que estuvieran en claro. En el log aparecerá el aviso
   `… comparten valor: rótelas por separado` mientras las tres compartan el valor heredado: es
   esperado y no impide arrancar.
6. Verifique: `GET /api/v1/movements/<id>/verify` de un movimiento **anterior** al despliegue
   responde `valid: true`; *Correo → Probar conexión* funciona; *Almacenamiento* muestra el estado
   (y el driver en uso sigue guardando archivos); escanee una etiqueta QR impresa antes.

### 7.2 Separar o rotar `SETTINGS_ENCRYPTION_KEY`

1. `SETTINGS_ENCRYPTION_KEY_PREVIOUS` = valor **actual** de `SETTINGS_ENCRYPTION_KEY`.
2. `SETTINGS_ENCRYPTION_KEY` = salida de `openssl rand -base64 32`.
3. Despliegue. Lo cifrado con la anterior se sigue leyendo y, la primera vez que se lee, se vuelve
   a cifrar con la nueva. Para forzarlo abra en la aplicación *Correo* (configuración) y
   *Almacenamiento* (estado) una vez, con un usuario que tenga esos permisos.
4. En el despliegue siguiente quite `SETTINGS_ENCRYPTION_KEY_PREVIOUS`. **Excepción:** si otro módulo
   ya guarda datos con el mismo cifrado (por ejemplo semillas MFA), no la quite hasta que ese
   módulo haya vuelto a cifrar sus filas: sin la anterior, lo no re-cifrado queda ilegible.
   La migración `1767225780000` en `down()` también descifra con las anteriores.

### 7.3 Separar o rotar `MOVEMENT_SIGNING_SECRET`

1. `MOVEMENT_SIGNING_SECRET_PREVIOUS` = valor **actual** de `MOVEMENT_SIGNING_SECRET` (si ya había
   anteriores, agréguela a la lista separada por comas).
2. `MOVEMENT_SIGNING_SECRET` = salida de `openssl rand -base64 64`.
3. Despliegue. Los movimientos nuevos se firman con la nueva; los anteriores se verifican con la
   anterior. Las firmas antiguas **no** se recalculan (son la evidencia de integridad), así que
   `MOVEMENT_SIGNING_SECRET_PREVIOUS` se conserva de forma **permanente**.
4. Una clave anterior no puede ser el `JWT_ACCESS_SECRET` vigente (el backend no arranca): por eso,
   si la anterior es el valor heredado del JWT, haga antes el paso 4 de §7.1.
5. Si sospecha que una clave anterior se filtró, las firmas hechas con ella dejan de ser evidencia
   desde la fecha de la filtración: regístrelo en el informe de control interno.

### 7.4 `QR_SIGNING_SECRET`

No tiene clave anterior: cambiarla invalida todas las etiquetas impresas. Solo se rota ante una
filtración, y exige reimprimir las etiquetas.

## 8. Destinos salientes: host SMTP y endpoint S3

Quien administra el correo o el almacenamiento elige a qué servidor se conecta el backend. En
producción (`OUTBOUND_ALLOW_PRIVATE_NETWORKS=false`, valor por defecto con `NODE_ENV=production`)
se rechazan con `400 OUTBOUND_DESTINATION_FORBIDDEN`:

- IP de loopback (`127.0.0.0/8`, `::1`), privadas (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`),
  link-local y metadatos de nube (`169.254/16`, `fe80::/10`), CGNAT (`100.64/10`), `0.0.0.0/8`,
  multicast y reservadas, también en forma `::ffff:a.b.c.d`;
- `localhost`, nombres de una sola etiqueta (`gotenberg`, `postgres`: servicios del compose) y los
  sufijos `.local`, `.internal`, `.lan`, `.localhost`, `.home.arpa`;
- nombres que resuelven a cualquiera de esas direcciones. La comprobación se repite **en cada
  conexión** sobre las IP que se van a usar, así que un DNS que cambia después de guardar
  (rebinding) no la salta.

Además el endpoint S3 debe ser `http(s)` sin usuario, parámetros ni fragmento, y en producción
`https` salvo que el host esté en `OUTBOUND_ALLOWED_HOSTS`.

- Un SMTP o MinIO interno legítimo (MinIO: ver §10.4): agregue su host (o IP) a `OUTBOUND_ALLOWED_HOSTS`
  (lista separada por comas, coincidencia exacta).
- En desarrollo (`NODE_ENV` distinto de `production`) se permiten por defecto (MailHog o MinIO en
  `localhost`). Para probar la regla localmente: `OUTBOUND_ALLOW_PRIVATE_NETWORKS=false`.
- Las URL de Google Drive y OneDrive son fijas (no configurables) y no pasan por esta regla.

## 9. Conexión OAuth de Google Drive / OneDrive

El `state` que viaja a Google o Microsoft es un valor aleatorio de **un solo uso**, válido 10
minutos, guardado solo como hash en `storage_oauth_state` junto con el usuario que inició la
conexión. `start` además deja en el navegador la cookie `storage_oauth_binding` (HttpOnly,
`SameSite=Lax`, ruta `<ruta de API_PUBLIC_URL>/api/v1/storage/oauth`, `Secure` según
`REFRESH_COOKIE_SECURE`). El callback consume el `state` y exige esa cookie y que el usuario siga
activo; si algo no cuadra responde `424 STORAGE_OAUTH_FAILED` y no cambia el almacenamiento.

- El frontend y el API deben ser del **mismo sitio** (igual que para la cookie de refresco): el
  frontend ya envía `withCredentials`, así que la cookie se guarda al llamar a `start`.
- Conecte la cuenta desde el mismo navegador en el que pulsa *Conectar*; abrir el enlace de
  autorización en otro navegador o equipo falla a propósito.
- `GET /api/v1/storage` ya no devuelve `authorizationUrl` (siempre `null`): la URL solo la emiten
  `oauth/{google,onedrive}/start`.

## 10. Almacenamiento con MinIO

MinIO se instala **aparte** (no forma parte de `docker-compose.yml`) y el backend se conecta a él desde
la pantalla *Almacenamiento*. Nada de esta sección cambia el despliegue del `api`, salvo
`OUTBOUND_ALLOWED_HOSTS` si MinIO queda en la red interna (§10.4).

### 10.1 Qué imagen usar (estado comprobado el 2026-09-26)

| Fuente | Estado | Evidencia |
|---|---|---|
| `minio/minio`, `minio/mc` (Docker Hub) | **Ya no existen** | `docker pull minio/minio:latest` → `pull access denied, repository does not exist`; `hub.docker.com/v2/repositories/minio/minio/` → 404. |
| `quay.io/minio/minio`, `quay.io/minio/mc` | **Sin acceso anónimo** | El token anónimo de quay.io para `minio/minio` sale con `actions: []` y el manifiesto responde 401; no figuran entre los repositorios públicos del namespace `minio`. |
| Binarios `dl.min.io/server/minio/release/…` | **Retirados** | `410 Gone`: *"The open-source MinIO Server, MinIO Client (mc) and MinIO KES projects are archived and no longer maintained… no security updates"*. |
| Código fuente `github.com/minio/minio` (AGPLv3) | **Archivado, solo lectura** | README: *"THIS REPOSITORY IS NO LONGER MAINTAINED"* y *"distributed as source code only"*. Última versión: `RELEASE.2025-10-15T17-29-55Z` (commit `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`). `mc`: `RELEASE.2025-08-13T08-35-41Z` (commit `d6541ea280b73a834b64d4097e21f2be77676104`), también archivado. |
| **AIStor** (`quay.io/minio/aistor/minio`, `quay.io/minio/aistor/mc`) | **Única imagen oficial publicada hoy** | Licencia comercial de MinIO, no AGPL. Servidor `RELEASE.2026-09-19T17-05-25Z@sha256:107cf2014a9583c74c11e3cdbd6903d89c2244355886b89ce532f4ecae9c23f3`; cliente `quay.io/minio/aistor/mc:RELEASE.2026-09-19T15-24-59Z@sha256:23511e340cbabf07e6a8b53f9c434975708f22f3c047d6beeddc17bf1a5aed88` (digest del índice multi-arquitectura amd64/arm64). Exige un archivo de licencia (`--license /minio.license`). El nivel *AIStor Free* es gratuito, pero solo para un nodo, sin cifrado en reposo y sin soporte. |

Además, desde `RELEASE.2025-05-24` la consola web de la edición comunitaria solo permite navegar por los
objetos: usuarios, políticas y configuración se administran con `mc`.

**Decisión pendiente (licencia):** hay dos caminos y los dos se conectan igual al backend.

- **A. AIStor Free:** tiene actualizaciones de seguridad, pero hay que registrarse para obtener la
  licencia y aceptar el contrato *AIStor Free Tier* (lo revisa quien firma por la UNAC).
- **B. Edición comunitaria compilada desde el código fuente archivado:** AGPLv3 y sin licencia que
  tramitar, pero **ya no recibe parches de seguridad**. Si se elige, compílela fijada por commit:

  ```dockerfile
  FROM golang:1.24-bookworm AS build
  ENV CGO_ENABLED=0
  RUN go install github.com/minio/minio@9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a \
   && go install github.com/minio/mc@d6541ea280b73a834b64d4097e21f2be77676104
  FROM debian:bookworm-slim
  COPY --from=build /go/bin/minio /go/bin/mc /usr/local/bin/
  ENTRYPOINT ["minio"]
  ```

  Con este Dockerfile se corrieron las pruebas de `test/integration/s3-minio.int-spec.ts`.

No use etiquetas flotantes (`latest`): fije versión y digest como en Gotenberg (§1).

### 10.2 Instalar MinIO (servicio independiente)

- **Un solo servicio**, con volumen persistente en `/data` y comando `minio server /data`
  (AIStor: `minio server /data --license /minio.license`, con la licencia montada).
- **Credenciales raíz** (`MINIO_ROOT_USER` y `MINIO_ROOT_PASSWORD`): largas y aleatorias
  (`openssl rand -hex 24`), guardadas solo en el panel. No se usan en el backend: sirven para administrar
  con `mc`. Si usa una plantilla de MinIO de Dokploy, cambie la imagen: `minio/minio` ya no existe.
- **API S3 (puerto 9000):** no le asigne dominio público si el backend está en el mismo servidor
  (§10.4, opción 1). Si necesita publicarla, solo con **HTTPS** (opción 2).
- **Consola (puerto 9001, `--console-address :9001`):** no la publique. Si hace falta, publíquela solo
  detrás de HTTPS y con restricción de IP o autenticación del proxy.
- **Respaldo:** el versionado no es un respaldo. Respalde el volumen `/data` (con el servicio detenido
  o con una instantánea) o copie el bucket a otro destino con `mc mirror --preserve`, en la **misma
  ventana** que el `pg_dump`: la base guarda las claves de los objetos y, sin los dos respaldos,
  un acta firmada no se puede volver a mostrar.

### 10.3 Bucket privado, versionado y usuario de la aplicación

Con `mc` (el que viene en la imagen o `quay.io/minio/aistor/mc`), usando la credencial raíz **solo**
para esto:

```sh
mc alias set ci <URL de la API S3> <MINIO_ROOT_USER> <MINIO_ROOT_PASSWORD>
mc mb ci/control-interno                      # añada --with-lock si se decide object lock (abajo)
mc version enable ci/control-interno
mc anonymous get ci/control-interno           # debe decir: private
# Las sondas de "Probar conexión" (health/probe-*.txt) quedan como versiones antiguas: que caduquen.
mc ilm rule add --prefix health/ --noncurrent-expire-days 1 --expire-delete-marker ci/control-interno
mc admin policy create ci control-interno-app control-interno-app.json
mc admin user add ci svc-control-interno "<clave aleatoria de 40 caracteres>"
mc admin policy attach ci control-interno-app --user svc-control-interno
```

`control-interno-app.json`: política mínima, válida solo para ese bucket. La aplicación nunca borra
documentos: solo puede borrar sus sondas en `health/`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetBucketVersioning", "s3:GetBucketObjectLockConfiguration"],
      "Resource": ["arn:aws:s3:::control-interno"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": ["arn:aws:s3:::control-interno/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::control-interno/health/*"]
    }
  ]
}
```

**Object lock (evidencia inmutable).** Se decide **al crear el bucket** (`mc mb --with-lock`, que
además activa el versionado); en MinIO no se activa después.

- A favor: con una retención por defecto (`mc retention set --default GOVERNANCE|COMPLIANCE <días>d`),
  ninguna versión de un acta firmada se puede borrar ni sobrescribir durante ese plazo. En modo
  `COMPLIANCE` no la borra ni la cuenta raíz: es evidencia fuerte para control interno.
- En contra: se aplica a **todo** lo que entra en el bucket (plantillas, archivos de importación y
  sondas de salud). Un archivo cargado por error, o con datos personales que haya que suprimir
  (Ley 1581), no se puede eliminar hasta que venza el plazo. Las versiones retenidas no caducan con
  `mc ilm`, así que el disco crece. `COMPLIANCE` es irreversible.
- Requisitos: un plazo de retención definido por la tabla de retención documental (TRD) de la UNAC y
  un bucket nuevo creado con `--with-lock`.
- Recomendación: por ahora, versionado sin object lock. Si control interno fija un plazo, cree un
  bucket con `--with-lock` y retención `GOVERNANCE` y migre (§10.6). *Probar conexión* muestra el estado
  en `bucket.objectLock`.

### 10.4 Red: BE-16 y `OUTBOUND_ALLOWED_HOSTS`

En producción el backend **rechaza** cualquier endpoint S3 en la red interna (§8):
`http://minio:9000`, el nombre interno de un servicio de Dokploy (una sola etiqueta, sin punto), una IP
privada o un nombre que resuelva a una. Al guardar responde `400 OUTBOUND_DESTINATION_FORBIDDEN` y
*Probar conexión* lo muestra en la comprobación `DESTINATION`. Hay dos opciones:

1. **MinIO interno + autorización por variable (recomendada si están en el mismo servidor).** En el
   *Environment* del backend, `OUTBOUND_ALLOWED_HOSTS=<host exacto del endpoint>` (por ejemplo, el
   nombre interno que Dokploy asigna al servicio MinIO) y **vuelva a desplegar el backend**. Con el host
   en la lista también se acepta `http://`. MinIO y el `api` deben compartir red de Docker.
2. **MinIO con dominio HTTPS público** (por ejemplo `https://s3.control-interno.unac.edu.co`). No
   necesita variable si el dominio resuelve a una IP pública. Si dentro del servidor resuelve a una
   IP privada (DNS interno o *hairpin*), también se rechaza y hay que usar la opción 1.

La autorización es una variable de despliegue **a propósito**. Si se pudiera cambiar desde la pantalla,
un administrador de almacenamiento podría volver a usar *Probar conexión* para sondear la red interna.

### 10.5 Conectar el backend desde la pantalla *Almacenamiento*

La fila `storage_settings` de la base **manda** sobre las variables `STORAGE_*`. `docker-compose.yml`
fija `STORAGE_DRIVER=project` como valor inicial y no hace falta tocarlo. Orden:

1. Respaldo de la base y del volumen `backend_storage` (§5).
2. MinIO instalado, bucket y usuario creados (§10.2 y §10.3). Si aplica, `OUTBOUND_ALLOWED_HOSTS` ya
   desplegado (§10.4): **sin él, guardar falla con 400**.
3. En *Almacenamiento*, elija *S3 compatible* y complete:

   | Campo | Valor |
   |---|---|
   | Proveedor (`s3Provider`) | `MinIO` |
   | Endpoint (`s3Endpoint`) | URL de la API S3, **sin** ruta ni bucket: `http://<host interno>:9000` u `https://s3.dominio` |
   | Región (`s3Region`) | `us-east-1` (la de MinIO, salvo que configure `MINIO_REGION`) |
   | Bucket (`s3Bucket`) | `control-interno` |
   | Access key / Secret key | las de `svc-control-interno`, **nunca** la raíz |
   | Path-style (`s3ForcePathStyle`) | **activado** (MinIO no usa subdominios por bucket) |

   La clave secreta se guarda cifrada con `SETTINGS_ENCRYPTION_KEY`.
4. **Guardar activa el driver de inmediato**: lo que se genere desde ese momento va a MinIO. Hágalo en un
   momento de poca actividad y pulse *Probar conexión* enseguida. Si algo sale `FAILED`, vuelva a
   *Local (servidor)*: lo guardado en MinIO mientras tanto se sigue leyendo porque cada fila guarda su
   driver, pero solo mientras la configuración S3 se conserve.
5. *Probar conexión* debe mostrar `ok: true`, con todas las comprobaciones `PASSED` y `VERSIONING` en
   `PASSED`. Luego genere un acta de prueba y descárguela, y abra un acta **anterior** al cambio.

*Probar conexión* (`POST /api/v1/storage/test`) comprueba, en orden:
`CONFIGURATION` (bucket y claves), `DESTINATION` (BE-16), `ENDPOINT`, `CREDENTIALS`, `BUCKET`,
`WRITE`/`READ`/`DELETE` (objeto `health/probe-<uuid>.txt`), `VERSIONING` y `OBJECT_LOCK`. Códigos de falla:
`STORAGE_NOT_CONFIGURED`, `OUTBOUND_DESTINATION_FORBIDDEN`, `ENDPOINT_NOT_ALLOWED`, `ENDPOINT_UNREACHABLE`,
`ENDPOINT_TIMEOUT`, `TLS_CERTIFICATE_INVALID`, `INVALID_CREDENTIALS`, `ACCESS_DENIED`, `BUCKET_NOT_FOUND`,
`CONTENT_MISMATCH` y `UNEXPECTED_ERROR`. Los mensajes nunca incluyen claves ni el texto del proveedor.

### 10.6 Documentos que ya estaban en el volumen local

**No se migran solos, y no hace falta para seguir usándolos.** Cada documento guarda con qué driver se
escribió (`document.docx_driver`/`pdf_driver`/`signed_pdf_driver`, `signature_envelope.current_pdf_driver`,
`signature_envelope_signer.rubric_driver`, `document_template_version.storage_driver`,
`import_template.storage_driver`) y se lee con ese driver (`StorageService.getFrom`). Por eso:

- El volumen `backend_storage` **sigue montado y en los respaldos** mientras exista una fila con driver
  `project`.
- `getFrom('s3', …)` usa la configuración S3 **vigente**: si luego cambia el endpoint o el bucket,
  lo guardado en el bucket anterior deja de leerse. Copie los objetos antes de cambiarlo.
- `GET /api/v1/storage/objects?key=` descarga solo del driver activo.

Si se quiere vaciar el volumen, la migración va aparte y está sin implementar. Tendría que ser un comando
idempotente con `--dry-run`: por cada fila con driver `project`, copiar el objeto con la misma clave a
MinIO, verificar el SHA-256 contra el hash guardado en la fila (`file_hash`, `current_pdf_sha256`,
`rubric_sha256`…) y cambiar el driver de esa fila en una transacción. Recién con todo verificado se
retira el volumen, siempre después de un respaldo.
