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
| `JWT_ACCESS_SECRET` | salida de `openssl rand -base64 64` | Igual que arriba. Además es el valor por defecto de `QR_SIGNING_SECRET`, `MOVEMENT_SIGNING_SECRET` y `SETTINGS_ENCRYPTION_KEY` si no se definen. |
| `JWT_REFRESH_SECRET` | salida de `openssl rand -base64 64` (distinta de la anterior) | Igual que arriba. |
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
| `API_PUBLIC_URL` | En la práctica sí | `http://localhost:3000` | `https://api.control-interno.unac.edu.co` | URLs de archivos del almacenamiento `project` y callbacks OAuth de Google Drive/OneDrive apuntarían a localhost. |
| `QR_SIGNING_SECRET` | Recomendada | `JWT_ACCESS_SECRET` | `openssl rand -base64 64` | Firma los tokens QR con el secreto de acceso. Cambiarla invalida los QR emitidos. |
| `MOVEMENT_SIGNING_SECRET` | Recomendada | `JWT_ACCESS_SECRET` | `openssl rand -base64 64` | Firma de movimientos con el secreto de acceso. Cambiarla invalida verificaciones previas. |
| `SETTINGS_ENCRYPTION_KEY` | Recomendada | `JWT_ACCESS_SECRET` | `openssl rand -base64 32` | Cifra secretos guardados en BD (correo, almacenamiento). **Cambiarla después deja ilegibles los secretos ya guardados.** |
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
aplicación), el driver y la ruta salen de la base de datos. Con el driver `project`, esa
ruta debe seguir siendo `/data/storage` o los archivos quedarán fuera del volumen.

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
