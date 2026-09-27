import { describe, expect, it } from 'vitest';
import { flattenStoragePatch } from './update-storage-settings.dto.js';

describe('flattenStoragePatch', () => {
  it('mapea googleClientId y googleClientSecret', () => {
    expect(
      flattenStoragePatch({
        googleClientId: 'id.apps.googleusercontent.com',
        googleClientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta clientId/clientSecret como alias de Google', () => {
    expect(
      flattenStoragePatch({
        clientId: 'id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta google anidado', () => {
    expect(
      flattenStoragePatch({
        google: {
          clientId: 'id.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-secret',
        },
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('ignora Client ID enmascarado del status', () => {
    expect(
      flattenStoragePatch({
        googleClientId: 'id****om',
        googleClientSecret: 'GOCSPX-secret',
        googleConnected: false,
        needsOauth: true,
      }),
    ).toEqual({
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta folderId o URL de Drive como carpeta de Google', () => {
    expect(
      flattenStoragePatch({
        folderId:
          'https://drive.google.com/drive/folders/1AbCDeF-xyz?usp=sharing',
      }),
    ).toEqual({
      googleFolderId: '1AbCDeF-xyz',
    });
  });

  it('no escribe clientId en OneDrive si el driver no es onedrive', () => {
    expect(
      flattenStoragePatch({
        driver: 'google_drive',
        clientId: 'id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      driver: 'google_drive',
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it.each([
    ['vacías', ''],
    ['en blanco', '   '],
    ['null', null],
    ['con el marcador ****', '****'],
    ['enmascaradas parcialmente', 'AK****9Z'],
  ])('omite las credenciales %s: el backend conserva las guardadas', (_label, value) => {
    expect(
      flattenStoragePatch({
        s3Bucket: 'bucket',
        s3AccessKey: value,
        s3SecretKey: value,
        googleClientSecret: value,
        onedriveClientSecret: value,
        google: { clientSecret: value },
        onedrive: { clientSecret: value },
        clientSecret: value,
      }),
    ).toEqual({ s3Bucket: 'bucket' });
  });

  it('envía las credenciales nuevas tal cual', () => {
    expect(
      flattenStoragePatch({
        s3AccessKey: 'AKIA-nueva',
        s3SecretKey: 'secreto-nuevo',
        onedriveClientSecret: 'onedrive-nuevo',
      }),
    ).toEqual({
      s3AccessKey: 'AKIA-nueva',
      s3SecretKey: 'secreto-nuevo',
      onedriveClientSecret: 'onedrive-nuevo',
    });
  });

  it('s3ForcePathStyle false se envía (no se confunde con ausente)', () => {
    expect(flattenStoragePatch({ s3ForcePathStyle: false })).toEqual({ s3ForcePathStyle: false });
  });
});
